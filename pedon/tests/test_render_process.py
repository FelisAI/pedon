"""A failed visual review must stop its renderer, not the owner's machine."""
import os
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import render_process as jobs
import photoreal


def test_memory_includes_real_allocations():
    before = jobs.physical_bytes(os.getpid())
    allocation = bytearray(32 * 1024 * 1024)
    after = jobs.physical_bytes(os.getpid())
    assert after - before > len(allocation) / 2


@pytest.mark.parametrize('reason', ['memory', 'disk'])
def test_resource_growth_stops_a_running_child(monkeypatch, tmp_path, reason):
    reads = []
    def memory(pid):
        reads.append(pid)
        return 100 if pid == os.getpid() or reason != 'memory' else 10000
    monkeypatch.setattr(jobs, 'physical_bytes', memory)
    free = iter([jobs.MIN_FREE_DISK * 2, 0 if reason == 'disk' else jobs.MIN_FREE_DISK * 2])
    monkeypatch.setattr(jobs.shutil, 'disk_usage', lambda p: SimpleNamespace(free=next(free)))
    with pytest.raises(RuntimeError, match=reason):
        jobs.run_bounded([sys.executable, '-c', 'import time; time.sleep(5)'],
                         cwd=tmp_path, timeout=1, memory_limit=1000)


def test_deadline_kills_the_worker_and_its_blender_child(tmp_path):
    marker = tmp_path / 'child-finished'
    ready = tmp_path / 'child-started'
    child = f'import time; from pathlib import Path; Path({str(ready)!r}).touch(); time.sleep(1); Path({str(marker)!r}).touch()'
    parent = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{child!r}]); time.sleep(5)'
    with pytest.raises(RuntimeError, match='seconds'):
        jobs.run_bounded([sys.executable, '-c', parent], cwd=tmp_path, timeout=0.5)
    assert ready.exists(), 'the child must start or this test proves nothing'
    time.sleep(1)
    assert not marker.exists(), 'the renderer survived its worker deadline'


def test_completed_output_is_returned(tmp_path):
    out = jobs.run_bounded([sys.executable, '-c', 'print("pixels")'], cwd=tmp_path, timeout=3)
    assert out.returncode == 0 and out.stdout == 'pixels\n'


def test_memory_failure_preserves_phase_samples_and_over_limit_peak(tmp_path):
    report = tmp_path / 'memory.json'
    child = f'''
import sys,time
sys.path.insert(0, {str(Path(jobs.__file__).parent)!r})
from render_process import phase
# Different Python builds on macOS can have different monotonic origins.
time.monotonic = lambda: -100000000
phase('allocate_geometry', triangles=100)
memory = bytearray(128 * 1024 * 1024)
time.sleep(5)
'''
    with pytest.raises(RuntimeError, match='memory'):
        jobs.run_bounded([sys.executable, '-c', child], cwd=tmp_path, timeout=4,
                         memory_limit=64 * 1024 * 1024, profile_path=report)
    result = json.loads(report.read_text())
    assert result['returncode'] != 0
    assert 'memory' in result['stopped']
    assert result['peak_memory_bytes'] > result['memory_limit_bytes']
    assert max(row['physical_bytes'] for row in result['samples']) == result['peak_memory_bytes']
    assert result['phases'][0]['phase'] == 'allocate_geometry'
    assert result['phases'][0]['triangles'] == 100
    assert result['phases'][0]['physical_bytes'] > 0
    assert 0 <= result['phases'][0]['t_s'] < result['samples'][-1]['t_s']


def test_success_also_writes_profile_without_corrupting_output(tmp_path):
    report = tmp_path / 'memory.json'
    result = jobs.run_bounded([sys.executable, '-c', 'print("rendered")'],
                             cwd=tmp_path, timeout=3, profile_path=report)
    assert result.stdout == 'rendered\n'
    profile = json.loads(report.read_text())
    assert profile['returncode'] == 0 and profile['stopped'] is None
    assert profile['samples']


def test_low_disk_refuses_before_starting(monkeypatch, tmp_path):
    monkeypatch.setattr(jobs.shutil, 'disk_usage', lambda p: SimpleNamespace(free=0))
    monkeypatch.setattr(jobs.subprocess, 'Popen', lambda *a, **k: pytest.fail('started with full disk'))
    with pytest.raises(RuntimeError, match='free disk'):
        jobs.run_bounded(['unused'], cwd=tmp_path, timeout=3)


def test_render_lock_prevents_overlapping_exports(monkeypatch, tmp_path, capsys):
    import fcntl
    monkeypatch.setattr(photoreal, 'OUT_DIR', str(tmp_path))
    monkeypatch.setattr(photoreal, '_main', lambda *args: pytest.fail('overlapping export'))
    with (tmp_path / '.render.lock').open('a') as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert photoreal.main([]) == 1
    assert 'already running' in capsys.readouterr().out


def test_import_probe_shares_the_render_job_slot(monkeypatch, tmp_path):
    from render_profile import probe_import
    monkeypatch.setattr(photoreal, 'OUT_DIR', str(tmp_path))
    monkeypatch.setattr(jobs, 'run_bounded', lambda *a, **k: pytest.fail('overlapping probe'))
    with jobs.render_slot(tmp_path), pytest.raises(jobs.RenderBusy, match='already running'):
        probe_import('unused.glb', realize=False, profile_path=tmp_path / 'profile.json')


def test_worker_deadline_runs_snapshot_cleanup(tmp_path):
    snapshot = tmp_path / 'snapshot.glb'
    started = tmp_path / 'started'
    worker = f'''
import sys,time
from pathlib import Path
sys.path.insert(0, {str(Path(photoreal.__file__).parent)!r})
import photoreal
photoreal.OUT_DIR = {str(tmp_path)!r}
def work(argv, cleanup):
    p=Path({str(snapshot)!r});p.touch()
    Path({str(started)!r}).touch()
    cleanup.callback(p.unlink)
    time.sleep(5)
photoreal._main=work
photoreal.main([])
'''
    with pytest.raises(RuntimeError, match='seconds'):
        jobs.run_bounded([sys.executable, '-c', worker], cwd=tmp_path, timeout=0.5)
    assert started.exists(), 'the worker must start before its cleanup can be tested'
    assert not snapshot.exists(), 'the deadline left a potentially gigabyte-sized export behind'
