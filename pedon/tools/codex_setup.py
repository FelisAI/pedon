"""Write the Codex settings that give a Codex session in this repository PEDON's site tools.

Claude Code reads `.mcp.json`; Codex does not, and reads a project's own `.codex/config.toml`
only once the user has trusted the folder (Codex asks the first time it opens one). This writes
that file, at the repository root, from the same adapter agent.py hands the design agent
(agent.codex_mcp_args), so the two cannot describe different servers.

The file is committed, so it names no path on this machine: Codex resolves a relative server
folder against wherever it was started, so the server is started by a command that walks up from
there to the checkout. It is not `required` — a session in this repository still opens when the
site tools cannot start.

    python3 tools/codex_setup.py --write     # after changing .mcp.json or the tool list
    python3 tools/codex_setup.py --check     # the committed file is current (the tests run this)
"""
from __future__ import annotations

import argparse
import json
import shlex
from pathlib import Path

import agent

MCP = Path(agent.ROOT) / ".mcp.json"
PATH = Path(agent.ROOT).parent / ".codex" / "config.toml"
HEADER = ("# Written by pedon/tools/codex_setup.py from pedon/.mcp.json: change that, then run\n"
          "# `python3 pedon/tools/codex_setup.py --write`. Codex reads this file only in a folder you\n"
          "# have trusted.\n")
# up from the folder Codex was started in to the one holding the app, then the server as
# .mcp.json runs it
FIND_APP = ('d=$PWD; until [ -f "$d/pedon/.mcp.json" ] || [ "$d" = / ]; do d=${d%/*}; d=${d:-/}; done; '
            'cd "$d/pedon" && exec ')


def config_text():
    servers = json.loads(MCP.read_text()).get("mcpServers") or {}
    overrides = agent.codex_mcp_args(str(MCP))
    if not servers or not overrides:
        raise ValueError("pedon/.mcp.json is missing or invalid")
    lines = []
    for name, spec in servers.items():
        own = f"mcp_servers.{name}."
        run = shlex.join([spec["command"], *(spec.get("args") or [])])
        lines += [f'{own}command="sh"', f"{own}args={json.dumps(['-c', FIND_APP + run])}"]
        # the adapter's own path and startup rule are for one run on this machine; the rest
        # (tools, approvals, timeout, environment) is the same for every session
        lines += [kv for kv in overrides[1::2]
                  if kv.startswith(own) and kv.split("=", 1)[0][len(own):] not in ("command", "args", "cwd", "required")]
    return HEADER + "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--print", action="store_true", dest="show")
    args = ap.parse_args(argv)
    text = config_text()
    if args.show:
        print(text, end="")
        return 0
    if args.check:
        if not PATH.exists() or PATH.read_text() != text:
            print(f"{PATH} is not what pedon/.mcp.json and the tool list give; "
                  "run python3 pedon/tools/codex_setup.py --write")
            return 1
        print(f"{PATH} matches pedon/.mcp.json")
        return 0
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(text)
    print(f"wrote {PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
