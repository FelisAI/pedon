// A NAME THE SERVER USES IS DECLARED SOMEWHERE. A refactor that removes a helper can leave a
// route reading that helper's local — e.g. `bytes: size` with no `size` in scope — and the route
// then answers 500 the moment it runs; `node --check` cannot see it. So the
// dev server's own modules (Node, not the page) are parsed, and every identifier they read must be
// declared in the file or be a Node global.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const VIEWER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer");
const { parseAst } = createRequire(path.join(VIEWER, "package.json"))("rollup/parseAst");

/** Identifiers a module reads that nothing in it declares and Node does not provide. */
function undeclared(src) {
  const declared = new Set(Object.getOwnPropertyNames(globalThis).concat(["__dirname", "__filename"]));
  const refs = [];
  const bind = p => {
    if (!p) return;
    if (p.type === "Identifier") declared.add(p.name);
    else if (p.type === "ObjectPattern") p.properties.forEach(q => bind(q.type === "RestElement" ? q.argument : q.value));
    else if (p.type === "ArrayPattern") p.elements.forEach(bind);
    else if (p.type === "AssignmentPattern") bind(p.left);
    else if (p.type === "RestElement") bind(p.argument);
  };
  (function walk(n, parent, key) {
    if (!n || typeof n.type !== "string" || n.type === "MetaProperty") return;
    if (n.type === "VariableDeclarator") bind(n.id);
    if (/Function/.test(n.type)) { if (n.id) declared.add(n.id.name); n.params.forEach(bind); }
    if (n.type === "ClassDeclaration" && n.id) declared.add(n.id.name);
    if (n.type === "CatchClause") bind(n.param);
    if (/^Import(Default|Namespace)?Specifier$/.test(n.type)) declared.add(n.local.name);
    if (n.type === "Identifier") {
      const label = parent && ((parent.type === "MemberExpression" && key === "property" && !parent.computed)
        || (parent.type === "Property" && key === "key" && !parent.computed)
        || (parent.type === "MethodDefinition" && key === "key")
        || ["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type)
        || (/^(Import|Export)/.test(parent.type) && key !== "local"));
      if (!label) refs.push([n.name, src.slice(0, n.start).split("\n").length]);
    }
    for (const [k, v] of Object.entries(n)) {
      if (Array.isArray(v)) v.forEach(c => walk(c, n, k)); else if (v && typeof v === "object") walk(v, n, k);
    }
  })(parseAst(src), null, null);
  return refs.filter(([name]) => !declared.has(name));
}

test("the reader finds a name nothing declares, and nothing else", () => {
  assert.deepEqual(undeclared("function f(buf) { return { bytes: size, n: buf.length }; }"), [["size", 1]]);
  assert.deepEqual(undeclared("import fs from 'node:fs'; const { a, b: [c] } = x(); fs.readFileSync(a + c); function x() {}"), []);
});

for (const file of ["vite.config.js", "server_http.js", "project_paths.js", "plant_version.js",
                    "ar_server.js", "agent_cli.js", "species_hooks.mjs", "species_register.mjs"]) {
  test(`viewer/${file} reads no undeclared name`, () => {
    assert.deepEqual(undeclared(fs.readFileSync(path.join(VIEWER, file), "utf8")), []);
  });
}
