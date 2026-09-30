// CLI arguments shared by the viewer's subscription-backed actions.
// Kept pure so the HTTP wiring can be checked without calling a model.
export function designAgentArgs(payload, script, images = []) {
  const args = [script, "--json"];
  if (payload.backend === "codex") args.push("--backend", "codex");
  if (payload.explore !== false) args.push("--explore", "--rounds", "2");
  if (Array.isArray(payload.selection) && payload.selection.length)
    args.push("--selection", payload.selection.filter(x => typeof x === "string").join(","));
  for (const image of images) args.push("--image", image);
  args.push(payload.prompt);
  return args;
}

// Two rounds, each with three attempts, each bounded by the Python backend.
export const DESIGN_TIMEOUT_MS = 2 * 3 * 2400 * 1000 + 60000;

export function codexImageArgs(paths, prompt, schemaPath = null) {
  const args = ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
    "--sandbox", "read-only", "-c", 'approval_policy="never"'];
  for (const path of paths) args.push("--image", path);
  if (schemaPath) args.push("--output-schema", schemaPath);
  args.push(prompt);
  return args;
}
