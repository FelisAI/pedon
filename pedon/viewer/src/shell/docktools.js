// THE DOCK'S TOOLS — one list, for the app and for the review sheet.
//
// shell.html exists so the chrome can be LOOKED AT without a two-minute scan load,
// and it is only worth looking at if it is the app. A second copy of this list in
// the sheet drifts from the app's — labels, icons and whole buttons disagree. A
// list that lives in two places is the fault tests/test_dry.py exists for; this
// is the one place.
export const DOCK_TOOLS = [
  // THE DOCK IS FOR DOING, THE PANEL IS FOR LOOKING. The bottom tool bar is for
  // action — adding things, drawing things; the left panel is for managing and
  // looking at existing things.
  //
  // So every entry here MAKES something or puts you somewhere: walk into it,
  // measure it, draw a region, add a plant, save this camera, render the stills.
  // Not here: the four camera presets and Frame, which change how you are
  // looking rather than what exists — those are viewport controls and sit in the
  // top bar. And browsing review shots, which is the Views surface.
  // THE DEFAULT STATE HAS A BUTTON: after Measure, or any tool, there must be a
  // visible way back to the default state. First, lit whenever no tool is, and the
  // one way back from any of them — Esc takes the same exit.
  { id: "tool.select",  icon: "pointer", title: "Select",
    hint: "click things to select them, drag to look around — Esc from any tool comes back here" },
  { id: "view.walk",    icon: "walk",    title: "Walk the garden" },
  { id: "tool.measure", icon: "measure", title: "Measure" },
  { id: "tool.pick",    icon: "select",  title: "Select a section",
    hint: "drag a loop round part of the site to select everything inside it; shift adds. Then \u21e7S shows only those" },
  { id: "tool.area",    icon: "area",    title: "Draw an area" },
  // ADD OPENS THE LIBRARY, and that is all it does. It has no "Place the picked one"
  // entry: picking in the library already puts a ghost under the cursor and the next
  // click on the ground places it, so such an entry would name a step nobody takes.
  { id: "tool.assets",  icon: "add",     title: "Add",
    hint: "a plant or an object from the library — pick one, then click where it goes" },
  // GO TO A VIEW: the views you saved, one click away. A separate "see it from inside"
  // photo walk here would conflict with the Views tab, so the photos are made from the
  // Views panel, beside the photos themselves; and the button is a VERB, not "Views",
  // because the rail already has a Views and two strips must not share a word.
  { id: "view.pick",    icon: "camera",  title: "Go to a view", dynamicMenu: true,
    hint: "jump to a view you saved, or save this one — [ and ] step through them" },
];
