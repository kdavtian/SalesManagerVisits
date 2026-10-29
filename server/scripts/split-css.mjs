// Styles per area (docs/architecture-roadmap.md step 8c): moves the style rules only some screens need out of the stylesheets every
// screen loads (css/app.css and the files it joins) into css/areas/<area>.css, which a screen loads before it is drawn (js/styles.js).
//
//   node server/scripts/split-css.mjs --dry     print what would move, change nothing
//   node server/scripts/split-css.mjs           write css/areas/*.css and remove the moved rules from the source stylesheets
//
// Which rules move (all decided from the code, nothing by hand):
//   - every class and id a rule names is looked up in the app's scripts: the screens (shell/routes.js) whose files use it, following
//     static and on-demand imports. A name the start-up files use (shell, login, Home: the modulepreload graph) stays shared, so Home
//     still needs only the one shared stylesheet;
//   - a rule moves only when each of its selectors names at least one class, every name is found in the scripts (a class built in code,
//     like `tier-${t}`, is not found: the rule stays shared), and one area is in the area list (js/i18nAreas.js, the same lists the
//     texts use) of every screen that uses it: that screen then loads the area before it is drawn;
//   - the cascade: an area file comes after the shared stylesheet, so a moved rule now follows rules it used to precede. Two rules that
//     share a class name and set the same property keep their order: when moving would swap them, the rule stays shared (repeated until
//     nothing changes). Areas load in a fixed order (styles.js), so the order between areas is fixed too.
// A rule inside @media / @supports moves with a copy of its wrapper. @keyframes, @font-face, element-only rules and :root stay shared.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = path.join(ROOT, "client", "public");
const JS = path.join(PUBLIC, "js");
const CSS = path.join(PUBLIC, "css");
const DRY = process.argv.includes("--dry");
const KEEP_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "split-css-keep.json");
// a selector list compared without spaces or comments (the browser writes "a > b, c" where the file may say "a>b,c")
const normSelector = (sel) => stripComments(sel).replace(/\s+/g, "").replace(/::(before|after)/g, ":$1").toLowerCase();

// ---- a small CSS reader: top-level items with their exact text (comments before an item travel with it) ----
export function parseCss(text) {
  const items = [];
  let i = 0;
  let start = 0;
  const n = text.length;
  const skipComment = () => {
    const end = text.indexOf("*/", i + 2);
    i = end < 0 ? n : end + 2;
  };
  const skipString = (q) => {
    i += 1;
    while (i < n && text[i] !== q) i += text[i] === "\\" ? 2 : 1;
    i += 1;
  };
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") skipComment();
    else if (c === '"' || c === "'") skipString(c);
    else if (c === ";") {
      // a statement at-rule (@import, @charset)
      i += 1;
      items.push({ kind: "statement", text: text.slice(start, i) });
      start = i;
    } else if (c === "{") {
      const headEnd = i;
      let depth = 1;
      i += 1;
      while (i < n && depth) {
        const d = text[i];
        if (d === "/" && text[i + 1] === "*") {
          skipComment();
          continue;
        }
        if (d === '"' || d === "'") {
          skipString(d);
          continue;
        }
        if (d === "{") depth += 1;
        else if (d === "}") depth -= 1;
        i += 1;
      }
      const whole = text.slice(start, i);
      const lead = whole.slice(0, headEnd - start);
      const head = stripComments(lead).trim();
      const body = text.slice(headEnd + 1, i - 1);
      items.push({ kind: head.startsWith("@") ? "atblock" : "rule", text: whole, head, body, lead });
      start = i;
    } else i += 1;
  }
  const tail = text.slice(start);
  return { items, tail };
}

export function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

