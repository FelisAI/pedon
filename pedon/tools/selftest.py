"""Run the offline test suite. One command, no viewer, no network.

Why this exists
---------------
The suite runs real code paths on the committed data, including op execution:
testing only the validator and schema leaves the layer between them unchecked.
For example, `set_patio` reserves scarce flat ground, and a local polygon area
must not shadow execute()'s `area` restriction parameter. The entry point lives
in `tools/`, next to the tools it tests, so a session can find it.

    python3 tools/selftest.py              # everything under tests/
    python3 tools/selftest.py -k patio     # any pytest arg passes straight through
    python3 tools/selftest.py -x -q
    YARDTWIN_SELFTEST_BUDGET_S=60 python3 tools/selftest.py   # a slower machine

Deliberately NOT included: frame_check.py and float_check.py. Both need the
viewer open in a foreground tab with a capture loaded, so they cannot run
headless and would turn a green suite into an environment check.

It also holds the suite to a time budget, because running it before and after
every change must remain cheap, and nobody notices a suite creeping from 11 s
to 90 s one test at a time. The budget is enforced HERE
rather than by a test, because a test that runs the suite to time it doubles
the suite — the exact cost it would be policing. This is the moment the real
thing is measured anyway.

The budget is on CPU rather than wall clock: several agents run this suite
concurrently in one tree, and wall clock under that load measures the machine
rather than the suite. Wall clock is still printed, since that is what a human feels.

320 s is deliberately ~1.15x the measured cost at a quiet machine's price
(278 s for 2,396 tests). Fast builds and reduces the photoreal builders:
render_quality's catalogue check accounts for 20 s of that work,
fast_is_full.test.mjs checks one species of each for 9.5 s, and the shoot
plants' Fast tests run the same reduction for 5 s. Running the real builders
for four species adds 5 s across design, palette_renders, plant_fidelity and
render_quality. Pricing (below) holds variation to about 5%, so the margin
allows normal growth while catching a step change such as 30 s of redundant
validation.

Repeated work must be distinguished from useful coverage. For example, calling
validate() once per warning in `check-ops` means 250 validations for an empty
op list on a design with 250 warnings: 15.5 s per test, or 30 s across two tests
in test_apply_ops.py. Avoiding that repetition reduces the measured Python
cost from 71 s to 40 s. Overriding the budget can hide such regressions.

Real plant geometry is expensive for a technical reason: a fuchsia has four
million hairs. A measured run takes 66 s wall clock; its Node half costs 119 s
of CPU, with 77% in fourteen geometry files (plant_fidelity 17 s,
palette_renders 16 s, design 14 s, epilobium 8 s ...). At 0.077 s per test
against a 0.057 s baseline, that cost reflects geometry work rather than waiting.
The 57-path check-route/validate corpus agreement costs 2.4 s and checks real
terrain.

If the budget is exceeded, find out what got slow before raising it: run with
--durations and `node --test` per file first. Keep the budget and its documented
measurements in step (tests/test_hardening_suite_speed.py checks this).

THE BUDGET IS JUDGED AT A QUIET MACHINE'S PRICE. Wall clock measures the
machine, and on a Mac with mixed core types CPU does too: with four performance
and six efficiency cores, the same test file costs 22 s of CPU on the first
and 49.6 s on the second. When something else holds the performance
cores, the suite spills onto the efficiency ones and pays up to 2.2x for
identical work. A fixed loop is timed, inside node, just before and
after each half at that half's concurrency; its cost over QUIET_CAL_S is what the
machine is charging per unit of work right now, and the budget judges the CPU
divided by it. Forced onto efficiency cores the loop reads 2.3x, as real tests do.
Both numbers are printed. A test that got slower still costs more at any price;
only the machine's share comes out.

The suite must run both Python and Node tests. Do not delete useful coverage
to fit the budget. A gate that fires unpredictably encourages reruns instead
of investigation. Four test files cross a process boundary on purpose: the MCP
stdio protocol, the CLI's own argv coercion, site.json ownership at the entry
point, and the call-log redirect. In-process checks provide weaker coverage
of these boundaries. The budget allows the suite to grow while catching step
changes such as a test shelling out, sleeping, or waiting for a network timeout.
A 23.5 s connect timeout is an example of the avoidable cost it must catch.
"""
from __future__ import annotations
import os
import resource
import glob
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests")
# The docstring carries the budget's measurements and reasoning; keep them in
# step with this number. Find out what got slow before raising the budget.
BUDGET_S = float(os.environ.get("YARDTWIN_SELFTEST_BUDGET_S", "320"))


def _child_cpu():
    """CPU seconds burned by children this process has already waited for."""
    r = resource.getrusage(resource.RUSAGE_CHILDREN)
    return r.ru_utime + r.ru_stime


# A fixed amount of work, timed from INSIDE node so its startup is not in the number,
# and what it costs on a free performance core of the Mac it was calibrated on
# (0.226-0.242 s).
CAL_JS = ("const t=process.cpuUsage();let s=0;for(let i=0;i<5e7;i++){s=(s+i*7)%1000003}"
          "const d=process.cpuUsage(t);console.log((d.user+d.system)/1e6)")
QUIET_CAL_S = 0.23


