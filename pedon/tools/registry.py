#!/usr/bin/env python3
"""The PYTHON half of the extension contract: ops, rules and queries.

Every feature is a plugin/extension, for two reasons: it makes the system itself
better, and it lets external contributors add features to the tool.

`EXTENSIONS.md` names eight extension points. Five are JavaScript and
`viewer/src/extensions.js` hosts them. Three are Python — `ops`, `rules`,
`queries` — and this is where they live.

WHAT THIS IS AND IS NOT
-----------------------
It is a REGISTRY, not a rewrite of the write path. `agent.execute()` stays the
single place an op is applied and `validate()` stays the single place a design is
judged; there is one write path in this project on purpose and turning it
into a dispatch table would be the riskiest possible way to make it modular.

What it removes is vocabularies HAND-MAINTAINED IN PARALLEL, which is the
`known_kinds()` failure generalised: a builder inserted at the wrong indent parses,
renders and resolves while `known_kinds()` cannot see it, so the asset is buildable
by the viewer and invisible to `wants.py` and the design agent. The same shape here:

  * `execute()`'s `name == "..."` branches and `OPS_SCHEMA`'s enum are two lists
    of the same verbs. An op implemented but left out of the enum is rejected
    before it runs; an op in the enum with no branch raises a bare "unknown op"
    at apply time.
  * the tools `view_mcp` serves and the names the design agent is allowed are two
    lists of the same queries. Nothing makes hand-kept lists agree, and a query
    the design agent is never OFFERED is a query that does not exist as far as
    designing goes.

So: one declaration per verb, and `tests/test_registry.py` fails if the
implementation and the declaration disagree. An extension registers into the same
tables as a built-in — that is the difference between a plugin system and a
plugin menu, and it is the same decision `extensions.js` makes by consulting the
registry BEFORE the built-in inspector table.
"""
from __future__ import annotations
import importlib
import sys
from dataclasses import dataclass, field
from typing import Callable, Optional

CORE = "core"


@dataclass(frozen=True)
class Op:
    """A verb in the design vocabulary."""
    name: str
    schema: dict = field(default_factory=dict)
    extension: str = CORE
    summary: str = ""


@dataclass(frozen=True)
class Rule:
    """A validator. Extensions may only WARN.

    This is not negotiable: every hard rejection in `validate()` is measured
    ground, building code or physically unplantable, and none is about style,
    palette or ratio. A contributed rule that could REJECT would let a third
    party's taste cap the owner's design, which is exactly what the rule that the
    library never caps the design forbids.
    """
    name: str
    severity: str = "warn"
    extension: str = CORE
    summary: str = ""
    fn: Optional[Callable] = None


@dataclass(frozen=True)
class Query:
    """A question about the site, answerable by CLI and by MCP."""
    name: str
    summary: str = ""
    extension: str = CORE
    drawing: bool = False          # does it need a live WebGL context?


OPS: dict[str, Op] = {}
RULES: dict[str, Rule] = {}
QUERIES: dict[str, Query] = {}


def register_op(name, schema=None, extension=CORE, summary=""):
    if name in OPS and OPS[name].extension != extension:
        raise ValueError(
            f"op {name!r} is already registered by {OPS[name].extension!r}. "
            "Two owners for one verb can leave a flight of steps undeletable "
            " — pick another name.")
    OPS[name] = Op(name, schema or {}, extension, summary)
    return OPS[name]


def register_rule(name, severity="warn", extension=CORE, summary="", fn=None):
    if extension != CORE and severity != "warn":
        raise ValueError(
            f"rule {name!r} from {extension!r} asked for severity {severity!r}. "
            "An extension may only WARN: every hard rejection in this project is "
            "measured ground or building code, and a contributed rule that "
            "could reject would let somebody else's taste cap the owner's design.")
    RULES[name] = Rule(name, severity, extension, summary, fn)
    return RULES[name]


def register_query(name, summary="", extension=CORE, drawing=False):
    QUERIES[name] = Query(name, summary, extension, drawing)
    return QUERIES[name]


