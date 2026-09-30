# PEDON — read this first, whatever tool you are

PEDON is a landscape design tool, for any designer and any site. The code lives in
`pedon/`, and words a user sees say PEDON and "site", not "the yard" — some identifiers
(`YARDTWIN_*` variables, `yardtwin.*` browser keys) keep the project's first name, YardTwin,
because renaming them would drop settings already saved. A real photogrammetry scan of the
site loads in a three.js viewer; a model proposes garden designs as JSON; deterministic
validators apply them. Everything is in metres and checked against measured ground.

**This is the one entry point, and it is the same file for every tool.** Codex and
most agents load `AGENTS.md` automatically; Claude Code loads `CLAUDE.md`, which
imports this. There is no second copy — a second copy is the mistake
`tests/test_dry.py` exists to catch. **If `AGENTS.local.md` exists beside this file, read it
too:** the owner's working notes for this checkout — how they hand over work, what is open,
what closed recently. It is untracked, and never part of the source.

It is deliberately short. It holds the rules that do not change and an index of
where everything else is; **open the file for the work you are doing before you
start.** Nothing below repeats them.

## Where the detail lives

| what you are doing | read |
| --- | --- |
| designing the garden yourself | `pedon/DESIGNING.md` — the method, addressed to you |
| spawning the design agent, or making it look | `pedon/docs/design-agent.md` |
| asking the ground anything | `pedon/docs/site.md` |
| the viewer, the shell, working by hand | `pedon/docs/viewer.md` |
| what a design document is and how it is written | `pedon/docs/design-document.md` |
| light, shadows, the GPU, photoreal, AR | `pedon/docs/rendering.md` |
| measuring render memory and exported geometry | `pedon/docs/rendering.md` — `tools/render_profile.py` |
| generated photographic views from Fast preview | `pedon/docs/rendering.md` — the image-generation experiment |
| plants — and getting a species its own 3D model, or its own builder | `pedon/docs/plants.md`, then `pedon/ASSET_FIDELITY.md` |
| the LIBRARY: what is made along the way, where it goes, what each item must say about its source and licence | `pedon/docs/library.md` |
| objects, paving, walls, steps — and finding or making a 3D model the library lacks | `pedon/docs/objects-and-surfaces.md` |
| getting plants into the GROUND where the design says: printable planting plan / schedule / setting-out, and AR on the phone | `pedon/docs/planting-out.md` |
| the tool scripts, and adding a capability | `pedon/docs/tools.md` |
| adding a feature | `pedon/EXTENSIONS.md` |
| rules that cost real time to learn | `pedon/docs/lessons.md` |

## Start here

```bash
cd pedon/viewer && npm run dev          # http://localhost:5178
```

**Three places** (`pedon/docs/library.md`): the APP is this checkout — code, tools, docs, and
no assets; the user's LIBRARY, `~/PEDON/library` (`PEDON_LIBRARY`), holds everything made along the
way — plant and object models, textures, reference photos, the plant catalogue, species builders —
shared by every site, each item saying where it came from; and **every site is a project**,
`~/PEDON/<site>/` (`PEDON_PROJECTS`), outside the code and never part of the source.
`data/…` in any document, prompt or tool means **the active site's** file: `data/design.json`
is its live working design (the viewer polls it, so a write shows within about a second),
`data/designs/` its saved variants, `data/site.json` its ground truth, `project.json` its name,
units and policy (whether cats have the run of it); `data/plant_palette.json` and `assets/…` are
the library's. A new site starts in the viewer (··· → Project settings → New project…) or with
`python3 tools/project.py new "NAME" --open`; the demo garden — a site made by code, north set at
an angle — with `python3 tools/project.py demo --open`; `README.md` walks the setup path.

## The rules that do not change

They are here because breaking one is expensive and none of them is obvious;
`docs/lessons.md` holds the reasons.

- **No Anthropic or OpenAI API keys.** Subscription CLIs only — the project's standing
  constraint.
- **The design architecture is LLM-agnostic.** Site tools, rendering, image
  replies and validation belong to PEDON; provider adapters only transport
  requests and results. Use the active session's model for verification (Codex
  in Codex, Claude in Claude). Do not spawn a different provider just to test a
  shared tool. Provider comparisons are separate, explicitly requested work.
- **Landmarks, drawn areas and saved viewpoints are OWNER GROUND TRUTH** — never
  model-generated, never inferred from a name. `save-owner` refuses a derived or
  fetched writer.
- **There is ONE write path.** Every change to a design, by hand or by a model,
  goes through `POST /api/ops` → `agent.execute()` + `validate()`. A second path
  reintroduces exactly what the validators exist to catch.
- **Physical facts and building code are ENFORCED; taste is only ever REPORTED.**
  Every hard rejection is measured ground, code, or unplantable. An extension may only warn.
  Spacing is taste: the validator refuses only two plants in one hole or one in a tree's
  trunk, and MEASURES the rest.
- **Code measures; the LLM decides.** Code may measure the ground, render a view, do
  arithmetic the LLM asks for (spread these plants through the shape it drew, clip a bed
  to a path) and refuse the physically impossible. It never makes or overrides a design
  decision, and never changes a design on its own. A loop that re-places the agent's plants,
  or a helper that chooses drift shapes to save time, has crossed that line. Faster means
  faster measuring, not deciding.
