"""One client for the viewer's render broker.

Rendering and raycasting can only happen in the browser — WebGL and the loaded
scan mesh live there — so four separate tools POST to the same dev-server
endpoint. Four separate transcriptions drift in exactly the way that matters: one
that does not catch URLError and say how to start the viewer hands the user a
traceback — and analyze_site.fetch_scan_grid is the caller most likely to meet a
closed viewer, because it is the first command run when onboarding a property.

So: one implementation, and the failure message lives with it.

Callers differ in what they do about a dead viewer — a CLI should exit with the
instructions, an MCP server must NOT exit because that kills the server for the
rest of the session. So this raises ViewerDown and lets each translate it.
"""
from __future__ import annotations
import json
import os
import urllib.error
import urllib.request

VIEWER = os.environ.get("YARDTWIN_VIEWER", "http://localhost:5178")


class ViewerDown(RuntimeError):
    """The viewer is not reachable. str() is a message safe to show a human."""


class BrokerRefused(RuntimeError):
    """The viewer answered, but could not do it (no capture loaded, bad subject)."""


def _how_to_start(reason):
    return (f"the viewer is not reachable at {VIEWER} ({reason}).\n"
            f"  1. cd viewer && npm run dev\n"
            f"  2. open {VIEWER} and load a capture\n"
            f"  3. keep the tab in the FOREGROUND — a background tab is throttled "
            f"and the request will time out")


def call(payload, timeout=60):
    """POST one op to the broker. Returns the parsed reply, or raises."""
    req = urllib.request.Request(
        VIEWER + "/api/view/request", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Origin": VIEWER})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read().decode())
    except urllib.error.URLError as e:
        raise ViewerDown(_how_to_start(e.reason)) from e
    except TimeoutError as e:
        raise ViewerDown(_how_to_start("timed out — is the tab in the background?")) from e
    if not out.get("ok"):
        raise BrokerRefused(f"{out.get('error')} {out.get('detail', '')}".strip())
    return out


def data(payload, timeout=60):
    """The `data` half of a reply, for the ops that compute rather than render."""
    return call(payload, timeout)["data"]
