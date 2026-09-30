# The viewer — PEDON, the shell and working by hand

`cd pedon/viewer && npm run dev` → http://localhost:5178. A UI defect is
invisible in source by definition; the review sheets exist so it can be seen.

The tools reach a viewer at `YARDTWIN_VIEWER` (default `http://localhost:5178`). The dev server
sets it to its own address for everything it starts — the AR export, a render, the design
agent's eyes — so a viewer on another port is asked about its own site, not whichever one holds
:5178.

## THE UI REVIEW PROCEDURE

**Verify against the artefact the user experiences.** Complete the review without
requiring repeated feedback from the user. These five rules guide the work.

1. **Check the screen.** Defects can be visible in a screenshot
   and invisible in perfect-looking code — a white input, system-blue checkboxes,
   a control pushed off the edge, `display:flex` beating `hidden`. **A UI defect
   is invisible in source BY DEFINITION; if it were visible there it would be a
   logic bug.** → *Never call a UI change done without looking at the composed
   screen.*

2. **Review real data.** Short invented names and groups hide layout problems;
   a real design can have ZERO groups, 269 flat rows and names to 27 characters
   that need room to avoid truncation. **A fixture you author can only confirm
   what you already believe.** → *A review instrument reads real data and real
   markup, never a fixture.*

3. **Check the outcome after the edit.** A stale copy in the review sheet can
   hide the panel the user actually sees. As with designs, measure the artefact
   that reaches disk. → *Re-read what the user will see, after the change,
   before saying it is done.*

4. **Duplicated vocabularies drift.** Copying panel markup into the sheet or
   defining `SURFACES` twice lets a fix reach only one copy.
   → *One owner, always; the sheet FETCHES index.html and imports
   `shell/surfaces.js`.*

5. **Keep internal jargon out of labels.** "Eye-level shots" says where the
   camera is, not what you get. → *A label is a deliverable. Name it by what the
   user receives.*
## LOOK AT THE CHROME — `viewer/shell.html`

```bash
open http://localhost:5178/shell.html      # the shell, without the yard
```
**The fourth review sheet**, beside `compare.html`, `objects.html` and
`surfaces.html`. It mounts the REAL shell components against fixture data and a
painted backdrop — same CSS, same icons, same modules — so the chrome can be
looked at, clicked and criticised in a second.

It exists because the viewer itself must load a scan and every plant before its
chrome can be looked at, and a screenshot taken while it is busy can time out.
Inspect the sheet for a white input in a dark panel, system-blue checkboxes, a layer toggle pushed off the
edge, and **`display: flex` silently beating the `hidden` attribute**, which makes
floating surfaces unhideable.
**A UI defect is invisible in source by definition** — if it were visible in
source it would be a logic bug. Open the sheet.

`tests/js/chrome.test.mjs` asserts the sheet stays in step with the app it
reviews; a sheet that drifts stops being a review of anything.
**EVERY COMMAND MUST HAVE A PLACE A PERSON CAN CLICK.** ⌘K is a search box: it
finds what you can already name, so every command, including the review workflow,
also needs a visible home. `tests/js/every_command_has_a_home.test.mjs`
fails if a command is reachable only by hotkey or palette. The six legitimate
homes are the dock, a dock button's menu, the rail, a panel header's actions, the
inspector card, and the right-click or ··· menus.
## THE SHELL — canvas-first

The viewer is **PEDON** (*pedon, n. the smallest volume that can be called a
soil*). Basic operations and manual design edits must be intuitive; a single
long list of controls makes them hard to find and use.

The yard fills the window and everything floats over it:

- **Top bar** — wordmark, the design you are editing, undo/redo with the timeline
  position, ONE camera control, ⌘K. It states **previewing** prominently, because
  editing confidently into an agent's scratch file is the failure it exists to
  prevent. Camera framing and photography need distinct controls and glyphs.
  Framing the whole yard is a camera framing exactly like Top and Isometric,
  so it is the first entry of the camera menu (F does it too), and the dock's
  photograph action has a `camera` glyph of its own.
