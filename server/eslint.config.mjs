// Code checker (docs/architecture-roadmap.md, step 1). Errors only, no style rules: it exists to catch a wrong name, a dead variable or
// unreachable code before a user opens that screen. Run from the repo root by `npm run lint` (server/package.json), which also runs
// scripts/check-imports.mjs (every relative import points at a real file and every imported name is exported there).
import globals from "globals";

const rules = {
  "no-undef": "error",
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-dupe-else-if": "error",
  "no-dupe-class-members": "error",
  "no-unreachable": "error",
  "no-redeclare": "error",
  "no-self-assign": "error",
  "no-const-assign": "error",
  "no-func-assign": "error",
  "no-import-assign": "error",
  "no-unsafe-finally": "error",
  "getter-return": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
};

export default [
  { ignores: ["**/node_modules/**", "client/public/vendor/**", "dist/**", "server/test-results/**", "server/playwright-report/**"] },
  {
    files: ["server/**/*.{js,mjs}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } },
    rules,
  },
  {
    // browser tests run code inside the page (page.evaluate), so the browser names are known there too
    files: ["server/test/e2e/**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["client/public/js/**/*.js"],
    // L = Leaflet, a classic script loaded by leafletLoader.js before any map code runs
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.browser, L: "readonly" } },
    rules,
  },
  {
    files: ["client/public/sw.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: { ...globals.serviceworker } },
    rules,
  },
];
