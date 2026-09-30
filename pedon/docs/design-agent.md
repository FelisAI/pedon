# The design agent — generating, and looking at, a design

This is the SPAWNED designer (`tools/agent.py`), which is right for a whole
design from nothing. For everything after that, `DESIGNING.md` — you hold the
pencil yourself.

**The spawned model is the designer; `run()` is only its hands and its checks.** It
applies the model's ops through the validator, makes it look, and hands back failures.
It does not change the design after the model: rearranging plants and deleting walls
are design decisions for the model. Who decides what, for every tool: `docs/tools.md`.
Both backends are told to read `DESIGNING.md` before designing
(`agent.METHOD_POINTER`) — the method lives there, once, for this agent and for a
session designing in conversation alike; put a design lesson THERE, not in agent.py's brief.

## Generating a design
**A run cannot finish without having looked at what it built.** `run()` marks the
call log, and if a run produced geometry and never rendered it, the ops are
discarded and it goes round again with `LOOK_FEEDBACK`. Correct measurements do not
establish design quality; the model must inspect the result visually. This is a
requirement on METHOD, like measuring before building, and `tests/test_must_look.py`
asserts the second-pass brief carries no metric so it cannot drift into a design rule.


```bash
# In a Codex session; select --backend claude when working in Claude instead.
python3 tools/agent.py --backend codex --explore "…"  # queries the site first
python3 tools/agent.py --backend codex "…"            # one-shot (more rejected ops)
python3 tools/agent.py --backend codex --design data/designs/x.json "…"  # a variant
python3 tools/agent.py --backend codex --explore --rounds 2 --call-budget 240 --design … --area … "…"
```
**A whole garden from nothing takes 35-70 minutes** (60-200 tool calls, the look gate
sometimes sending it back once). Each explore call may take
`--timeout-s` (default 3600). Launch it DETACHED — `nohup sh -c '… > run.log 2>&1' & disown` —
because a run tied to your terminal or session dies with it.
A stop says where the work in progress is (`_<name>_scratch.json`).

**A DESIGN FROM SCRATCH starts from an EMPTY FILE, because `--design` READS the
file before it writes it.** Pointing it at a path is not a blank canvas — it
loads what is there and edits it, so a request to design from scratch against
the live file still produces a revision. Write the empty document first
(an empty design validates clean), then hand that path to `--design`:

```bash
cat > data/designs/variant_a.json <<'JSON'
{"version":1,"units":"meters","style":"","notes":"",
 "beds":[],"paths":[],"edges":[],"patios":[],"plants":[],"steps":[],"objects":[],"groups":[]}
JSON
```
**`--rounds` is the flag that decides whether it revises.** Default 1 is one
pass. `--rounds 2` sends the model back to stand in what it built and change it;
3 is an evening. `--call-budget` defaults to 180 and DEGRADES (warnings,
then a nudge to finish) rather than hard-stopping mid-design, so raise it for an
empty site rather than fearing it.
**`float_check.py` takes no `--design` — it measures WHATEVER THE VIEWER HAS
LOADED.** So it runs AFTER you point the viewer at the new file
(`preview_design`, or click it in the Design panel), never before, or it reports
on the previous design and reads as a clean bill of health for one nobody
checked.

`--explore` is the better mode and the default choice. It queries the site before
it writes, so its ops are rarely rejected; a one-shot run carries several rejected
ops per run and can leave orphaned walls.
It is slower (tool round-trips) and needs a longer timeout.

Both backends use the logged-in subscription CLI; no API keys are needed.
The design contract is provider-independent: the same site/MCP vocabulary,
rendered image content and deterministic operation validator serve each adapter.
The caller chooses the provider; rendering never calls an LLM. When working in
a chat session, use that agent to inspect tool results directly. A fresh process
is needed to verify startup/discovery, not to repeat an image inspection. Use
the same provider for that test, and pass `--backend` explicitly when spawning
`agent.py`; its default when the flag is omitted is Claude. Cross-provider comparisons
are separate work, done when asked for, not a default verification step.
**Codex supports the full design workflow**. Use:

```bash
python3 tools/agent.py --backend codex --explore --rounds 2 --design data/designs/NAME.json "…"
```

