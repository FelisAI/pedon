"""Run local renders with a deadline and room left for the rest of the machine."""
import ctypes
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

GIB = 1024 ** 3
MAX_RENDER_MEMORY = 8 * GIB
MIN_FREE_DISK = 8 * GIB


class RenderBusy(RuntimeError):
    pass


@contextmanager
def render_slot(directory):
    """The render and diagnostic probes share one job slot per property."""
    Path(directory).mkdir(parents=True, exist_ok=True)
    with (Path(directory) / '.render.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RenderBusy('A photoreal render is already running; wait for it to finish') from error
        yield


def phase(name, **facts):
    """A measured boundary inside Blender, paired with the outer sampler."""
    # Blender and the system Python can use different monotonic clock origins
    # on macOS. Unix time aligns boundaries across those runtimes; deadlines
    # and sampled durations still use the monitor's monotonic clock.
    print('[render-phase] ' + json.dumps({'phase': name, 'unix_s': time.time(),
                                         'physical_bytes': physical_bytes(os.getpid()), **facts}), flush=True)


def physical_bytes(pid):
    # macOS RSS omits compressed memory. proc_pid_rusage's physical footprint
    # includes it; layout is rusage_info_v0 in the platform's sys/resource.h.
    if sys.platform == "darwin":
        class Usage(ctypes.Structure):
            _fields_ = [("uuid", ctypes.c_uint8 * 16), ("values", ctypes.c_uint64 * 10)]
        usage = Usage()
        lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        if lib.proc_pid_rusage(pid, 0, ctypes.byref(usage)) != 0:
            raise OSError(ctypes.get_errno(), "Cannot measure render memory")
        return usage.values[7]
    if sys.platform.startswith("linux"):
        with open(f"/proc/{pid}/status") as f:
            rows = [line.split() for line in f]
        return sum(int(row[1]) * 1024 for row in rows if row[0] in ("VmRSS:", "VmSwap:"))
    raise RuntimeError("Render memory measurement is unavailable on this platform")


def run_bounded(argv, *, cwd, timeout, memory_limit=MAX_RENDER_MEMORY,
                new_session=True, profile_path=None):
    """Kill only this job on limits, cancellation or errors, including its children.

    The outer MCP worker owns a process group; its Blender child shares that
    group so a killed worker cannot leave a detached render consuming memory.
    Output goes to files, avoiding a full pipe blocking the monitor.
    """
    if shutil.disk_usage(cwd).free < MIN_FREE_DISK:
        raise RuntimeError("Render refused: less than 8 GiB of free disk remains")
    if memory_limit is not None:
        physical_bytes(os.getpid())  # refuse before launching if the monitor cannot work
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        proc = subprocess.Popen(argv, cwd=cwd, stdout=stdout, stderr=stderr,
                                start_new_session=new_session)
        started = time.monotonic()
        started_unix = time.time()
        peak = 0
        samples = []
        stopped = None
        try:
            while proc.poll() is None:
                if time.monotonic() - started > timeout:
                    raise RuntimeError(f"Render stopped: exceeded {timeout:.0f} seconds")
                free_disk = shutil.disk_usage(cwd).free
                if free_disk < MIN_FREE_DISK:
                    raise RuntimeError("Render stopped: keeping 8 GiB of disk free")
                try:
                    used = physical_bytes(proc.pid) if memory_limit is not None else 0
                except (OSError, ProcessLookupError):
                    if proc.poll() is not None:
                        break
                    raise
                peak = max(peak, used)
                if profile_path:
                    samples.append({'t_s': round(time.monotonic() - started, 3),
                                    'physical_bytes': used, 'free_disk_bytes': free_disk})
                if used > (memory_limit or float("inf")):
                    raise RuntimeError(f"Render stopped: exceeded {memory_limit / GIB:g} GiB of memory")
                try:
                    proc.wait(timeout=0.05)
                except subprocess.TimeoutExpired:
                    pass
        except (RuntimeError, OSError) as error:
            stopped = str(error)
            end = os.fstat(stdout.fileno()).st_size
            detail = os.pread(stdout.fileno(), 1200, max(0, end - 1200)).decode(errors="replace").strip()
            raise RuntimeError(f"{error}\nLast render output:\n{detail}") from error
        finally:
            if new_session:
                # Give the worker's finally blocks time to remove its snapshot,
                # then reap even a grandchild that ignored termination.
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            elif proc.poll() is None:
                proc.kill()
            proc.wait()
            if profile_path:
                # pread does not change the descriptor offset shared with the
                # child's stdout. Keep evidence even when the guard killed it.
                output = os.pread(stdout.fileno(), os.fstat(stdout.fileno()).st_size, 0).decode(errors='replace')
                phases = []
                for line in output.splitlines():
                    if line.startswith('[render-phase] '):
                        row = json.loads(line[len('[render-phase] '):])
                        row['t_s'] = round(row.pop('unix_s') - started_unix, 3)
                        peak = max(peak, row['physical_bytes'])
                        phases.append(row)
                report = {'pid': proc.pid, 'elapsed_s': round(time.monotonic() - started, 3),
                          'returncode': proc.returncode, 'stopped': stopped,
                          'peak_memory_bytes': peak, 'memory_limit_bytes': memory_limit,
                          'minimum_free_disk_bytes': MIN_FREE_DISK, 'timeout_s': timeout,
                          'scope': 'Monitored process physical footprint only; excludes browser and other processes.',
                          'phases': phases, 'samples': samples, 'last_output': output[-4000:]}
                destination = Path(profile_path)
                destination.parent.mkdir(parents=True, exist_ok=True)
                temporary = destination.with_suffix(destination.suffix + '.tmp')
                temporary.write_text(json.dumps(report, indent=2) + '\n')
                temporary.replace(destination)
        stdout.seek(0); stderr.seek(0)
        result = subprocess.CompletedProcess(argv, proc.returncode,
            stdout.read().decode(errors="replace"), stderr.read().decode(errors="replace"))
        result.peak_memory_bytes = peak
        return result