def _price(width):
    """What the machine charges per unit of work right now, `width` loops at once:
    1.0 on free performance cores, ~2.3 on efficiency cores. None if node cannot
    run it, which leaves the CPU unadjusted rather than guessed."""
    try:
        ps = [subprocess.Popen(["node", "-e", CAL_JS], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True) for _ in range(width)]
        got = [float(p.communicate(timeout=60)[0].split()[0]) for p in ps]
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None
    return sum(got) / len(got) / QUIET_CAL_S


def _mean_price(*prices):
    known = [p for p in prices if p]
    return sum(known) / len(known) if known else None


def main(argv):
    try:
        import pytest                                    # noqa: F401
    except ImportError:
        print("pytest is not installed: python3 -m pip install pytest", file=sys.stderr)
        return 2
    if not os.path.isdir(TESTS):
        print(f"no tests directory at {TESTS}", file=sys.stderr)
        return 2
    # -p no:cacheprovider: the suite is read-only on the repo, and a .pytest_cache
    # appearing in the tree is noise.
    cmd = [sys.executable, "-m", "pytest", TESTS, "-p", "no:cacheprovider"] + argv
    print("$ " + " ".join(cmd[1:]), flush=True)
    # each half is priced at its own concurrency, and the pricing loops' own CPU is
    # kept OUT of the suite's: only the two subprocess calls are metered
    wall0 = time.monotonic()
    before = _price(1)
    cpu0 = _child_cpu()
    rc = subprocess.call(cmd, cwd=ROOT)
    py_cpu = _child_cpu() - cpu0
    py_price = _mean_price(before, _price(1))
    node_cpu, node_price = 0.0, None

    # ── and the node half ──────────────────────────────────────────────────
    # Node tests cover the viewer's plant renderer, picker, want list, edging
    # geometry and frame-of-reference guards. Running only pytest leaves these
    # unchecked.
    #
    # `node --test tests/js/` does not work (node reads that as a module path),
    # so the files are passed by name.
    if not argv:
        js = sorted(glob.glob(os.path.join(TESTS, "js", "*.mjs")))
        if not js:
            print("\nno node tests found — viewer/src is UNTESTED by this run", file=sys.stderr)
            rc = rc or 2
        else:
            print(f"\n$ node --test {len(js)} files under tests/js/", flush=True)
            # Geometry suites each build whole gardens. Starting every file at
            # once makes their wall-time guards measure memory/CPU contention.
            # the SAME site the python half read (tests/conftest.py): the reference site,
            # pinned, or an empty project where the tests about a real site skip
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import project
            site = project.test_site()
            # a COPY of the site, never the site: its owner may be in the viewer
            env = dict(os.environ, PEDON_PROJECT=project.snapshot(site) if site else project.empty_project())
            print(f"  site: {site or 'none — an empty project; tests about a real site skip'}", flush=True)
            # and the LIBRARY's own tests — its species builders': the user's code, run
            # against this app. Their static imports of the app (`@pedon/…`) need the resolve
            # hooks registered before any file loads, hence --import for the whole run.
            lib = sorted(glob.glob(os.path.join(project.library(project.LAYOUT["species_dir"]),
                                                "tests", "*.test.mjs")))
            print(f"  library: {len(lib)} species test files in {project.LIBRARY}", flush=True)
            hooks = os.path.join(ROOT, "viewer", "species_register.mjs")
            before = _price(4)
            # the viewer's wall-clock guards judge time on THIS machine as on a quiet one: a slow
            # or busy machine stretches them by what it charges per unit of work (never shrinks)
            env["PEDON_TIMING_SCALE"] = f"{max(1.0, before or 1.0):.2f}"
            cpu0 = _child_cpu()
            jrc = subprocess.call(["node", "--import", hooks, "--test", "--test-concurrency=4", *js, *lib],
                                  cwd=ROOT, env=env)
            node_cpu = _child_cpu() - cpu0
            node_price = _mean_price(before, _price(4))
            rc = rc or jrc
    wall, cpu = time.monotonic() - wall0, py_cpu + node_cpu
    quiet = py_cpu / (py_price or 1.0) + node_cpu / (node_price or 1.0)
    paid = cpu / quiet if quiet else 1.0
    print(f"\nsuite finished in {wall:.1f} s wall, {cpu:.1f} s cpu "
          f"= {quiet:.1f} s at a quiet machine's price (budget {BUDGET_S:g} s cpu)")
    print(f"this run paid {paid:.2f}x per unit of work"
          + (" — the performance cores were busy, and that is not the suite's cost"
             if paid > 1.15 else "")
          + ("" if py_price else " (not measured: node could not run the pricing loop)"))
    # Only when the suite is otherwise GREEN. A failing suite that also ran long
    # has one problem worth reporting, and it is not the clock — saying "over
    # budget" there sends the reader off to optimise a test that is failing.
    if rc == 0 and quiet > BUDGET_S:
        print(f"OVER BUDGET: {quiet:.1f} s of cpu at a quiet machine's price ({cpu:.1f} s "
              f"as run) against a {BUDGET_S:g} s budget. Find it with "
              f"`python3 tools/selftest.py --durations=10`, or raise the "
              f"budget deliberately with YARDTWIN_SELFTEST_BUDGET_S.", file=sys.stderr)
        return 1
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
