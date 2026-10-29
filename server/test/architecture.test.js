// Architecture checks (docs/architecture-roadmap.md, step 2): the structure rules that used to live only in the developer's head. Each
// check names what is wrong and where, so a new route, module or notification that breaks a rule fails here instead of in the field.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as espree from "espree";
import { app } from "../src/app.js";
import { NOTIFICATION_TYPES } from "../src/shared/notificationPreferences.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.resolve(SERVER, "../client/public");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const parse = (file) => espree.parse(fs.readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module", loc: true, range: true });
function eachNode(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const k in node) {
    if (k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => eachNode(c, visit));
    else if (v && typeof v.type === "string") eachNode(v, visit);
  }
}

// ---- 1. every API route needs a login -------------------------------------------------------------------------------------------------
// A route counts as guarded when requireAuth (a person's session), requireSyncKey (the CEO bot) or requireIntegrationToken (Lily) runs
// before it: in the route itself or as router.use() earlier in its router. The few routes that must work without a login are listed here
// with the reason; anything else unguarded fails.
const GUARDS = new Set(["requireAuth", "requireSyncKey", "requireIntegrationToken"]);
const PUBLIC_ROUTES = new Map([
  ["app.js GET /api/health", "load balancer / deploy check"],
  ["app.js GET /api/ready", "deploy check: database reachable"],
  ["auth.js POST /login", "the login itself (rate limited)"],
  ["auth.js POST /logout", "clears the cookie; works with an expired session"],
  ["calculatorLock.js POST /verify", "PIN of the calculator mode, before any login (rate limited)"],
  ["lockdown.js GET /", "the lockdown screen asks whether the app is locked, before any login"],
  ["app.js GET /^\\/css\\/.*\\.css$/", "stylesheets"],
  ["app.js GET /manifest.json", "the install manifest"],
  ["app.js GET /.*/", "the app page for every other address (no data)"],
]);

test("every API route needs a login (or is on the short public list with its reason)", async () => {
  const owner = new Map();
  // route files live in <area>/routes/ (step 5)
  for (const file of walk(path.join(SERVER, "src")).filter((f) => f.endsWith(".js") && path.basename(path.dirname(f)) === "routes")) {
    const mod = await import(pathToFileURL(file).href);
    for (const v of Object.values(mod)) if (typeof v === "function" && Array.isArray(v.stack)) owner.set(v, path.basename(file));
  }
  const unguarded = [];
  (function walkStack(stack, guarded, who) {
    for (const layer of stack) {
      if (layer.route) {
        const ok = guarded || layer.route.stack.some((s) => GUARDS.has(s.handle.name));
        if (!ok) unguarded.push(`${who} ${Object.keys(layer.route.methods).join(",").toUpperCase()} ${layer.route.path}`);
      } else if (Array.isArray(layer.handle?.stack)) {
        walkStack(layer.handle.stack, guarded, owner.get(layer.handle) ?? "an unnamed router");
      } else if (GUARDS.has(layer.handle?.name)) {
        guarded = true;
      }
    }
  })(app.router.stack, false, "app.js");
  const unexpected = unguarded.filter((r) => !PUBLIC_ROUTES.has(r));
  assert.deepEqual(unexpected, [], "routes reachable without a login: add requireAuth (or put them on PUBLIC_ROUTES with the reason)");
  const stale = [...PUBLIC_ROUTES.keys()].filter((r) => !unguarded.includes(r));
  assert.deepEqual(stale, [], "PUBLIC_ROUTES entries that no longer exist or are now guarded: remove them");
});

