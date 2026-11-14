/**
 * Ward's version. The exe build injects it from the root package.json (esbuild `define`), so the
 * version the updater compares against is always the one the release was built and signed as.
 * Run from source, it's read from package.json directly.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

declare const __WARD_VERSION__: string | undefined;

function fromPackageJson(): string {
  try {
    return (JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string = typeof __WARD_VERSION__ === "string" ? __WARD_VERSION__ : fromPackageJson();