// the selectors of a rule, split on top-level commas
export function splitSelectors(head) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of head) {
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// class and id names a selector uses; `positive` leaves out those only inside :not(...)
export function selectorNames(sel) {
  const clean = sel.replace(/\[[^\]]*\]/g, "").replace(/(["']).*?\1/g, "");
  const all = [...clean.matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  const positive = [...clean.replace(/:not\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  return { all, positive };
}

export function declaredProperties(body) {
  return new Set([...stripComments(body).matchAll(/(?:^|;|\{)\s*(-?[a-zA-Z-]+)\s*:/g)].map((m) => m[1].toLowerCase()));
}

// ---- the scripts: which screens use which names ----
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;
const readJs = (rel) => {
  try {
    return fs.readFileSync(path.join(JS, rel), "utf8");
  } catch {
    return null;
  }
};
function graph(starts, { dynamic, notFrom = new Set() }) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const src = readJs(file);
    if (src == null) continue;
    seen.add(file);
    const res = [...src.matchAll(IMPORT_RE), ...(dynamic && !notFrom.has(file) ? src.matchAll(DYNAMIC_RE) : [])];
    for (const m of res) if (m[1].startsWith(".")) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  return seen;
}

export async function analyse() {
  const { ROUTE_TEXT_AREAS, TEXT_AREAS } = await import(pathToFileURL(path.join(JS, "i18nAreas.js")).href);
  const { bootModuleHrefs } = await import(pathToFileURL(path.join(ROOT, "server", "src", "system", "modulePreload.js")).href);
  const boot = new Set(bootModuleHrefs(PUBLIC).map((h) => h.replace(/^\/js\//, "")));
  const routes = readJs("shell/routes.js");
  const screens = new Map(); // route -> files (static + on demand)
  for (const m of routes.matchAll(/path === "(#\/[a-z-]+)"[^{]*\{([\s\S]*?)\n  \}/g)) {
    if (m[1] === "#/dashboard") continue; // Home = the start-up files (warehouse / driver Homes are their own routes too)
    const views = [...m[2].matchAll(/import\("\.\.\/(views\/[^"]+)"\)/g)].map((x) => x[1]);
    if (!views.length || !(m[1] in ROUTE_TEXT_AREAS)) continue;
    const files = screens.get(m[1]) ?? new Set();
    for (const f of graph(views, { dynamic: true })) files.add(f);
    screens.set(m[1], files);
  }
  // the start-up files and everything they open on demand use shared styles only (Home's sheets included)
  // (not through the router and the idle preloader, whose on-demand imports are every screen)
  const bootAll = graph([...boot], { dynamic: true, notFrom: new Set(["shell/routes.js", "shell/preload.js"]) });
  const fileText = new Map();
  const allJs = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(path.join(JS, dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (fs.statSync(path.join(JS, rel)).isDirectory()) walk(rel);
      else if (rel.endsWith(".js") && !rel.startsWith("i18n")) allJs.push(rel);
    }
  })("");
  for (const f of allJs) fileText.set(f, readJs(f));
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const usage = new Map(); // name -> { boot: bool, any: bool, routes: Set }
  const usageOf = (name) => {
    if (usage.has(name)) return usage.get(name);
    const re = new RegExp(`(?<![\\w-])${name.replace(/[-]/g, "\\-")}(?![\\w-])`);
    const files = allJs.filter((f) => re.test(fileText.get(f)));
    const u = {
      any: files.length > 0,
      boot: re.test(html) || files.some((f) => boot.has(f) || bootAll.has(f)),
      routes: new Set([...screens].filter(([, fs2]) => files.some((f) => fs2.has(f))).map(([r]) => r)),
      // used by a file no screen reaches (an orphan or a name built elsewhere): keep shared
      orphan: files.some((f) => ![...screens.values()].some((s) => s.has(f)) && !bootAll.has(f)),
    };
    usage.set(name, u);
    return u;
  };

  // the stylesheets app.css joins, in order
  const order = [...fs.readFileSync(path.join(CSS, "app.css"), "utf8").matchAll(/@import\s+url\("([\w.-]+\.css)"\)/g)].map((m) => m[1]);
  const rules = []; // every movable unit in cascade order
  const files = [];
  for (const file of order) {
    const parsed = parseCss(fs.readFileSync(path.join(CSS, file), "utf8"));
    files.push({ file, parsed });
    parsed.items.forEach((item, idx) => {
      if (item.kind === "rule") rules.push({ file, idx, inner: null, item, wrapper: null });
      else if (item.kind === "atblock" && /^@(media|supports)\b/.test(item.head)) {
        const inner = parseCss(item.body);
        item.innerParsed = inner;
        inner.items.forEach((sub, j) => {
          if (sub.kind === "rule") rules.push({ file, idx, inner: j, item: sub, wrapper: item.head });
        });
      }
    });
  }
  rules.forEach((r, i) => {
    r.order = i;
    r.selectors = splitSelectors(r.item.head);
    r.props = declaredProperties(r.item.body);
    r.names = new Set(r.selectors.flatMap((s) => selectorNames(s).all));
  });

  // 1. where each rule could go
  const areaRank = new Map(TEXT_AREAS.map((a, i) => [a, i]));
  for (const r of rules) {
    r.area = null;
    if (/(^|[\s,>+~(])(:root|html|body)\b/.test(r.item.head) || r.item.head.includes("::-webkit-scrollbar") && !r.item.head.includes(".")) continue;
    const perSel = r.selectors.map((s) => selectorNames(s));
    if (perSel.some((s) => s.positive.length === 0)) continue;
    let ok = true;
    const used = new Set();
    for (const s of perSel) {
      for (const name of s.all) {
        const u = usageOf(name);
        if (!u.any || u.boot || u.orphan) ok = false;
      }
      if (!ok) break;
      // the screens where this selector can match: those using every positive class it names
      let where = null;
      for (const name of s.positive) {
        const rs = usageOf(name).routes;
        where = where ? new Set([...where].filter((x) => rs.has(x))) : new Set(rs);
      }
      for (const x of where ?? []) used.add(x);
    }
    if (!ok || !used.size) continue;
    let candidates = null;
    for (const route of used) {
      const list = new Set(ROUTE_TEXT_AREAS[route].filter((a) => a !== "common"));
      candidates = candidates ? new Set([...candidates].filter((a) => list.has(a))) : list;
    }
    const pick = [...(candidates ?? [])].sort((a, b) => areaRank.get(a) - areaRank.get(b))[0];
    if (pick) r.area = pick;
  }

  // rules the computed-style comparison found changing a screen when moved (they lose to, or beat, a shared rule on the same element
  // through different class names): they stay shared
  const keepShared = new Set(JSON.parse(fs.readFileSync(KEEP_FILE, "utf8")).map(normSelector));
  for (const r of rules) if (r.area && keepShared.has(normSelector(r.item.head))) r.area = null;

  // 2. keep the cascade: rules sharing a name and a property keep their order
  const key = (r) => (r.area ? 1 + areaRank.get(r.area) : 0) * 1e7 + r.order;
  const byName = new Map();
  for (const r of rules) for (const name of r.names) byName.set(name, [...(byName.get(name) ?? []), r]);
  let changed = true;
  let rounds = 0;
  while (changed) {
    changed = false;
    rounds += 1;
    for (const list of byName.values()) {
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) {
          const [x, y] = [list[a], list[b]]; // x before y in the source
          if (key(x) < key(y)) continue;
          if (![...x.props].some((p) => y.props.has(p))) continue;
          // swapped: keep the moved one(s) shared
          if (x.area) {
            x.area = null;
            changed = true;
          }
          if (y.area && key(x) > key(y)) {
            y.area = null;
            changed = true;
          }
        }
      }
    }
  }
  return { rules, files, order, TEXT_AREAS, rounds, usage };
}

function areaFileText(area, rules) {
  const parts = [`/* Styles of the "${area}" screens (docs/architecture-roadmap.md step 8c): loaded by js/styles.js before such a screen is drawn,
   and in the background after the first screen. Moved here from the shared stylesheets by server/scripts/split-css.mjs, in their old
   order; a new rule only screens of this area use goes here. */\n`];
  let wrapper = null;
  let from = null;
  for (const r of rules) {
    if (r.file !== from) {
      if (wrapper) parts.push("}\n");
      wrapper = null;
      parts.push(`\n/* ---- from ${r.file} ---- */\n`);
      from = r.file;
    }
    if (r.wrapper !== wrapper) {
      if (wrapper) parts.push("}\n");
      if (r.wrapper) parts.push(`${r.wrapper} {\n`);
      wrapper = r.wrapper;
    }
    parts.push(`${r.item.text.replace(/^\n+/, "")}\n`);
  }
  if (wrapper) parts.push("}\n");
  return parts.join("");
}

function sourceWithout(fileEntry, moved) {
  const { parsed, file } = fileEntry;
  const out = [];
  parsed.items.forEach((item, idx) => {
    if (item.kind === "rule") {
      if (!moved.has(`${file}:${idx}:`)) out.push(item.text);
      return;
    }
    if (item.kind === "atblock" && item.innerParsed) {
      const keep = item.innerParsed.items.filter((sub, j) => sub.kind !== "rule" || !moved.has(`${file}:${idx}:${j}`));
      if (!keep.some((sub) => sub.kind === "rule") && item.innerParsed.items.some((sub) => sub.kind === "rule")) return; // emptied wrapper
      out.push(`${item.lead}{${keep.map((s) => s.text).join("")}${item.innerParsed.tail}}`);
      return;
    }
    out.push(item.text);
  });
  out.push(parsed.tail);
  return out.join("");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { rules, files, TEXT_AREAS, rounds } = await analyse();
  const moved = rules.filter((r) => r.area);
  const bytes = (list) => list.reduce((s, r) => s + r.item.text.length, 0);
  const total = bytes(rules);
  console.log(`rules: ${rules.length} (${Math.round(total / 1024)} KB); movable: ${moved.length} (${Math.round(bytes(moved) / 1024)} KB); cascade rounds: ${rounds}`);
  for (const area of TEXT_AREAS) {
    const list = moved.filter((r) => r.area === area);
    if (list.length) console.log(`  ${area}: ${list.length} rules, ${Math.round(bytes(list) / 1024)} KB`);
  }
  if (!DRY) {
    fs.mkdirSync(path.join(CSS, "areas"), { recursive: true });
    for (const area of TEXT_AREAS) {
      const list = moved.filter((r) => r.area === area);
      const target = path.join(CSS, "areas", `${area}.css`);
      if (list.length) fs.writeFileSync(target, areaFileText(area, list));
      else fs.rmSync(target, { force: true });
    }
    const keys = new Set(moved.map((r) => `${r.file}:${r.idx}:${r.inner ?? ""}`));
    for (const entry of files) fs.writeFileSync(path.join(CSS, entry.file), sourceWithout(entry, keys));
    console.log("written: css/areas/*.css; moved rules removed from the shared stylesheets");
  }
}
