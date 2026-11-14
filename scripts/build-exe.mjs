/**
 * Builds dist/Ward.exe: one file with Node, the connector and the phone UI inside.
 *
 *   npm run build:exe
 *
 * 1. vite build          -> web/dist
 * 2. esbuild             -> build/connector.cjs (one CommonJS file, as Node SEA requires)
 *    csc (.NET Framework, ships with Windows) -> build/ward-tray.exe, the tray icon helper (tray/WardTray.cs)
 * 3. sea-config.json     -> the script, the tray helper and every web/dist file as SEA assets (sea.getAsset)
 * 4. node --experimental-sea-config -> build/sea-prep.blob
 * 5. copy node.exe with Ward's version info and icon (resedit), postject the blob in -> dist/Ward.exe
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { ico } from "./logo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build");
const dist = path.join(root, "dist");
const webDist = path.join(root, "web", "dist");
const exe = path.join(dist, "Ward.exe");

const step = (msg) => console.log(`\n> ${msg}`);
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

/**
 * Copies node.exe to `dest` with Ward's own version info and icon, so Windows (firewall prompt,
 * Task Manager, file properties) shows "Ward" instead of "Node.js JavaScript Runtime".
 * Done before postject: resource editors can break an exe that already has the SEA blob in it.
 * Node's Authenticode signature is dropped; it would be invalid after the injection anyway.
 */
function brand(src, dest) {
  const exe = NtExecutable.from(readFileSync(src), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const [major, minor, patch] = version.split(".").map(Number);
  const info = Resource.VersionInfo.fromEntries(res.entries)[0];
  if (!info) throw new Error("node.exe has no version info to replace");
  info.setFileVersion(major, minor, patch, 0);
  info.setProductVersion(major, minor, patch, 0);
  for (const lang of info.getAllLanguagesForStringValues()) {
    info.removeAllStringValues(lang, false);
    info.setStringValues(lang, {
      FileDescription: "Ward",
      ProductName: "Ward",
      CompanyName: "OverXone",
      LegalCopyright: "Copyright (c) 2026 OverXone. PolyForm Noncommercial 1.0.0. Includes Node.js (MIT).",
      OriginalFilename: "Ward.exe",
      InternalName: "Ward",
      FileVersion: version,
      ProductVersion: version,
      Comments: "Control the League of Legends client from your phone over your local Wi-Fi. Not endorsed by Riot Games.",
    });
  }
  info.outputToResourceEntries(res.entries);

  const icon = Data.IconFile.from(ico());
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const group = groups[0] ?? { id: 1, lang: 1033 };
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    group.id,
    group.lang,
    icon.icons.map((i) => i.data),
  );

  // allowShrink: our icon is smaller than Node's. Without it the resource section keeps its old file
  // size while its memory size shrinks, and postject then misreads the relocation table after it.
  res.outputResource(exe, false, true);
  writeFileSync(dest, Buffer.from(exe.generate()));
}

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
  // The version the self-updater compares releases against (connector/src/version.ts).
  define: { __WARD_VERSION__: JSON.stringify(version) },
  legalComments: "eof",
  logLevel: "warning",
});

step("Compiling the tray icon helper");
// The C# compiler of .NET Framework 4, which every Windows 10/11 has (and so do GitHub's runners).
const csc = path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const trayExe = path.join(out, "ward-tray.exe");
const trayIcon = path.join(out, "ward.ico");
const trayVersion = path.join(out, "TrayVersion.cs");
writeFileSync(trayIcon, ico());
writeFileSync(
  trayVersion,
  `[assembly: System.Reflection.AssemblyVersion("${version}.0")]\n[assembly: System.Reflection.AssemblyFileVersion("${version}.0")]\n`,
);
execFileSync(
  csc,
  [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    `/out:${trayExe}`,
    `/win32icon:${trayIcon}`,
    "/r:System.Windows.Forms.dll",
    "/r:System.Drawing.dll",
    path.join(root, "tray", "WardTray.cs"),
    trayVersion,
  ],
  { stdio: "inherit" },
);
console.log(`  ${(statSync(trayExe).size / 1024).toFixed(0)} KB`);

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
const assets = { "ui-manifest.json": path.join(out, "ui-manifest.json"), "ward-tray.exe": trayExe };
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

step("Copying node.exe and giving it Ward's name, version and icon");
rmSync(exe, { force: true });
brand(process.execPath, exe);

step("Injecting the app into the exe");
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

step("Making Ward.exe a Windows app (no console window; the Ward window comes from the tray helper)");
{
  const body = readFileSync(exe);
  const pe = body.readUInt32LE(0x3c);
  if (body.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("Ward.exe isn't a PE file");
  // IMAGE_OPTIONAL_HEADER.Subsystem, at the same offset in PE32 and PE32+: 3 = console, 2 = GUI.
  const subsystem = pe + 24 + 68;
  if (body.readUInt16LE(subsystem) !== 3) throw new Error("Ward.exe isn't a console program as expected");
  body.writeUInt16LE(2, subsystem);
  writeFileSync(exe, body);
}

const mb = (statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(`\nDone: ${path.relative(root, exe)} (${mb} MB)`);