def rule(name, severity="warn", extension=CORE, summary=""):
    """Decorator form, for a rule that is a function."""
    def wrap(fn):
        register_rule(name, severity, extension, summary or (fn.__doc__ or "").strip(), fn)
        return fn
    return wrap


def reset(extension=None):
    """Drop registrations. For tests; an extension host would use it on unload."""
    for table in (OPS, RULES, QUERIES):
        for k in [k for k, v in table.items() if extension in (None, v.extension)]:
            del table[k]


# ── what the core contributes, declared from the implementations ──────────────
#
# Read OFF `agent` and `view_mcp` rather than typed again here. A third hand-kept
# list would be the very duplication this file exists to remove.

def load_core():
    """Register everything the built-in system provides. Idempotent."""
    reset(CORE)
    agent = importlib.import_module("agent")
    for name in sorted(_schema_op_names(agent)):
        register_op(name, schema=_schema_for(agent, name), summary=_op_summary(agent, name))
    try:
        view_mcp = importlib.import_module("view_mcp")
    except Exception:                      # noqa: BLE001 — a broken viewer half
        return                             # must not take the op vocabulary down
    for spec in list(view_mcp.TOOLS) + list(view_mcp.SITE_TOOLS):
        register_query(spec["name"], (spec.get("description") or "").strip()[:200],
                       drawing=spec["name"] in ("look", "walk_through", "preview_design"))


def _schema_op_names(agent) -> set:
    """The ops the schema DECLARES — the enum the design agent is handed."""
    try:
        return set(agent.OPS_SCHEMA["properties"]["ops"]["items"]
                   ["properties"]["tool"]["enum"])
    except Exception:
        # the schema is nested and may move; find the enum wherever it is
        found = set()

        def walk(node):
            if isinstance(node, dict):
                if "enum" in node and isinstance(node["enum"], list):
                    found.update(str(x) for x in node["enum"])
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)
        walk(agent.OPS_SCHEMA)
        return found


def _schema_for(agent, name) -> dict:
    """The input schema for one op, if the document carries one per verb."""
    def walk(node):
        if isinstance(node, dict):
            if node.get("title") == name or node.get("const") == name:
                return node
            for v in node.values():
                got = walk(v)
                if got:
                    return got
        elif isinstance(node, list):
            for v in node:
                got = walk(v)
                if got:
                    return got
        return None
    return walk(agent.OPS_SCHEMA) or {}


def _op_summary(agent, name) -> str:
    return ""


def implemented_op_names() -> set:
    """The ops `execute()` actually HAS A BRANCH FOR.

    Read off the source, because that is the artefact that decides what happens —
    the same reason `objects_index.py` reads objects.js rather than trusting a
    list beside it, and `tests/test_wants.py` cross-checks its answer against node
    actually running the file.
    """
    import inspect
    import re
    agent = importlib.import_module("agent")
    body = inspect.getsource(agent.execute)
    return set(re.findall(r'name == "(\w+)"', body))


def mcp_tool_names(prefix="mcp__yardeye__") -> list:
    """Every query the design agent should be OFFERED.

    DERIVED, not hand-listed beside the tools `view_mcp` serves: a query the agent
    is never offered is a query that does not exist as far as designing goes, and
    two hand-kept lists drift apart.
    """
    if not QUERIES:
        load_core()
    return sorted(prefix + q for q in QUERIES)


def summary() -> dict:
    if not (OPS or QUERIES):
        load_core()
    return {
        "ops": {k: v.extension for k, v in sorted(OPS.items())},
        "rules": {k: f"{v.extension}:{v.severity}" for k, v in sorted(RULES.items())},
        "queries": {k: v.extension for k, v in sorted(QUERIES.items())},
        "extensions": sorted({v.extension for t in (OPS, RULES, QUERIES)
                              for v in t.values()}),
    }


if __name__ == "__main__":
    import json
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    load_core()
    print(json.dumps(summary(), indent=1))
