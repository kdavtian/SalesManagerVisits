// Folders the server reads files from, fixed once here so a module keeps finding its files wherever it sits in server/src
// (docs/architecture-roadmap.md, step 5 moves modules into business folders).
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLIENT_PUBLIC_DIR = path.resolve(SERVER_DIR, "..", "client", "public");
// The deploy build of the phone app's scripts (server/scripts/build-client.mjs, run by the Dockerfile); absent in local runs and tests.
export const CLIENT_DIST_DIR = path.resolve(SERVER_DIR, "..", "client", "dist");
export const MIGRATIONS_DIR = path.join(SERVER_DIR, "migrations");
export const ASSETS_DIR = path.join(SERVER_DIR, "assets");
