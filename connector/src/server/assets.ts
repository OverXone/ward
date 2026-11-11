/**
 * The phone UI files, loaded once into memory.
 *
 * - Inside the packaged exe: Node SEA assets (`ui-manifest.json` lists the files).
 * - In development: the Vite build output in web/dist.
 *
 * Only files in this in-memory map can ever be served, so there is no path traversal.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as sea from "node:sea";

export interface StaticFile {
  contentType: string;
  body: Buffer;
  immutable: boolean;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
};

function typeFor(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

const PLACEHOLDER = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ward</title></head>
<body><h1>Ward is running</h1><p>The phone UI hasn't been built yet. Run <code>npm run build:web</code>.</p></body></html>`;

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

export interface StaticFiles {
  get(urlPath: string): StaticFile | undefined;
}

/**
 * In the exe the files never change. In development, index.html requests re-read
 * web/dist so `npm run watch:web` rebuilds show up on a phone reload.
 */
export function staticFiles(): StaticFiles {
  let files = loadStaticFiles();
  if (sea.isSea()) return files;
  return {
    get(urlPath) {
      if (urlPath === "/index.html") files = loadStaticFiles();
      return files.get(urlPath);
    },
  };
}

export function loadStaticFiles(devDir = path.resolve(__dirname, "../../../web/dist")): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const add = (rel: string, body: Buffer) =>
    files.set("/" + rel, { contentType: typeFor(rel), body, immutable: rel.startsWith("assets/") });

  if (sea.isSea()) {
    const manifest = JSON.parse(sea.getAsset("ui-manifest.json", "utf8")) as string[];
    for (const rel of manifest) add(rel, Buffer.from(sea.getAsset(`ui/${rel}`)));
  } else {
    try {
      for (const rel of walk(devDir)) add(rel, readFileSync(path.join(devDir, rel)));
    } catch {
      // not built yet
    }
  }

  if (!files.has("/index.html")) add("index.html", Buffer.from(PLACEHOLDER));
  return files;
}
