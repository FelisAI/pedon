# PEDON extensions

Every feature is a module that CONTRIBUTES to registries, rather than a branch
inside a function that already knows about it. This file is the contract. Read it
before adding a feature, and add to it when a new extension point is needed.

It exists for two reasons: to make the system itself better, and to let external
contributors add features to the tool. The first is the one that pays immediately —
without registries there is nowhere to put a feature but `main.js`, which is why it
runs to thousands of lines.

## The registries are existing lists, made uniform

Nothing here is a new idea for this codebase. It is five existing lists made
uniform:

| registry | hand-maintained form |
| --- | --- |
| garden objects | `objects.js BUILDERS`, read back by `objectCatalog()` |
| agent tools | `view_mcp.py TOOLS`, a hand-written list |
| design ops | an `if/elif` chain in `agent.execute()` |
| site queries | `site_api.py` subcommands, one per question |
| property editors | one `renderProperties()` switch on kind |

That last row is the cost of a switch: a kind with no case has no inspector at all —
and without a `plant` case, most of a planted design has none. As a registry that is
a missing module, and visible. As a switch statement it is invisible.

## TWO THINGS ARE NOT PLUGGABLE

Both follow from the project's core rules. They are the reason an extension system
here is safe rather than a way to lose the guarantees.

**1. There is ONE write path, and an extension does not get the filesystem.**
Every change reaches disk through `POST /api/ops` → `agent.execute()` +
`validate()` — the same path a model op and a hand drag take. An
extension is handed `ctx.ops.apply(...)` and has no file access at all. An
extension that could write `design.json` would reintroduce exactly the floating and
off-scan geometry the validators exist to catch.

**2. An extension may add WARNINGS. It may not add a hard rejection.**
Every hard rejection in `validate()` is measured ground, building code or physically unplantable; none
is about style, palette or ratio, because the library must never cap the design.
A third party who could add a rejection could make the tool refuse
a garden it merely disagreed with. `@rule` therefore takes `severity="warn"` and
core is the only writer of `severity="error"`.

Those two sentences are also the whole permission model. The project's existing
rules produce it; nothing needed inventing.

## THE CAPABILITY OBJECT IS THE SANDBOX BOUNDARY

Extensions load from disk as trusted modules today. They are written against `ctx`,
a capability object that hands over only what the manifest asked for:

```js
export default {
  id: "dev.pedon.plant-inspector",
  version: "1.0.0",
  permissions: ["ops:write", "design:read", "assets:read"],
  contributes: { inspectors: [{ forKind: "plant" }] },
  activate(ctx) { /* ctx has exactly those three capabilities and nothing else */ },
}
```

This is the design decision that makes "trusted now, sandboxed later" additive
rather than a rewrite: **every capability is already a message-shaped call on an
object the host constructs.** Moving that object across a Worker port, or a
subprocess boundary on the Python side, changes the host and not one extension. An
extension that reached for `document` or `fs` directly would be the thing that made
sandboxing impossible later, so the review rule is: an extension imports nothing
from the app, and receives everything.

## Extension points

| point | side | contributes |
| --- | --- | --- |
| `tools` | JS | an entry in the dock: an icon, a mode, a cursor |
| `commands` | JS | an entry in the ⌘K palette, optionally a key binding |
| `inspectors` | JS | the panel shown when an object of `forKind` is selected |
| `overlays` | JS | something drawn over the canvas while active |
| `objects` | JS | a garden object builder (the existing `BUILDERS` registry) |
| `ops` | PY | a verb in the design vocabulary, with its JSON schema |
| `rules` | PY | a validator that yields WARNINGS |
| `queries` | PY | a question about the site, answerable by CLI and by MCP |

`ops` and `queries` are declared once and the agent's MCP tool list is DERIVED from
them, so a new verb cannot exist without the design agent being able to see it —
the failure mode `known_kinds()` catches, generalised.

## The two runtimes, and what joins them

The viewer is JavaScript; the validators, ops and site queries are Python. An
extension may have both halves, and they are joined by the op vocabulary, which is
already JSON Schema. A `manifest.json` beside the code names both:

```
extensions/
  plant-inspector/
    manifest.json      id, version, permissions, contributes
    ui.js              the JS half — receives ctx, returns nothing
    rules.py           the PY half — warnings only
    test/              its own tests; selftest discovers them
```

## What the shell actually consumes today

Not aspirational — these are live:

| point | consumed by | status |
| --- | --- | --- |
| `inspectors` | `renderProperties`, checked BEFORE the built-in table | live — the plant inspector edits position and planning size |
| `tools` | `shell/dock.js`, which is built from the registry not markup | live |
| `commands` | `shell/commands.js`, same list as the built-ins | live |
| `objects` | `objects.js BUILDERS` | existing registry, not yet manifest-driven |
| `overlays` | — | declared, no consumer yet |

The registry is consulted **before** the built-in table for inspectors, which is
deliberate: it is what lets an extension own a kind, and it is the difference
between a plugin system and a plugin menu. Extension commands land in the same
palette as built-ins for the same reason.

## Rules for writing one

- **Import nothing from the app.** Everything arrives on `ctx`. This is what keeps
  the sandbox boundary real and the API reviewable.
- **Never write a file.** `ctx.ops.apply(ops, "what the user did")` or nothing.
- **View state may persist; design state may not.** `ctx.storage` is a namespaced
  slice of localStorage for view preferences — the rule per-object visibility
  already follows. A design fact belongs in an op.
- **Ship tests.** `selftest.py` discovers `extensions/*/test/`. A feature with no
  test can fail on every single call and nobody will know.
- **Declare the minimum permissions.** The host hands over exactly what is asked
  for, so an over-broad manifest is the review signal.
