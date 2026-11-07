// Screenshot comparison ("does any screen change by accident?"), run by `npm run shots:main` (scripts/shots-vs-main.mjs), which prepares
// the database and the build and runs this config twice: on the base branch's code with --update-snapshots=all (the pictures go to
// $SHOTS_DIR, never committed), then on this code with --update-snapshots=none (any changed pixel fails; diff images in test-results-shots).
import { fileURLToPath } from "node:url";
import base from "../../playwright.config.mjs";

const PORT = process.env.E2E_PORT ?? "3401";

export default {
  ...base,
  testDir: ".",
  testMatch: "shots.visual.mjs",
  timeout: 10 * 60_000,
  retries: 0,
  workers: 2,
  fullyParallel: true,
  reporter: "list",
  outputDir: "../../test-results-shots",
  snapshotPathTemplate: `${process.env.SHOTS_DIR || "/tmp/fv-shots"}/{arg}{ext}`,
  expect: {
    ...base.expect,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      timeout: 15_000,
      // A real change moves hundreds of pixels; this only absorbs anti-aliasing noise of a few glyph edges.
      maxDiffPixels: 40,
      // blur and shadows of the floating bars land on whatever scrolls under them: not pixel-stable; a toast is a message on a timer
      // (it shows or not depending on how fast the machine is), not the screen's layout
      style: "*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; } .app-toast { visibility: hidden !important; }",
    },
  },
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}`, trace: "off", video: "off", screenshot: "off" },
  projects: [{ name: "shots" }],
  webServer: { ...base.webServer, cwd: fileURLToPath(new URL("../..", import.meta.url)), url: `http://127.0.0.1:${PORT}/api/health`, reuseExistingServer: false, env: { ...base.webServer?.env, PORT } },
};