- **Dock** (bottom centre) — the daily tools, built from the extension registry
  rather than markup, so a contributed tool sits beside a built-in one.
- **⌘K palette** — everything the app can do, ranked by subsequence so "wtg"
  finds "Walk the garden". The only surface whose cost does not grow as the app
  does, which is why it is right for a tool gaining extensions.
- **Inspector** — a card beside the selection with its fields AND its verbs
  (frame, duplicate, change species, group, align, hide, delete).
- **Activity rail + persistent panel** — Objects ▤, Designs ◈, Places ⌖, View ☀
  down the left edge, ALWAYS VISIBLE even when the panel is collapsed, and the
  panel remembers which was open across reloads. `o` / `v` toggle theirs.
  They ADOPT their elements from `#shellStore` and hand them back when the
  surface changes, which is why that markup must stay.

  **The rail carries SURFACES; the dock carries TOOLS.** One entry per thing:
  Objects needs a visible entry on the rail, without a duplicate dock button.
  A surface must offer content, not just buttons that call `.click()` on another
  panel's buttons.
- **Toasts** — transient. Errors never auto-dismiss and are never pushed off by
  an acknowledgement, because a refusal must remain VISIBLE.
- **HUDs** — the measurement appears beside the last point clicked, rather than
  inside a collapsible panel section. A result reported where the user is not
  looking has not been reported.
