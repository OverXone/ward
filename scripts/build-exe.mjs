/**
 * Builds dist/Ward.exe: one file with Node, the connector and the phone UI inside.
 *
 *   npm run build:exe
 *
 * 1. vite build          -> web/dist
 * 2. esbuild             -> build/connector.cjs (one CommonJS file, as Node SEA requires)
 * 3. sea-config.json     -> the script plus every web/dist file as a SEA asset (read with sea.getAsset)
 * 4. node --experimental-sea-config -> build/sea-prep.blob
 * 5. copy node.exe, postject the blob in -> dist/Ward.exe
 */

import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build");
const dist = path.join(root, "dist");
const webDist = path.join(root, "web", "dist");
const exe = path.join(dist, "Ward.exe");

const step = (msg) => console.log(`\n> ${msg}`);

if (process.platform !== "win32") throw new Error("Build the exe on Windows (League only runs there).");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(dist, { recursive: true });

step("Building the phone UI");
execSync("npm run build -w web", { cwd: root, stdio: "inherit" });

step("Bundling the connector");
await build({
  entryPoints: [path.join(root, "connector", "src", "main.ts")],
  outfile: path.join(out, "connector.cjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  // Optional native speed-ups that ws tries to load; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  legalComments: "eof",
  logLevel: "warning",
});

step("Writing the SEA config");
function walk(dir, base = dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, files);
    else files.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return files;
}
const uiFiles = walk(webDist);
if (!uiFiles.includes("index.html")) throw new Error("web/dist/index.html is missing; the UI build failed.");
writeFileSync(path.join(out, "ui-manifest.json"), JSON.stringify(uiFiles));
const assets = { "ui-manifest.json": path.join(out, "ui-manifest.json") };
for (const rel of uiFiles) assets[`ui/${rel}`] = path.join(webDist, rel);
writeFileSync(
  path.join(out, "sea-config.json"),
  JSON.stringify(
    {
      main: path.join(out, "connector.cjs"),
      output: path.join(out, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  ),
);
console.log(`  ${uiFiles.length} UI files embedded`);

step("Creating the SEA blob");
execFileSync(process.execPath, ["--experimental-sea-config", path.join(out, "sea-config.json")], { stdio: "inherit" });

step("Injecting into a copy of node.exe");
rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules", "postject", "dist", "cli.js"),
    exe,
    "NODE_SEA_BLOB",
    path.join(out, "sea-prep.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit" },
);

const mb = (statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(`\nDone: ${path.relative(root, exe)} (${mb} MB)`);