The same `.mcp.json` supplies both backends' site queries and inline images.
Codex receives a strict version of the shared operation schema, including garden
objects, and nullable optional fields become omissions before validation. Its
shell runs in `workspace-write` (`read-only` for one-shot), with only the known
YardEye tools approved; it does not bypass the sandbox. Unrelated user config
is omitted for these automated runs. Use `--model` to select a model explicitly.
The capability map (`AGENTS.md`, at the repository root) is given by its absolute path,
because the run's working directory is `pedon/`, one level below it.

`--call-budget` works for Codex through actual site/MCP invocations, using
the same `CallBudget` ledger and warning ladder as Claude. This also counts MCP
queries, not merely shell commands. Warnings reach the model in tool results;
exhaustion asks it to finish and never denies its final validation or render.
The budget resets for each model invocation, as on Claude. Set
`YARDTWIN_CODEX_TRACE=/absolute/path/run.jsonl` to retain CLI events and budget
usage. This is evidence of tool use, not a design score.

**Codex sessions in this project also get YardEye directly.** Codex does not read `.mcp.json`;
it reads the committed `.codex/config.toml` at the repository root, and only once the folder
is trusted. That file is written from `.mcp.json` by `python3 tools/codex_setup.py --write`
(run it after changing either; a test fails until you do). It names no path on one machine:
Codex resolves a relative server folder against wherever it was started, so the server's
command walks up from there to the checkout.

An already-open session without MCP can use the SAME tool handlers:

```bash
python3 tools/view_mcp.py --help
python3 tools/view_mcp.py preview_design '{"path":"data/designs/NAME.json"}'
python3 tools/view_mcp.py walk_through '{"stations":3}'
python3 tools/view_mcp.py look '{"subject":"BED_ID","from":"grazing"}'
python3 tools/view_mcp.py check_ground_contact '{}'
```

The CLI returns image paths. **Open those files with your image-viewing tool**
(`view_image` in Codex); a path or a successful render command is not visual
inspection. Use `--output-dir` to retain the pictures. The browser must still be
open with its scan loaded. These commands do not modify the working design.

The viewer's **Designer** selector is in the Design panel. Both Claude and
Codex run explore with a revision round from **Design it**, and **Ask what's
wrong** uses the selected backend with the actual walkthrough images attached.

Validation of site queries, rendering and revision establishes that the workflow works;
it does not establish human-level design quality or guarantee that planting is visible
past what already stands on the site.

## VIEWPOINTS THE OWNER PLACED — `look(viewpoint: "…")`

The owner can place cameras anywhere so both the user and the model can inspect
the design from the places the owner considers important.

In the viewer: frame a view, then **Save this view as…** (⌘K, or the View group).
It lands in `site.viewpoints[]` — **owner ground truth, exactly like landmarks and
areas**, so `save-owner` refuses a derived or fetched writer and nothing can
invent one. They are listed and restorable under **Places → Saved views**.

```bash
python3 tools/view_mcp.py list_viewpoints '{}'          # saved_views comes FIRST
python3 tools/view_mcp.py look '{"viewpoint":"from the back door"}'
```
**The frame is the whole design decision.** A viewpoint stores x, y and a height
ABOVE THE GROUND at that point — `look`'s own convention — so a saved viewpoint
IS a stored `look()` call and expanding one is a lookup, not a conversion. No
second frame exists to get wrong, which prevents confusion between ENU and world
coordinates. `tests/test_viewpoints.py` asserts the numbers are passed through
UNCHANGED: if that ever needs arithmetic, the frame has diverged.

Height above ground also means the camera FOLLOWS the ground if terrain is
re-derived, and it round-trips exactly, because the same `heightAt` answers at
capture and at replay.
**Judge a change from a view the owner chose.** A saved view is the only entry in
`list_viewpoints` the owner decided on; everything else there is something the
design or the site happens to contain.
## Letting the model LOOK (browser must be open)

Rendering needs WebGL, so it only happens in the viewer. `tools/view_mcp.py` is an MCP
server that lets a HEADLESS model ask the open tab for a picture: it posts to the dev
server's render broker, the viewer renders against the live scene and posts the frame
back, and the image is returned **inline** in the MCP result — verified with both
subscription backends.