**NAVIGATION HAS NO MODE.** Right-DRAG looks, WASD moves any time, the wheel sets
fly speed, right-CLICK opens a context menu on whatever is under the cursor — the
convention every 3D editor converged on. A 4 px threshold tells drag from click;
get that wrong and either the menu opens after every camera turn or never at all.
Walk mode remains for sustained eye-height walking over the real scan.
**⌘-DRAG ORBITS FROM ANYWHERE, OVER ANYTHING.** The point of the gesture is that you do
not have to find empty ground first, so it has to outrank the gizmo, the control
points and the object body — it is the FIRST check in `gizmo.js grabOrder`, the
one pure place that decides what a press grabs. Anywhere below them it would work
over grass and die over the thing the user is pointing at, which is the half of the
yard anyone actually points at. ⌘-CLICK still adds to the selection; the 4 px
threshold is what separates them.
**AND IT TURNS AROUND WHAT THE USER IS POINTING AT.** The press finds
whatever is under the cursor — the design first, then the scan, then the ground
plane — and the drag turns the camera about it (`navigate.js pivotOrbit`), so a
corner they turn to look at stays where it is on screen. Writing that point into
`controls.target` changes the aim even if the camera position stays fixed:
OrbitControls ends every update in `lookAt(target)`, so the view snaps to face
the point (a measured shift of 20.2°). OrbitControls sits out a ⌘-drag
(`enabled = false`) and is handed a target ON the view axis at
the pivot's depth, so its lookAt keeps the aim.
`navigate.js orbitPivot` holds three refusals: nothing under the cursor, a hit
past 60 m (a grazing ray lands a hundred metres off) and a hit within half a
metre (a pivot on the camera's nose spins the world) all keep the pivot they had.
Only the ⌘ gesture moves it — re-pivoting on every patch of grass during a plain
drag would make the pivot unstable.

**AND three.js BINDS THAT MODIFIER TO PANNING.** OrbitControls documents it
at the top of its own file: *"Pan: Right mouse, or left mouse + ctrl/meta/shiftKey"*.
Without compensation, `grabOrder` hands a ⌘-drag to the camera but the camera
slides sideways. Its switch is symmetric (LEFT bound to PAN plus a modifier
ROTATES), so `navigate.js leftBindingFor` binds LEFT to PAN for exactly
as long as the modifier is held, and `orbitAction` mirrors three.js's own switch
so the compensation is asserted through THEIR rule rather than through ours. It is
bound on KEYDOWN, not at the press: OrbitControls is constructed at `main.js:91`
and registers its listener long before main.js's own, so a flip made when the
press arrives is already too late; `blur` restores it, or ⌘-Tab leaves every plain
drag panning.

**AN ORBIT AND A PAN ARE TOLD APART BY THE TARGET, NEVER BY THE CAMERA.** Both
move `camera.position`; only a pan carries `controls.target` with it. Measured
examples: camera 3.645 m / target 0.23 m (a PAN) against camera 3.962 m / target
0 m (an ORBIT). Camera movement alone cannot verify an orbit;
`navigate.js cameraGesture` names the distinction for tests.
**SHIFT SELECTS A RANGE, AND A RIGHT-CLICK ACTS ON IT.** Shift and ⌘ must remain
distinct gestures. `rangeBetween` takes the RENDERED order — `treeOrderIds`,
rebuilt by `renderObjectList` — and not a re-derived one, because the tree is
sorted, filtered and foldable: a range from
the design's own order selects things the user cannot see between two rows that
are adjacent on screen, and the fault stays invisible until they delete the selection.
The tree's right-click builds from the same `contextItemsFor` the canvas uses, so
the two menus cannot drift, and a right-click on a row outside the selection
selects it first the way every file manager does.
**A `title` IS NOT A TOOLTIP — `viewer/src/shell/tooltip.js`.** A `title` attribute is a
REQUEST for a tooltip: the browser waits a second or more, draws OS chrome, and
abandons the request if the pointer moved on the way in — over a canvas
repainting every frame that is unreliable enough to read as nothing being there.
Icon-only buttons are the whole reason it matters: the rail carries a word under
each glyph, the top bar and the dock do not, so the tooltip is the only thing
that says what the button is, and a label nobody can read is the same failure as
no label at all. The native one is SUPPRESSED rather than raced — `title` moves
to a held value while the pointer is over the element and is put back on the way
out, so nothing else has to learn a new attribute.
`placeTip` is pure: below, else above, clamped to the margins, which is what the
dock needs since it sits at the bottom of the window.
**A PROJECT IS THE `data/` DIRECTORY OF ONE PROPERTY, AND IT SAVES ITSELF.**
There is no Save because everything writes on change — but an invisible autosave
and a missing button are indistinguishable from the outside, so the settings
must explain saving and loading. `GET /api/project` reports the seven
parts with what each is FOR and its real size and date off `statSync`, and the
settings window lists them under a sentence saying so. A second property is a
second project (see *Sites* below): nothing of one site is shared with another,
deliberately, because a landmark or a drawn area belongs to one site; only the
library is shared.

Calibration must autosave too: level, north and scale underpin every coordinate
and must survive closing the tab. `applyCalib()` is the single place every
calibration change reaches the scene, so it is the single place that knows a
change happened, and it autosaves there; `restoringCalib` stops a load writing
straight back.
**MEASURING BEFORE LOCKING THE SCALE IS OPTIONAL, AND NORTH IS NOT.**
These are different SIZES of wrong and the top bar must not
conflate them: a LiDAR capture's own scale is off by about a percent, while an
unset north is off by however the scanner happened to be facing — 23.3° in a
measured example — and every bearing, slope aspect and sun position
inherits it. So the scale step is non-blocking and offers "Use the capture's own
scale", with a three-way state that says which claim is being made (measured /
accepted / neither); north still refuses.
**A ROW SAYS WHAT THE THING IS — `viewer/src/shell/rowtext.js`.** One vocabulary
for the objects tree, read by main.js AND by the review sheet. Separate row
formats such as `kind · id · describe()` and `id name · height` make the sheet
review different markup from the app. `rowLabel` is what a person would call it (a
plant's common name, an object's free-text kind, a bed's own id); `rowMeta` is
the quantity you would buy, plus the id where the name does not identify one
thing — a design can have 81 of 215 plants called Pink muhly grass. `kindPlural`
exists because `kind + "s"` produces **"stepss"**.
A riser is in CENTIMETRES: at one decimal of a metre different riser heights
print as "0.1 m", hiding the difference between a comfortable step and one
over the code limit.
**NO LABEL MAY NAME A MECHANISM — `tests/js/plain_language.test.mjs`.** Avoid
labels such as `frame` as a button, `Detect structures`, `Demo splat`,
`Check residual`, `live reload`, `library shape`, and tooltips explaining that
something "is an op". **"op" is the sharpest case**: it is the correct internal
word — one write path, `POST /api/ops` — so it
reads as precise to whoever wrote it and as nothing at all to the user. A word being
RIGHT is not the same as a word being readable.
**IS THE PROPERTY EVEN CALIBRATED? — `viewer/src/shell/setup.js`.**
When `site.frame.north_set` is FALSE, site.json warns that every bearing is
unverified. Do not compute that status from `siteCache.registration`: site.json
has no such key, so it would report "not calibrated" for every property. An uncalibrated
capture makes every design on it **self-consistent and wrong**, which no
validator can catch. The top bar says so beside the design name, and the settings
window shows the six steps in `analyze_site.py`'s own order with the next one
highlighted. It reads the LIVE calibration before the file, because site.json is
written by a tool run and the browser may have set north since.
**`#shellStore` IS MARKUP, NOT A SURFACE.** The side surfaces
ADOPT those elements and hand them back, so the markup is the home they are
returned to, not a surface. `#shellStore` is `hidden aria-hidden`,
has no header, no positioning rule and nothing that can open it, and
`tests/js/shell.test.mjs` fails if any of that changes or if a surface names an
id that is not inside it.

Before removing anything from the store, check `tests/js/sidepanel.test.mjs` —
it asserts that every control left inside is reachable some other way. A stranded
control is unreachable, because nothing opens the store. It carries
an explicit exemption list for the four view buttons wired by a COMPUTED id
(`"view" + which[0].toUpperCase()`) and therefore invisible to any source scan.
**TWO WAYS TO KILL A STYLESHEET, AND A BRACE COUNTER SEES ONLY ONE.** Deleting
a rule's CSS by matching its selector lines can leave an orphaned comment TAIL — the
body and its `*/` without the opening `/*`. A CSS parser reads dangling prose as
a selector and keeps going until it finds a block to use as the body, swallowing
the next rule. Losing `#settings { position: fixed; }` leaves the settings window
at `position: static`, opening at 0,0 over the top bar even with `top: 52px` in
the rule. Comments contain no braces, so 111/111 balanced braces at depth 0 can
hide a browser parsing only 110 of 111 declared rules.
`tests/js/stylesheet_intact.test.mjs` scans comment delimiters as well as
braces. **Never delete CSS by matching a selector line, and when a rule seems not
to apply, count the rules the BROWSER parsed rather than the ones you can read.**
## Sites — the project window

**··· → Project settings** is where a site is started, opened and set up. The top bar names
the open site before the design (`site / design`). **New project…** makes an empty site and
reloads into its setup path; the **Site** list (shown once there are two) switches, reloading
the page — the scan, calibration, designs and saved list all belong to the site. The setup
path is controls, not commands: **Choose File** copies a capture into the site's `captures/`
(`POST /api/captures`) and opens it from there, so it reopens next time; **Survey the ground**
runs `tools/analyze_site.py` and **Look up** runs `tools/geodata.py --address` for the active
site (`POST /api/setup/survey`, `/api/setup/address`). What the browser remembers per site —
the design you were on, the camera, each design's hidden objects and folded groups — is keyed
by the site the server stamps into the page (`<meta name="pedon-project">`,
`viewer/src/shell/sitekey.js`); legacy browser-wide values migrate to the first site opened.

## Working in the viewer by hand
**SELECT IS THE DEFAULT, AND THE WAY BACK.** The dock's first tool is Select, lit whenever
no tool is on; pressing it, or Esc, leaves ANY tool through `leaveTool()` — the one exit,
which leaves each tool the way its own button does so its cleanup runs, and says so once.
Add is lit while its library is open. A tool's cleanup must not throw — `clearMeasure`
writing to an element that is not in the page, for one: `setMode` clears before
it records the new mode, so a throw during cleanup traps the viewer in that tool.
**THE ADD LIBRARY'S PICTURES ARE DEFERRED AND KEPT.** Fast draws the photoreal builders
and the catalogue takes ~20 s to build, so drawing pictures while making cards would stall
Add for all of it. A card asks `plantThumbLater` and fills in when its picture is drawn, one per
turn of the event loop; pictures are kept in the browser (IndexedDB) under the plant code's
version (`/api/plant-build`, a hash of `viewer/src`), so a second visit opens with every picture at once
and an edited builder is never shown from a stale picture.
**☆ MINE — THE PLANTS THE OWNER HAS.** Each plant card in the Add library has a ☆ mine toggle and
the filter row a "mine" box. The list is the SITE's `data/owned_plants.json` (`catalogue` holds
catalogue names; `said`, the owner's own words, is kept untouched), written through `/api/save` after
re-reading the file on disk, so a design session that grew the list is never overwritten. One
owner for reading and changing it: `viewer/src/shell/owned.js`.
**THE GIZMO MOVES THINGS; A BODY DRAG DOES NOT.** To prevent accidental nudges,
`grabOrder` sends a drag on a selected object's body to the CAMERA; the two
ways to move are the gizmo arrows and the control points, both aimed at on purpose.
A click still selects, ⌘-drag still orbits from anywhere.
**THE INSPECTOR DOCKS, TOP RIGHT.** Opening beside the selection can cover the
neighbouring plant, slide under the cursor as the camera turns and change position
on every click. `placeCard` ignores the anchor to keep it in a stable position.
**PLACE MODE CARRIES WHAT YOU ARE PUTTING DOWN.** A ghosted copy of the picked
plant or object follows the cursor at half opacity, built once per asset and moved
after that — a 2 M-triangle shrub cannot be rebuilt per pointermove. It hangs in
`designsGroup`, never in `designGroup`, so nothing picks, measures or exports it.
`__pedon.placeGhost()` reports it.
**THE YARD OPENS AT FULL SIZE.** "Plants at" defaults to mature because a plan is
spaced for grown plants, and the stage you choose is remembered.
**SELECTING ANYWHERE LIGHTS THE ROW.** `setSelection` repaints the Objects list and
scrolls the row into view when it is off screen; hovering a row still lights the
object in the yard.
**[ AND ] STEP THROUGH THE SAVED VIEWS**, in the order the Views panel lists
them, wrapping at both ends. **A RELOAD REOPENS WHERE THE CAMERA WAS**:
`yardtwin.lastCamera` in localStorage, written as the camera moves and read first
thing in boot, before the "Save view" bookmark. A camera saved over a
different capture is not restored.
**⌘S SAVES WHAT YOU ARE EDITING.** Over the saved design the panel names
(`editing "…" — modified, not saved`), or Save as… when it names none; ⇧⌘S is
always Save as…, and both are buttons in the Designs header. Which design you are
editing is `yardtwin.currentVariant` in localStorage, so it survives a reload. When
several saved designs hold the same content, that one wins the tie, and a name whose
file is gone is dropped. Never write a byte-identical copy of the working design
into `data/designs/`: identical copies make the save destination ambiguous without
the tie rule.
**CLICKING A NAME REPLACES THE WORKING DESIGN, AND THAT IS UNDOABLE.**
It archives first. The status line carries an **undo** link after a switch or a History
restore, titled with the archive it would put back, and pressing it archives the
current design first — so undoing an undo works. One step deep: the History list
is the full record. Immediate undo avoids searching archives to recover a design
replaced by a click.
**AN EDIT REBUILDS WHAT CHANGED, NOT THE GARDEN.** Measured on a 205-plant design:
the op round trip takes 0.6 s, while regenerating the lava rocks alone takes ~7 s.
`buildDesignGroup` keeps any part whose item and drape are unchanged
(`reusableParts`, a `reuseSalt` of render quality + `drapeEpoch`). A one-plant move
rebuilds in 18 ms. Anything new that a part is drawn FROM, beyond its own item,
must go into the salt or the key, or a rebuild will keep a stale part.
`__pedon.editTimings()` in the console times the last reloads stage by stage (op,
fetch, assets, build, swap, ui, first frame). Measure in a VISIBLE tab: a hidden tab
runs no frames and throttles timers, and its absolute numbers are several times worse.
A page load in Fast reads each kind of plant back from the browser instead of generating it
(`docs/rendering.md`): the first load after the plant code changes generates and stores
them (~3.5 s build on a measured design), every load after reads them (~1 s). `__pedon.plantStore()`
reports it; `__pedon.object(id).glowing` counts the meshes the selection highlight lit.
**Walk the garden** (the dock, or `w`) is a free camera: W A S D, mouse to
look, Space/C up and down, Shift to hurry, Esc to stop. "Stay on the ground"
keeps you at 1.65 m over the real scan, providing an eye-height view for checking
visual defects. The maths is `viewer/src/flycam.js` and is tested; OrbitControls
is disabled while it runs and gets a target handed back
in front of the camera so the view does not swing.
**Measure** clicks points on the ground and reports BOTH lengths, because on a
14.3 deg slope they differ: metres *across* (what paving and turf are sold by)
and metres *along the ground* (what you walk, and buy edging and hose by), plus
fall, grade and plan area. `viewer/src/measure.js`, and it reads the ground
through `enuToWorld` because `heightAt` is a WORLD function.
**The dock** (bottom centre) holds the daily tools — walk, measure, draw area,
assets, photograph. Daily tools need visible entries; burying them in the last
collapsible section makes them hard to discover. The rail down the left edge carries SURFACES
(Objects, Designs, Places, Views, Display), not tools — one entry per thing.
**Select one object** and the property inspector appears in the inspector card
beside the selection:
every field the op vocabulary carries for that kind — a path's width and
material, a wall's height, batter and what it retains, a flight's riser and
going, a patio's purpose. Each edit is an OP through `/api/ops`, so it is checked
and undoable; `""` clears a field rather than writing an empty one.

**A plant's planning size is editable.** Select an individual plant (Alt-click a
member of a group), enter **Planning height** and **Planning width**, then **Apply
size**. The fields take feet/inches or metric, through the project's unit parser;
width means full spread. The inspector keeps the catalogue sizes and ranges
visible and offers **Reset to catalogue size**. For grasses with separate flower
heights, the height field describes foliage. Changes use `set_plants`, keeping the
id, position and other properties, and can be undone. These dimensions feed both
the model and the design's measurements. An intentional `size_override` survives
`resync_palette`; Reset removes it. The shared catalogue is not edited by this UI.
`shell.html` imports this same inspector and reads the real design and catalogue;
its edits affect only its preview copy.
**Align and space evenly** from the selection bar. The axes are COMPASS, not
screen — "align left" would mean something different every time the camera moved,
which is the class of bug the ENU/world rule exists to prevent. Edges line up the
bounding boxes' FACES and centres line up their MIDDLES, because a row of stones
of different sizes looks crooked when matched by face; the target is the extreme
you named rather than the mean, since a mean moves the object already standing
where you want the row. Spacing evenly keeps the two END objects where they were
placed and evens only what is between them. It goes through the same `moveOps`
a drag does, so an aligned object landing on the house or off the scan is
rejected with the reason.
**Reshape** a selected path, edge, flight, bed or patio by dragging a control
point; the faint MIDPOINTS between them add a corner, and double-clicking a real
handle removes one (never below a triangle, or two ends for a line). A point
object also takes typed `x`/`y`. Every one of these is an op through `/api/ops`,
so it is checked and undoable.
**Hidden and folded are PER DESIGN**. They live in the browser
(`localStorage["yt.view.v2"]`, keyed `design:<name>`), never in the design file, and
switch with the design: what the user hides in one variant is not hidden in another. Save as…
carries the view across; deleting a design drops it. `viewer/src/shell/viewstate.js`.

