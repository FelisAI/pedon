#!/usr/bin/env python3
"""HAVE I LOOKED AT WHAT I CHANGED? — the design agent's gate, for a session designing in
conversation.

The design agent cannot finish a round until every place it added, moved or removed
something sits in the middle of a view it took after the last apply-ops that touched it. This is
the same rule, for a session designing by itself, from the same functions
(agent.changed_places / views_after_last_edit / unseen_changes), so the two cannot drift.

    python3 tools/look_check.py mark                      # note where the call log is now
    #   ... apply-ops, look (tools/view_mcp.py look '{...}'), adjust ...
    python3 tools/look_check.py check --before SNAPSHOT.json --after data/designs/X.json --since N

Exit 0 when every change was looked at; 1 with the places and a camera for each when not.
"""
import argparse
import json
import os
import project  # the active project's files — the ONE owner
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent  # noqa: E402  the ONE owner of the rule

LOG = os.environ.get("YARDTWIN_CALL_LOG") or project.data("site_api_calls.log")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("mark")
    c = sub.add_parser("check")
    c.add_argument("--before", required=True, help="the design as it was when you started")
    c.add_argument("--after", required=True, help="the design as it is now")
    c.add_argument("--since", type=int, required=True, help="the call-log position `mark` printed")
    a = ap.parse_args(argv)
    if a.cmd == "mark":
        print(os.path.getsize(LOG) if os.path.exists(LOG) else 0)
        return 0
    # data/… is the ACTIVE SITE's (DESIGNING.md writes it that way): joined to the checkout it is
    # not found — the site's files are found through project.py, never by joining
    before, after = (json.load(open(project.resolve(p))) for p in (a.before, a.after))
    places = agent.changed_places(before, after)
    events = agent.round_events(LOG, a.since)
    missed = agent.unseen_since_touched(places, events)
    views = [e for e in events if e[0] == "view"]
    print(json.dumps({"changed_places": len(places), "views": len(views),
                      "unseen": [{"at": [x, y], "points": n, "look": agent.look_here(x, y, design=after)} for x, y, n in missed]},
                     indent=1))
    return 1 if missed else 0


if __name__ == "__main__":
    raise SystemExit(main())