- **ENU and world are different frames, and they are IDENTICAL at yaw 0**, so
  every bug in this class is invisible until north is set. Test at a non-zero
  yaw or you have tested nothing. The demo garden has north set at 25°.
- **`cat_safe: null` is NOT safe.** It means unverified, and a photograph can
  never establish toxicology.
- **Measure before theorising.** Reasoning about a cause instead of instrumenting
  it produces confident wrong answers — and so does an instrument that cannot see
  what it claims to, so check the instrument too.
- **A green test proves nothing until you have seen it go red.** Break the code,
  watch the test fail, then believe it.
- **Verify against the artefact the user experiences, not the one you can read.** A UI
  defect is invisible in source by definition.
- **One owner for a vocabulary.** A list copied into a second place drifts within
  the hour; `tests/test_dry.py` fails when it happens.
- **A site's files are found through `tools/project.py`** (the viewer's server:
  `viewer/project_paths.js`) — never by joining the checkout to `data` or `assets`. A literal
  join reads the wrong site or no library, and escapes a test's sandbox — where it can
  overwrite a real site's files. `tests/test_project.py` refuses one.
- **When an investigation says the request is the wrong approach, the deliverable
  is a SENTENCE saying so** — not a different feature built instead.

**THE CHECKLIST, before any UI change is reported:**

- [ ] opened `shell.html` and looked at the WHOLE screen, not a crop — composition
      defects like two stacked bars only exist in the whole
- [ ] the instrument showed real data (a real site's rows, the long names), not a fixture
- [ ] clicked the thing, and the thing next to it
- [ ] every new label reads as what the user gets, in their words, not the code's
- [ ] nothing I touched is defined in two places

## How this project improves itself — keep this loop running

PEDON improves by a loop, not by design up front: a user hits a limitation, the cause is
*measured* rather than guessed, and a capability is built that removes the whole class of
problem. That only compounds if the next session starts where this one finished. So:

1. **When something is wrong, measure before theorising.** A bug takes longest when a
   confident explanation arrives before a measurement does.
2. **Fix the class, not the instance.** A pad at the wrong level is an instance;
   "the model cannot ask the ground a question" is the class. Prefer the fix that
   makes the next ten instances impossible.
3. **Decide WHO the tool is for before you decide its shape.** Almost everything
   in `tools/` is for a model; the person designing works in the viewer and will not
   type a CLI. So a bare CLI is the *weakest* useful form, and picking it by
   default builds a capability nobody invokes. Ask which consumer this is for:

   | consumer | right shape |
   | --- | --- |
   | the design agent mid-design | an MCP tool in `view_mcp.py` — it should not have to know a filename |
   | a validator decision | a rule in `agent.py` / `site_api.py check-ops`, so bad ops are REJECTED, not merely reported |
   | the person designing | something the viewer shows them unprompted |
   | a session editing this code | a CLI is correct here — `frame_check.py` is a regression test, and tests are typed by whoever is editing |

   `float_check.py`'s consumers are the design agent, the walkthrough critique and the
   viewer, not a person at a prompt — so it is wired as `mcp__yardeye__check_ground_contact`,
   where they call it; as a bare CLI nobody would run it.
4. **Write it down where it will be FOUND.** New capability → add it to this file or the doc
   it indexes, in the same change. A durable lesson about how to work → `docs/lessons.md`.
5. **Then check it, do not trust it.** `python3 tools/capability_check.py` lists
   anything a new session could not discover — a tool can be built, tested and shipped and
   still never be called by a fresh session, because nothing it reads names it.
6. **Verify with the active agent.** Call the shared tool here and inspect its
   actual output (including opening returned images), then check the site's
   `data/site_api_calls.log`. A good-looking reply is NOT evidence the
   tools were used. For changes to discovery or startup, cold-start the SAME
   provider with a question the owner would ask; choose its backend explicitly
   (`--backend codex` or `--backend claude`). Do not pay for a second model to
   repeat a tool check the current agent can perform.

## The test suite — `python3 tools/selftest.py`

It runs BOTH halves, Python and the viewer, and the user's library's own species tests; no
viewer and no external network, about two minutes. The app's tests read a FIXTURE library
(`tests/fixtures/library`); tests about a real measured site read the reference site
(`PEDON_TEST_SITE`, a copy), and tests about the user's own library read it — without them they
skip, as on a fresh checkout. Run it before and after any change.

It holds itself to a time budget in CPU seconds at a quiet machine's price (efficiency cores
charge up to 2.2x the CPU for the same work, so the runner prices the run and judges the quiet
number). If it goes over, find what got slow BEFORE moving the number — `pytest --durations=12`,
and `node --test` one file at a time; an overridden budget hides a real regression, such as a
validator that re-runs itself once per warning.

**A green test proves nothing until you have seen it go red.** A guard can pass while the bug it
targets is live — by skipping a group it cannot find, or by slicing from an `indexOf` that
returned -1 and so matching nothing. When you add a test, break the code and watch it fail
before you believe it.