// ---- 2. screens do not import the app shell -------------------------------------------------------------------------------------------
// app.js is the entry point (router + shell); a screen importing it ties the screen to the whole shell and makes a loop. What a screen
// needs from the shell lives in its own small module (badges.js, state.js, ...).
test("no phone-app module imports app.js", () => {
  const offenders = walk(path.join(PUBLIC, "js"))
    .filter((f) => f.endsWith(".js"))
    .filter((f) => /from\s+["'](?:\.\.?\/)+app\.js["']|import\(\s*["'](?:\.\.?\/)+app\.js["']/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(PUBLIC, f));
  assert.deepEqual(offenders, []);
});

// ---- 3. the offline copy is complete --------------------------------------------------------------------------------------------------
// Every script and stylesheet of the app is in the service worker's APP_SHELL (otherwise a screen breaks offline after an update), and
// every APP_SHELL entry exists (otherwise the service worker install fails and NO update reaches the phones).
test("every script and stylesheet is in sw.js APP_SHELL, and every APP_SHELL file exists", () => {
  const sw = fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8");
  const list = sw.match(/const APP_SHELL = \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(list, "APP_SHELL not found in sw.js");
  const shell = new Set([...list.matchAll(/^\s*"(\/[^"]*)"/gm)].map((m) => m[1]));
  const files = [...walk(path.join(PUBLIC, "js")), ...walk(path.join(PUBLIC, "css"))]
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => "/" + path.relative(PUBLIC, f).split(path.sep).join("/"));
  assert.deepEqual(files.filter((f) => !shell.has(f)), [], "files missing from APP_SHELL (add them, and bump CACHE_VERSION)");
  const missing = [...shell].filter((u) => u !== "/" && !fs.existsSync(path.join(PUBLIC, u)));
  assert.deepEqual(missing, [], "APP_SHELL entries with no file");
});

// ---- 4. notification types --------------------------------------------------------------------------------------------------------
// Every type the server sends is in NOTIFICATION_TYPES (the list the on/off preferences are stored against), and every type the Settings
// screen offers as a switch (views/settings.js) is a real type with its label in English and Armenian.
test("every notifyUser type is in NOTIFICATION_TYPES and offered in Settings, named in both languages", async () => {
  const used = new Map();
  for (const file of walk(path.join(SERVER, "src")).filter((f) => f.endsWith(".js"))) {
    eachNode(parse(file), (n) => {
      if (n.type !== "CallExpression" || n.callee.type !== "Identifier" || n.callee.name !== "notifyUser") return;
      const type = n.arguments[1];
      if (type?.type === "Literal" && typeof type.value === "string") used.set(type.value, `${path.relative(SERVER, file)}:${n.loc.start.line}`);
    });
  }
  assert.ok(used.size > 10, "notifyUser calls were not found: has the function been renamed?");
  const unknown = [...used].filter(([type]) => !NOTIFICATION_TYPES.includes(type)).map(([type, where]) => `${type} (${where})`);
  assert.deepEqual(unknown, [], "types sent but missing from NOTIFICATION_TYPES");

  // Every kind Settings offers (js/shared/notificationTypes.js, all groups) has its label in both languages.
  const { NOTIFICATION_GROUPS } = await import(pathToFileURL(path.join(PUBLIC, "js/shared/notificationTypes.js")).href);
  const shown = NOTIFICATION_GROUPS.flatMap((g) => g.types.map((x) => x.type));
  assert.deepEqual([...used.keys()].filter((type) => !shown.includes(type)), [], "types sent but not offered in Settings (add them to a group)");
  for (const lang of ["en", "hy"]) {
    const texts = (await import(pathToFileURL(path.join(PUBLIC, `js/i18n-${lang}.js`)).href)).default;
    assert.deepEqual(shown.filter((type) => !texts[`notification_type_${type}`]), [], `Settings types without notification_type_<type> in i18n-${lang}.js`);
    assert.deepEqual(NOTIFICATION_GROUPS.filter((g) => !texts[`notif_group_${g.key}`]).map((g) => g.key), [], `group titles missing in i18n-${lang}.js`);
  }
});

// ---- 5. one place for role rules ------------------------------------------------------------------------------------------------------
// Who may do what lives in client/public/js/shared/roles.js, shared by the server and the app. A screen asks a named rule from there
// instead of keeping its own list of roles (a copied list drifts from the server's: a button that answers "not allowed", or a missing one).
// Allowed: the role pickers (their own display order) and the per-tile default roles of the Home quick actions (data the admin edits,
// not a rule).
const ROLE_LIST_ALLOWED = new Set(["js/views/admin/team.js:ROLE_OPTIONS", "js/quickActions.js:ALL_ROLES", "js/quickActions.js:defaultRoles"]);
test("no screen keeps its own list of roles: it asks js/shared/roles.js", async () => {
  const { ROLES, PICKABLE_ROLES } = await import(pathToFileURL(path.join(PUBLIC, "js/shared/roles.js")).href);
  const roleNames = new Set(PICKABLE_ROLES);
  const isRole = (n) => n?.type === "Literal" && roleNames.has(n.value);
  const offenders = [];
  for (const file of walk(path.join(PUBLIC, "js")).filter((f) => f.endsWith(".js") && !f.includes(`${path.sep}shared${path.sep}`))) {
    const rel = path.relative(PUBLIC, file).split(path.sep).join("/");
    if (/\/i18n(-[a-z]+)?\.js$/.test(rel)) continue;
    const owners = [];
    eachNode(parse(file), (n) => {
      if (n.type === "VariableDeclarator" && n.id.type === "Identifier") owners.push([n.init, n.id.name]);
      if (n.type === "Property" && n.key.type === "Identifier") owners.push([n.value, n.key.name]);
      // a list of two or more role names
      if (n.type === "ArrayExpression" && n.elements.filter(isRole).length >= 2) {
        const owner = owners.find(([node]) => node === n || (node?.type === "NewExpression" && node.arguments[0] === n))?.[1];
        if (!ROLE_LIST_ALLOWED.has(`${rel}:${owner}`)) offenders.push(`${rel}:${n.loc.start.line} [${n.elements.filter(isRole).map((e) => e.value).join(", ")}]`);
      }
      // role === "a" || role === "b" (|| ...)
      if (n.type === "LogicalExpression" && n.operator === "||") {
        const sides = [n.left, n.right];
        if (sides.every((x) => x.type === "BinaryExpression" && x.operator === "===" && (isRole(x.right) || isRole(x.left)))) offenders.push(`${rel}:${n.loc.start.line} (role === … || role === …)`);
      }
    });
  }
  assert.deepEqual(offenders, [], "role lists outside js/shared/roles.js: use (or add) a named rule there");
  assert.ok(ROLES.length >= 8);
});

// ---- 6. one scheduler ------------------------------------------------------------------------------------------------------------------
// Background work is a job in server/src/jobs/index.js (one scheduler: runs once even with two server copies, last run shown in Settings
// > System health), never a module's own setInterval.
test("no setInterval in the server outside the job scheduler", () => {
  const offenders = [];
  for (const file of walk(path.join(SERVER, "src")).filter((f) => f.endsWith(".js") && !f.endsWith(path.join("jobs", "scheduler.js")))) {
    eachNode(parse(file), (n) => {
      if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "setInterval") offenders.push(`${path.relative(SERVER, file)}:${n.loc.start.line}`);
    });
  }
  assert.deepEqual(offenders, [], "add a job to server/src/jobs/index.js instead");
});

// ---- 7. business folders -----------------------------------------------------------------------------------------------------------
// server/src holds the entry points and folders only (docs/architecture-roadmap.md, step 5): a new module goes into the folder of its
// area (orders, customers, field, money, products, erp, reports, team, bonus, system, shared), a route file into <area>/routes/.
const AREAS = ["orders", "customers", "field", "money", "products", "erp", "reports", "team", "bonus", "system", "shared"];
test("server/src: only the entry points at the top, every route file in <area>/routes", () => {
  const top = fs.readdirSync(path.join(SERVER, "src"), { withFileTypes: true });
  assert.deepEqual(top.filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => e.name).sort(), ["app.js", "index.js", "seed.js"]);
  const misplaced = walk(path.join(SERVER, "src"))
    .filter((f) => path.basename(path.dirname(f)) === "routes")
    .map((f) => path.relative(path.join(SERVER, "src"), f))
    .filter((rel) => !AREAS.includes(rel.split(path.sep)[0]));
  assert.deepEqual(misplaced, []);
});


// ---- 8. no page-wide observers --------------------------------------------------------------------------------------------------------
// A screen builds its own parts right after it renders (docs/architecture-roadmap.md, step 7): no script may watch the whole page
// (document.body / document.documentElement / #app with subtree) to patch screens from outside. Allowed: app.js's announcement of
// error / success messages to screen readers, and an observer that watches only its own element.
const PAGE_OBSERVER_ALLOWED = new Set(["js/app.js"]);
test("no script watches the whole page to patch screens from outside", () => {
  const offenders = [];
  for (const file of walk(path.join(PUBLIC, "js")).filter((f) => f.endsWith(".js"))) {
    const rel = path.relative(PUBLIC, file).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    eachNode(parse(file), (n) => {
      if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || n.callee.property.name !== "observe") return;
      const [target, options] = n.arguments;
      const targetText = target ? src.slice(target.range[0], target.range[1]) : "";
      // the page itself, or #app (the old enhancers' `const app = document.querySelector("#app"); observer.observe(app, ...)`)
      const pageWide = /^(document\.body|document\.documentElement|document|app)$/.test(targetText) || /querySelector\(["']#app["']\)|getElementById\(["']app["']\)/.test(targetText);
      const subtree = options?.type === "ObjectExpression" && options.properties.some((p) => p.key?.name === "subtree" && p.value?.value === true);
      if (pageWide && subtree && !PAGE_OBSERVER_ALLOWED.has(rel)) offenders.push(`${rel}:${n.loc.start.line}`);
    });
  }
  assert.deepEqual(offenders, [], "build the part in the screen that renders it (call it right after rendering) instead of observing the page");
});