`agent.py --explore` passes `.mcp.json` automatically for either backend, so the design agent
gets a `look` tool whenever a viewer is open. The active chat agent can call the
same tool directly. A provider-independent local invocation is:

```bash
python3 tools/view_mcp.py look '{"subject":"bank_bed"}'
# Open the returned image with the active agent's image-viewing tool.
```

`look(subject, from)` takes a design id, landmark, area name or "x,y". `from:"grazing"`
puts the camera at the subject's own height — the view where an object floating or
standing on a deck is unmissable. The reply carries `gap_under_object_m`. With no viewer
connected it returns `no_viewer` immediately rather than hanging, and a BACKGROUNDED tab
is throttled, so keep the window visible.
**For Claude, `--strict-mcp-config` is not optional** — without it the subprocess inherits unrelated
user-scope MCP servers and burns context listing their tools.

**REVIEWS ALWAYS USE FULL BOTANICAL DETAIL AT MATURE SIZE**.
`look`, `walk_through`, and scene export prepare a separate review group from the
current design source, await its textures and models, and restore the scene on
screen afterwards, even on failure. Fast preview and the growth selector remain
viewing preferences. The reply names the design source, detail and maturity;
an old viewer that cannot confirm them is refused rather than counted as a look.

**PATH-TRACED IMAGES THROUGH `look`, WITH A MEASURED SIZE LIMIT**:

```bash
python3 tools/view_mcp.py look '{"subject":"bank_bed","render":"photoreal"}'
# Or supply eye + look_at / an owner-saved viewpoint, as for any other look.
```

The tool returns a successful Cycles PNG **inline**, using the same MCP image format
for both subscription backends. The CLI
saves a PNG; open it with your image-viewing tool. Each call freshly exports the
current preview at full detail and mature size, with the camera and geometry in
the same world frame. It does not reuse a previous proposal's scene. Allow a few
minutes and keep the viewer open. The explore brief asks for a photoreal look at
the planting/material decision before settling it, then a revision if the image
calls for one. Detailed raster looks remain the quick iteration path. A missing
Blender installation or failed export returns an error, never a substitute image.
The render stops at 8 GiB of physical memory, preserves 8 GiB of free disk and
has a ten-minute overall deadline. A failure does not count as having looked;
continue with detailed views and report the limitation instead of retrying it.
Measured through the real tool handler, a five-plant design takes
2.0 s export + 10.7 s import/render, 900×576, 24 samples, 5.41 GiB peak. A whole
garden of ~200 plants exports ~5 M instances / ~340 M expanded triangles
and stops at the 8 GiB guard. The failure occurs during instance realization
before Cycles starts; preserving the same instances completes import at 5.71 GiB,
but a whole-garden Cycles render with that representation is not verified. **Do not
repeat a whole-garden render that stopped at the guard.** Detailed raster reviews do work on it.
Verify image receipt and interpretation with the active agent, and check
`data/site_api_calls.log` for `rendered:true, ok:true`. This verifies receipt and
interpretation, not species identification or better designs. The render is generated
locally and the same YardEye image response is available to either backend.
On a site where north is not set, path-traced shadow directions carry the
unset-north warning. This wiring makes the image available; it does not establish
that the resulting designs are better — that needs a person's comparison.

**IMAGE-GENERATED DESIGN VIEWS**. Photographic interpretations use Fast preview
plus plant/material metadata with built-in image generation. See `docs/rendering.md`
for the workflow, prompts and observed layout changes. This experiment is available in
the chat session, not through `look(render="photoreal")`, which still means
Cycles. Compare generated images with the actual design when reviewing them.

**WHAT THE DESIGN AGENT ACTUALLY DOES WITH ITS EYES — measured** from the
call log:

- it stands like a person: median camera height **1.65 m**, most looks between 1.4
  and 1.9 m, median about 5 m from the subject, few drone views.
- it moves and looks again: more than half its look-sequences reposition, the camera
  moving a median **6.8 m** between consecutive looks.
