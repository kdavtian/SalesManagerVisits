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

const checks = [
  ["application shell", "/", /<main[^>]+id="app"/],
  ["primary stylesheet", "/css/styles.css", /\.nav-bar\s*\{/],
  ["application entry module", "/js/app.js", /renderNav|renderRoute/],
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

if (failures > 0) {
  console.error(`\nDeployment verification failed: ${failures} check${failures === 1 ? "" : "s"}.`);
  process.exit(1);
}

console.log(`\nDeployment verification passed for ${baseUrl}.`);
