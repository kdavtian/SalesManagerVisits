const baseUrl = process.env.DEPLOY_VERIFY_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const attempts = Number(process.env.DEPLOY_VERIFY_ATTEMPTS || 20);
const delayMs = Number(process.env.DEPLOY_VERIFY_DELAY_MS || 1500);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return { response, body };
}

let health;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    health = await request("/api/health");
    const payload = JSON.parse(health.body);
    if (payload.ok !== true) throw new Error("health response did not contain ok: true");
    console.log(`PASS  API health (${attempt}/${attempts})`);
    break;
  } catch (error) {
    if (attempt === attempts) {
      console.error(`FAIL  API health after ${attempts} attempts: ${error.message}`);
      process.exit(1);
    }
    await sleep(delayMs);
  }
}

// /api/health only confirms the process is up -- a deploy that came up but
// can't reach Postgres (bad credentials after a .env edit, migrations ran
// against a different db than the app connects to) would otherwise pass
// verification and get recorded as a known-good deploy. Checked separately
// from health (not folded into the loop above) since it's a distinct
// failure mode worth its own clear message.
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const ready = await request("/api/ready");
    const payload = JSON.parse(ready.body);
    if (payload.ok !== true) throw new Error("ready response did not contain ok: true");
    console.log(`PASS  API ready / database reachable (${attempt}/${attempts})`);
    break;
  } catch (error) {
    if (attempt === attempts) {
      console.error(`FAIL  API ready (database reachability) after ${attempts} attempts: ${error.message}`);
      process.exit(1);
    }
    await sleep(delayMs);
  }
}

const checks = [
  ["application shell", "/", /<main[^>]+id="app"/],
  // css/app.css is joined by the server from the boot stylesheets (step 9): no @import may be left in it
  ["joined stylesheet", "/css/app.css", /^(?![\s\S]*@import)[\s\S]*\.nav-bar\s*\{/],
  // a module either way: the source file, or the deploy build's minified copy (docs/architecture-roadmap.md step 10)
  ["application entry module", "/js/app.js", /\bimport\b[\s\S]*\bfrom\s*["']/],
];

let failures = 0;
for (const [label, path, marker] of checks) {
  try {
    const { body } = await request(path);
    if (!marker.test(body)) throw new Error("expected content marker was missing");
    console.log(`PASS  ${label} (${path})`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${label} (${path}): ${error.message}`);
  }
}

// Every script the service worker stores for offline use must be served: with the deploy build that is the built files (a missing chunk
// would break a screen on every phone after the update).
try {
  const { body } = await request("/sw.js");
  const shell = [...(body.match(/const APP_SHELL = \[([\s\S]*?)\n\];/)?.[1] ?? "").matchAll(/^\s*"(\/js\/[^"]+)"/gm)].map((m) => m[1]);
  if (!shell.length) throw new Error("no scripts listed in APP_SHELL");
  const missing = [];
  for (let i = 0; i < shell.length; i += 16) {
    const batch = shell.slice(i, i + 16);
    const results = await Promise.all(batch.map((path) => request(path).then(() => null, () => path)));
    missing.push(...results.filter(Boolean));
  }
  if (missing.length) throw new Error(`not served: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
  console.log(`PASS  offline scripts (${shell.length} files in /sw.js)`);
} catch (error) {
  failures += 1;
  console.error(`FAIL  offline scripts (/sw.js): ${error.message}`);
}

if (failures > 0) {
  console.error(`\nDeployment verification failed: ${failures} check${failures === 1 ? "" : "s"}.`);
  process.exit(1);
}

console.log(`\nDeployment verification passed for ${baseUrl}.`);
