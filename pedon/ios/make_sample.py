#!/usr/bin/env python3
"""THE SAMPLE GARDEN the app carries, so anyone can try it without a Mac — App Review included.

The demo site (tools/demo_site.py) is made by code: house walls, a patio, a fence with a gate,
boulders and a starter planting. This exports it the way the Mac exports any design for the
phone (tools/ar_export.py), through a private viewer and a throwaway headless Chrome that never
touch the user's sites, and writes the three files the app reads into ios/PedonAR/Sample/:

    current.json        what the Mac's current.json would say (name, size, metadata)
    yard.usdz           the design
    yard-*.scan.usdz    its original scan

The folder is generated and not part of the source (the app ships no assets); a build without
it simply has no "Try the sample garden".

    python3 ios/make_sample.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "ios", "PedonAR", "Sample")
CHROME = os.environ.get("PEDON_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(url, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return
        except Exception:
            time.sleep(1)
    raise SystemExit(f"[sample] {url} did not answer within {seconds} s")


def main():
    work = tempfile.mkdtemp(prefix="pedon-sample-")
    env = {**os.environ, "PEDON_PROJECTS": os.path.join(work, "projects"), "PEDON_PROJECT": "demo-garden"}
    os.makedirs(env["PEDON_PROJECTS"])
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "demo_site.py")], env=env, check=True,
                   stdout=subprocess.DEVNULL)
    port, debug = free_port(), free_port()
    viewer = subprocess.Popen(["npx", "vite", "--port", str(port), "--strictPort"], cwd=os.path.join(ROOT, "viewer"),
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    browser = None
    try:
        wait_for(f"http://localhost:{port}/", 60)
        browser = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={debug}",
                                    f"--user-data-dir={os.path.join(work, 'chrome')}", "--window-size=1400,1000",
                                    f"http://localhost:{port}/"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        last = None
        for _ in range(12):                      # the page needs a moment to load its scan
            time.sleep(5)
            r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "ar_export.py"), "--name", "Sample garden"],
                               env={**env, "YARDTWIN_VIEWER": f"http://localhost:{port}"}, capture_output=True, text=True)
            if r.returncode == 0:
                break
            last = (r.stdout + r.stderr).strip().splitlines()[-1:] or ["no output"]
        else:
            raise SystemExit(f"[sample] the export did not succeed: {last[0]}")
        ar = os.path.join(env["PEDON_PROJECTS"], "demo-garden", "ar")
        info = json.load(open(os.path.join(ar, "yard.json")))
        shutil.rmtree(OUT, ignore_errors=True)
        os.makedirs(OUT)
        design = os.path.join(ar, "yard.usdz")
        shutil.copy2(design, os.path.join(OUT, "yard.usdz"))
        shutil.copy2(os.path.join(ar, info["scan"]["file"]), os.path.join(OUT, info["scan"]["file"]))
        current = {"name": "yard.usdz", "bytes": os.path.getsize(design), "mtime_ms": info["made_ms"],
                   "info": info, "making": False}
        with open(os.path.join(OUT, "current.json"), "w") as f:
            json.dump(current, f)
        size = sum(os.path.getsize(os.path.join(OUT, n)) for n in os.listdir(OUT))
        print(f"[sample] {OUT}: {info['plants']} plants, {size / 1e6:.1f} MB")
    finally:
        for p in (browser, viewer):
            if p:
                p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