**Moving a marker**: drag its pin (the cursor turns to a hand over the knob,
stem or ring), or press **move** on its row in Places and click the ground; Esc leaves
it where it was. It is written through `save-owner` like every other owner fact — a
marker is never a design op. `viewer/src/landmarks.js` holds the pure halves.

**Hide the plant names** with the "plant names" box beside the design/markers/house/
scan toggles. In a 193-plant design the species labels can be most of what a
frame contains from any distance, and every judgement about colour, massing or
height is made THROUGH them — so it is a viewing control, not a cosmetic one. The
labels carry `userData.plantLabel`, because selecting them by "is it a Sprite"
would also take out the north arrow, the landmark pins and the area captions. All
four layer toggles remember their state in localStorage: VIEW state, never a
design field, the rule per-object visibility already follows.
**Show or hide ONE object** with the eye on its row in the Objects list, not only
a whole group. It is independent of group hiding — a group hides its own NODE and
leaves members visible, so switching the group back on does not turn a separately
hidden bench back on — and a hidden object is UNPICKABLE, because three.js's
raycaster tests layers and never looks at `.visible`, so without that check you can
drag what you cannot see. It is VIEW state in localStorage, never a design field.
**Hiding a group holds.** The ground-contact badge runs
`withFlatDesign` on every render, a regroup mints a fresh `THREE.Group` at
`visible = true`, which would undo the eye's hide. `regroupScene`
carries each node's visibility across the rebuild, and `withFlatDesign`
carries it across its flatten/regroup pair. **`__pedon.groupNodes()`** is the
instrument for checking group nodes under `designGroup` with their `visible`
flags, what the panel believes is hidden, and any member left stranded at the
root. Reach for it before theorising about grouping or attributing a visibility
problem to panel state or `applyLayers()`.
**SIZES ON SCREEN, IN METRES OR FEET AND INCHES.** ⚙ project settings → *Sizes shown in*. Everything is stored, validated and computed in METRES and that does not change; this is the last step before a number becomes text, and it lives in `data/project.json` because it belongs to the property, not to one browser. `viewer/src/shell/units.js` is the ONE owner; do not duplicate unit formatting inline with `toFixed`. Imperial reads feet-and-inches over a foot and plain inches under one, because a 7 m path is 276 in and nobody can picture that; areas go to square feet, which is how paving is sold.
**ADD OPENS THE CATALOGUE; PICKING ARMS PLACE MODE.** The user must choose in the catalogue before place mode is armed; the hidden `placeWhat` select's first option is not a user choice. **Esc leaves place mode** and area drawing.
**SELECT A SECTION BY DRAWING ROUND IT.** The dock's *Select a section* tool: hold and drag a loop across the ground and everything inside it is selected. Shift while you start adds to the selection; **Esc** leaves. Then **⇧S** solos it — everything else hides, press again to come back — or use the eye in the Objects list. A point (a plant, a lantern) is caught by its position; a run or a polygon (a path, a bed, a flight of steps) comes only when it is WHOLLY inside, because half a path is not a thing you can hide and catching the whole contour walk on one clipped vertex is what makes a marquee infuriating. A LOCKED group is never caught. The rule is `idsInsidePolygon` in `areas.js`, beside the point test it uses.
**Check the existing mass-selection controls before adding more**: shift-range in the Objects list, shift/cmd-click in the view, the list filter, per-object and per-group hide, and Solo. Selecting a section chooses by WHERE A THING STANDS rather than by its name.
**A group is the thing you pick.** Clicking a grouped object in the 3D view
selects the WHOLE group, so dragging the gizmo moves it as one; **hold alt** to
reach past the group and select the single member under the cursor. Shift and
cmd add to the selection, and they take a group in or out as a unit. Selecting
only the member under the cursor would prevent a gizmo drag from moving the group.
**Moving a group keeps the group.** A plant is moved, typed or swapped with
`set_plants`, which keeps its id. Using `remove_objects` + `place_plants` gives
the plant a new id and drops it out of its group, so a move must preserve the id.
**Type an exact distance while an arrow is held**: hold the east arrow, type `1.5`, press
Enter — it moves exactly 1.5 m (a minus goes west, south or down; Esc cancels). **The snap grid
is the user's to set**: every 10 cm, 25 cm, 50 cm or 1 m beside the snap switch, remembered in the
browser; the pull scales with it. `__pedon.gizmo()` gives the hub and a point on each arrow on
screen, so a check can grab an arrow the way a hand does.
**The transform gizmo** appears on the selection: two ground-plane arrows (red
east, blue north), a centre handle that drags in the plane, and an amber rotation
ring. It is sized in PIXELS (`GIZMO_PX = 84`), because in metres it is a speck on a
30 m yard and a monster on a 0.3 m set stone. **Two rings, not one**: the amber one lying flat turns the yaw (`rotation_deg`),
the teal one standing upright turns the LEAN (`tilt_deg`, objects only — an edge
has no such field). Both use the same `ringDeg` on a permuted basis rather than a
second copy of the maths. A lean is applied in the object's own frame after the
yaw, so a boulder turned 90° still leans the way it was set to.
**The violet arrow is UP**, and it writes `level_m` rather than lifting freely —
a thing leaves the ground only through the field the validators already
understand, and `float_check` still measures where the geometry really ends up. It
is offered only where `level_m` is legal for the whole selection, so a plant never
gets one. Axis picking takes the NEAREST axis, not the first — with three axes,
first-match can answer a vertical grab with "x". What a press grabs is decided in ONE pure, tested place
(`gizmo.js grabOrder`): gizmo, then control point, then camera. Snap (grid, another
object's point, and angle while rotating) is `viewer/src/snap.js`; zero tolerance
means off.
**Place by hand** is a tile showing what a click will put down, with its picture.
Clicking it opens the asset window; picking a card sets the choice, closes the
window and arms place mode. The hidden `<select id="placeWhat">` is the
STATE — `pickedEntry()` is the one DOM read of it.
**Plants at** (Display → How plants are drawn) is the global maturity: *planting size* (0.45),
*~5 years* (0.70) and *mature* (1.0, the default). It scales what is DRAWN only —
every decision, validator and walkthrough still uses mature size, because a model
judging a garden 30% smaller than the one that gets built will space it wrong.
`growthScale()` is the one read of it, handed to `buildDesignGroup`.
**The screenshot tool does not capture `<img>` elements, only canvases.**
`viewer/compare.html`'s reference photos paint correctly and read as black in
every screenshot. Composite the photo and the render into one canvas before
judging either.
**Assets** (the dock) opens the asset window: every species AND every object the
library can build, each as a rendered picture of the ACTUAL model — not a
photograph, because what the user picks is what gets placed. Plants are filterable by
habit, water, California-native and cat-safe and searchable by common name; the
OBJECTS (lantern, basin, boulder, bench, pot, fire pit, screen, moon gate, koi
pond, pergola, …) sit on their own "garden objects" shelf at the end, because a garden
is not only planting and "place by hand" that can only place plants is half a tool.
Every plant filter is a question about a plant, so the objects drop out of a
native/cat-safe/habit/water search rather than being quietly admitted to it.

The shelf is derived from `objects.js BUILDERS` (`objectCatalog()`), so a builder
added without an `OBJECT_META` row still appears instead of vanishing; the sizes
there are what the thing IS (an ishidoro is 1.4 m, a bench seat 0.45 m) and they
seed the op, so a hand-placed lantern is a lantern and not a 0.8 m default stub.
Picking a card arms place mode; the ground click emits `place_object` (or
`place_plants`) through `/api/ops` like everything else. It drives the same
`placeWhat` selection the ground click reads, so there is still exactly one thing
that decides what gets placed.