- it aims better than chance, but not by much: median distance from an edit to the
  nearest camera **0.64 m**, against **0.93 m** for the same number of cameras
  thrown at random.
- **most edits (about three in four) have no look at all in the eight calls before
  them.** It builds, then reviews.
- it seldom calls `sightline` or `list_viewpoints` unprompted.

**AND THE OBVIOUS METRIC IS USELESS HERE, which is why the numbers above are the
ones to use.** "Was there a camera within 3 m of the edit" scores 98% for the real
looks — and **100% for random cameras**: on a garden a few hundred square metres in
area, ~100 cameras with a 3 m radius blanket it however they are aimed. Any gate built on coverage
would pass a model that aimed at nothing. Calibrate against the random baseline or
the threshold is decoration.
**The must-look gate asks whether it looked AT WHAT CHANGED**. The round's changes are
the diff of the design before and after its ops (added, moved, reshaped or removed —
position, polygon, spline); they are grouped in 4 m cells, and each cell must sit in the
middle 80% of some frame taken AFTER the round's last `apply-ops`, within 25 m. Every look and
walkthrough frame logs its eye, aim and field of view in the call log for exactly this.
A miss sends the round back naming the places and a camera for each (`unseen_feedback`).

**The must-look gate requires returned image evidence**.
`check_ground_contact` remains essential measurement, but cannot substitute for
seeing. Refusals, empty walkthroughs and old attempt-only log rows do not pass.
Every retry must provide its own successful visual call; exhausting retries
leaves the destination unchanged. The runner uses a scratch file per destination
so a variant does not overwrite another variant's preview.
## Looking at a design

Two different things, deliberately named apart: **Walk the garden** (the dock)
puts YOU in the garden with W A S D; **Photograph the garden** RENDERS stills
from the design's own paths for review and critique. Distinct names keep camera
movement and rendered stills apart, and make both easy to find.

Eye-level views are the only reliable judge of what a person sees on site;
other viewpoints can hide visual defects. **Photograph the garden** renders viewpoints
standing on the design's own paths and usable areas at 1.65 m, and **Ask what's
wrong** sends them for a critique.

## When the design asks for something the library cannot draw

**The agent can get the model itself**: `find_asset` (this library, the built-in
kinds, Poly Haven's CC0 models, with pictures), then `fetch_asset` the one that fits, or
`make_asset` from a Blender script it writes (sandboxed: no network, no writes outside its
own folder). Each returns the model's picture — look at it — and a card whose `model` path
goes straight into `place_object`. `docs/objects-and-surfaces.md` has the details.
**Plants too:** give the three a `species` (`find_asset {plant: true}`) and the model
goes into the plant library; `place_plants` / `set_plants` name it as `asset`. It is for a
species the viewer draws wrong.

`kind` is FREE TEXT on `place_object`, so a design may ask for a moon gate, a koi
pond or a tea house. An unmodelled one draws as a marked placeholder and is
recorded as a WANT — the viewer shows it to the user, and:

```bash
python3 tools/wants.py                 # every want across EVERY saved design, with sizes
python3 tools/wants.py --build         # generate all of them
python3 tools/gen_object.py --kind "tea house" --height 2.4 --width 2.6
```

`gen_object.py` has `claude -p` write a procedural builder for `objects.js`, then
**verifies it by running it** — it parses, it draws real geometry, its base sits on
the ground, it is about the height asked for, and `known_kinds()` can see it — and
REVERTS if any of that fails. objects.js is imported at module scope, so a broken
one blanks the viewer; nothing is kept that has not rendered. It retries with the
specific failure, up to three times.
**A builder inserted at the wrong indent is the subtle failure**: it parses,
renders and resolves, while `known_kinds()` — which reads `^\s{2}(\w+):` — cannot
see it, so the asset is buildable by the viewer and invisible to `wants.py` and
`list_assets`, and the design agent never learns it exists. The verifier checks
for exactly that so every generated builder is discoverable.

`tools/objects_index.py` is the ONE python reader of objects.js's vocabulary;
`tests/test_wants.py` cross-checks its answers against node actually running
objects.js, so the python side cannot drift from the JS.
