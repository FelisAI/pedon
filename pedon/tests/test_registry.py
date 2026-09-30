"""The PYTHON half of the extension contract, and the drift it exists to stop.

The system is modular: every feature is a plugin, an extension of the core.

EXTENSIONS.md names three Python extension points — ops, rules, queries — and
says the design agent's MCP tool list is DERIVED from them, "so a new verb cannot
exist without the design agent being able to see it: the failure mode
`known_kinds()` was written to catch, generalised."

That failure is worth restating, because every assertion here is a version of it.
A garden-object builder inserted at the wrong indent PARSES, RENDERS and
RESOLVES, while `known_kinds()` — which reads `^\\s{2}(\\w+):` — cannot see it.
So the asset is buildable by the viewer and invisible to `wants.py` and to the
design agent. The thing works and nothing knows about it.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import registry  # noqa: E402
import agent  # noqa: E402


def setup_function(_):
    registry.load_core()


def test_every_op_the_schema_offers_is_one_execute_can_actually_apply():
    """execute()'s `name == "..."` branches and the schema's enum, compared.

    An op in the enum with no branch raises a bare "unknown op" at apply time; an
    op with a branch but no enum entry is rejected before it runs. Both are silent
    until somebody tries it.
    """
    declared = set(registry.OPS)
    implemented = registry.implemented_op_names()
    assert declared, "the registry found no ops at all — the parse is broken"
    assert implemented, "execute() has no branches — the parse is broken"
    assert declared == implemented, (
        f"declared but not implemented: {sorted(declared - implemented)}; "
        f"implemented but not declared: {sorted(implemented - declared)}")


def test_every_tool_the_server_SERVES_is_a_tool_the_design_agent_is_OFFERED():
    """A query the agent is never offered is a query that does not exist.

    A list hand-typed in agent.py beside the one view_mcp serves drifts from it.
    """
    import view_mcp
    served = {t["name"] for t in view_mcp.TOOLS} | {s["name"] for s in view_mcp.SITE_TOOLS}
    offered = {t.replace("mcp__yardeye__", "") for t in agent.MCP_TOOLS}
    assert served == offered, (
        f"served but never offered: {sorted(served - offered)}; "
        f"offered but not served: {sorted(offered - served)}")
    assert len(served) > 15, f"only {len(served)} tools parsed; the read is broken"


def test_the_agents_list_is_DERIVED_and_its_fallback_cannot_rot():
    """The fallback exists so a broken view_mcp does not take the design runner
    down — the same reason view_mcp guards its own site_api import. It must never
    become a second opinion."""
    src = open(os.path.join(ROOT, "tools", "agent.py")).read()
    assert "registry.mcp_tool_names()" in src or "_registry.mcp_tool_names()" in src, \
        "agent.py hand-lists the MCP tools again"
    fallback = {"mcp__yardeye__" + t for t in agent._MCP_FALLBACK}
    assert fallback == set(registry.mcp_tool_names()), (
        "the hand-written fallback has drifted from what is really served: "
        f"{sorted(fallback ^ set(registry.mcp_tool_names()))}")


def test_an_extension_registers_into_the_SAME_tables_as_a_built_in():
    """The difference between a plugin system and a plugin menu.

    `extensions.js` makes the same decision by consulting the registry BEFORE the
    built-in inspector table — it is what lets an extension own a kind.
    """
    registry.register_query("shade_hours", "how long a spot is shaded", extension="sunlab")
    assert "shade_hours" in registry.QUERIES
    assert registry.QUERIES["shade_hours"].extension == "sunlab"
    assert "mcp__yardeye__shade_hours" in registry.mcp_tool_names(), \
        "an extension's query is not offered to the design agent, so it does not exist"
    assert "sunlab" in registry.summary()["extensions"]
    registry.reset("sunlab")
    assert "shade_hours" not in registry.QUERIES


def test_an_extension_may_only_WARN():
    """Not negotiable.

    Every hard rejection in validate() is measured ground, building code or unplantable;
    none is about style, palette or ratio. A contributed rule that could REJECT
    would let somebody else's taste cap the owner's design, which is exactly what
    "the library must never cap the design" forbids.
    """
    registry.register_rule("leggy", extension="critic", summary="reports legginess")
    assert registry.RULES["leggy"].severity == "warn"
    try:
        registry.register_rule("too_pink", severity="error", extension="critic")
    except ValueError as e:
        assert "only WARN" in str(e)
    else:
        raise AssertionError("an extension was allowed to register a hard rejection")
    # the CORE may reject, because those rejections are measured ground
    registry.register_rule("wall_setback", severity="error")
    assert registry.RULES["wall_setback"].severity == "error"
    registry.reset("critic")
    registry.load_core()


def test_two_extensions_cannot_own_one_verb():
    """Two owners for one thing is how a flight of steps becomes undeletable."""
    registry.register_op("set_pond", extension="ponds")
    try:
        registry.register_op("set_pond", extension="lakes")
    except ValueError as e:
        assert "already registered" in str(e)
    else:
        raise AssertionError("two extensions both own set_pond")
    # re-registering from the SAME extension is a reload, not a collision
    registry.register_op("set_pond", extension="ponds")
    registry.reset("ponds")


def test_a_broken_viewer_half_does_not_take_the_op_vocabulary_down():
    """view_mcp guards its own site_api import for this reason; the registry
    inherits the rule. Losing `look` is bad; losing the ability to apply an op is
    the design runner not running at all."""
    import importlib
    real = sys.modules.get("view_mcp")
    sys.modules["view_mcp"] = None          # an import of it now raises
    try:
        importlib.reload(registry)
        registry.load_core()
        assert registry.OPS, "a broken view_mcp took the op vocabulary with it"
        assert not registry.QUERIES, "queries survived a view_mcp that cannot load"
    finally:
        if real is not None:
            sys.modules["view_mcp"] = real
        else:
            del sys.modules["view_mcp"]
        importlib.reload(registry)
        registry.load_core()
    assert registry.QUERIES, "the registry did not recover"


def test_the_summary_is_the_thing_a_contributor_reads():
    s = registry.summary()
    assert set(s) == {"ops", "rules", "queries", "extensions"}
    assert s["ops"]["place_plants"] == "core"
    assert s["queries"]["ground"] == "core"
