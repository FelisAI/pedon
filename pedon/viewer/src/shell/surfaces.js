// The panel's surfaces, in ONE place.
//
// Defined twice — once in main.js and once in the review sheet — it drifts within
// the hour: a sheet still adopting a `viewStrip` that has been split into four
// rows shows a Display panel missing four of its six sections, while the app
// looks fixed.
//
// Two copies of a vocabulary is the mistake tests/test_dry.py exists to catch,
// and it is the same reason design_doc.js owns DESIGN_KINDS: the replacement has
// to iterate the same list the builder does.
//
// `ids` are the elements each surface ADOPTS from the classic panel, in reading
// order. `cmd` is the command that opens it, named here so the link is in the
// source rather than in a convention a reader has to infer.
export const SURFACES = {
  // NO HEADER ACTION. "Show all" as one button stretched across the top of the
  // surface reads as its primary control; it is a RESET, so it belongs
  // beside the count it resets and only when there is something to reset.
  objects:  { cmd: "app.objects", label: "Objects", short: "Objects", icon: "objects",
              ids: ["objRow", "objFind", "objAlts", "objTally", "objList"],
              hint: "everything placed, with an eye to hide each one" },
  design:   { cmd: "app.versions", label: "Designs", short: "Designs", icon: "designs",
              // `designCur` says WHICH ONE YOU ARE EDITING and whether it is
              // modified — the single most important fact on this surface, so
              // it travels with the lists.
              ids: ["designCur", "designSource", "designFind", "designCompare", "designList"],
              hint: "switch, save, compare",
              // SAVE is the ⌘S the user reaches for; a shortcut with no button is the
              // failure every_command_has_a_home exists to catch
              actions: [{ id: "design.new", title: "New" },
                        { id: "design.save", title: "Save" },
                        { id: "design.saveAs", title: "Save as…" }] },
  // the CREATION controls travel with the lists. A surface that shows what
  // exists but cannot add to it sends you straight back to the panel, which is
  // the trip the surfaces exist to remove.
  // PLACES IS GROUND: points and regions on the yard. Cameras are not ground,
  // so saved views have a surface of their own.
  places:   { cmd: "app.places", label: "Places", short: "Places", icon: "places",
              ids: ["lmHead", "lmNewRow", "lmList", "areaHead", "areaName", "areaList"],
              hint: "landmarks and drawn areas" },
  // VIEWS: the cameras you saved and the stills you rendered — things that
  // EXIST and get browsed, which is what the panel is for.
  views:    { cmd: "app.views", label: "Views", short: "Views", icon: "eye",
              ids: ["vpRow", "vpList", "shotsHead", "shotsList",
                    "prHead", "prRow", "prMsgRow", "prOut"],
              hint: "views you saved, and photographs of the garden",
              // PLAIN WORDS. Labels like "New photos / Critique / Snap" say what
              // the code does, not what you get, and mean nothing to the user.
              // Every label here is the sentence a person would say out loud.
              actions: [{ id: "view.saveViewpoint", title: "Save this view" },
                        { id: "view.shots", title: "Retake photos" },
                        { id: "design.ask", title: "What's wrong?" }] },
  // VIEW SETTINGS: how the yard is DRAWN, not what is in it. The sun, plant
  // maturity and the layer toggles are each a question about the picture rather
  // than about the design, so they belong together.
  view:     { cmd: "app.view", label: "Display", short: "Display", icon: "view",
              // SPLIT BY THE QUESTION EACH CONTROL ANSWERS. One strip holding four
              // unrelated ones — how to move, how editing behaves, what hour it
              // is, how big plants are drawn — reads as a jumble. All six layer
              // toggles are live, read through a local `on(id)` helper in
              // applyLayers that an id-literal grep cannot see.
              ids: ["sunHead", "sunRow", "sunWhenRow", "sunShadowRow", "sunLabelRow",
                    "sunTwoSunsRow",
                    "drawHead", "growthRow", "qualityRow",
                    "showHead", "layerRow", "editHead", "editRow"],
              hint: "sun, how plants are drawn, what is shown" },
};
