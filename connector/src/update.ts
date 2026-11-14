/**
 * Self-update for the packaged Ward.exe.
 *
 * Each GitHub release carries Ward.exe and ward-update.json:
 *   { "version": "0.4.0", "sha256": "<hex>", "size": 93000000, "signature": "<base64 ed25519>" }
 * The signature covers version, hash and size (see `signedMessage`), made with a private key that
 * only the release workflow has. The matching public key is built into every exe, so a download is
 * installed only if it is exactly the file the release was signed for. A hijacked download link or
 * release can't push code to anyone, and an older release can't be passed off as a newer one.
 *
 * Installing: Windows won't let a running exe be overwritten, but it can be renamed. So
 *   Ward.exe -> Ward.exe.old, Ward.exe.new -> Ward.exe, start the new Ward.exe, exit.
 * The new copy deletes Ward.exe.old. If a rename fails, the old file is put back, so the worst
 * case is "still on the old version", never "no Ward.exe".
 */

import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createWriteStream, existsSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/** ed25519 public key (SPKI DER, base64) of the release signing key. */
export const UPDATE_PUBLIC_KEY = "MCowBQYDK2VwAyEAMT6Ca1yl0lraDq2EuWcyBuSWhokxk+U4LyQgqbR4ueo=";

const REPO = "https://github.com/OverXone/ward";
export const MANIFEST_URL = `${REPO}/releases/latest/download/ward-update.json`;
/** The exe from the same release as the manifest (not "latest", which could move in between). */
export const exeUrl = (version: string) => `${REPO}/releases/download/v${version}/Ward.exe`;

/** Set on the restarted process so it skips the check it would otherwise do right away. */
export const JUST_UPDATED_ENV = "WARD_JUST_UPDATED";

const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_STALL_MS = 60_000;
const MAX_SIZE = 400 * 1024 * 1024;

export interface UpdateManifest {
  version: string;
  sha256: string;
  size: number;
  signature: string;
}

type Fetch = typeof fetch;

export function signedMessage(m: Pick<UpdateManifest, "version" | "sha256" | "size">): Buffer {
  return Buffer.from(`ward-update-v1\n${m.version}\n${m.sha256}\n${m.size}\n`, "utf8");
}

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/** Compares "x.y.z" versions: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (!pa || !pb) throw new Error(`Not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  return 0;
}

/** The manifest if it's well formed and signed by the release key, else null. */
export function parseManifest(raw: unknown, publicKey = UPDATE_PUBLIC_KEY): UpdateManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const { version, sha256, size, signature } = raw as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_SIZE) return null;
  if (typeof signature !== "string") return null;
  const m = { version, sha256, size, signature };
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return verify(null, signedMessage(m), key, Buffer.from(signature, "base64")) ? m : null;
  } catch {
    return null;
  }
}

function headers(current: string): Record<string, string> {
  return { "User-Agent": `Ward/${current}`, Accept: "application/octet-stream, application/json" };
}

export type CheckResult =
  | { kind: "update"; manifest: UpdateManifest }
  | { kind: "current" }
  | { kind: "error"; message: string };

/** Asks GitHub for the latest release's signed manifest. Never throws. */
export async function checkForUpdate(opts: {
  current: string;
  fetch?: Fetch;
  url?: string;
  publicKey?: string;
}): Promise<CheckResult> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(opts.url ?? MANIFEST_URL, {
      headers: headers(opts.current),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // No release has a manifest yet (older releases didn't): nothing to update to.
    if (res.status === 404) return { kind: "current" };
    if (!res.ok) return { kind: "error", message: `GitHub answered ${res.status}` };
    const text = await res.text();
    if (text.length > 10_000) return { kind: "error", message: "the update info is too large" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: "error", message: "the update info isn't valid JSON" };
    }
    const manifest = parseManifest(json, opts.publicKey);
    if (!manifest) return { kind: "error", message: "the update info isn't signed by Ward's release key" };
    return compareVersions(manifest.version, opts.current) > 0 ? { kind: "update", manifest } : { kind: "current" };
  } catch (e) {
    const err = e as Error;
    const message = err.name === "TimeoutError" ? "no answer from GitHub" : err.message;
    return { kind: "error", message };
  }
}

/**
 * Downloads the release's exe to `dest`, checking size and SHA-256 as it streams.
 * On any failure `dest` is deleted and the error is thrown.
 */
export async function downloadUpdate(opts: {
  manifest: UpdateManifest;
  dest: string;
  current: string;
  fetch?: Fetch;
  url?: string;
  onProgress?: (percent: number) => void;
}): Promise<void> {
  const { manifest, dest } = opts;
  const doFetch = opts.fetch ?? fetch;
  const abort = new AbortController();
  let stall = setTimeout(() => abort.abort(), DOWNLOAD_STALL_MS);
  try {
    const res = await doFetch(opts.url ?? exeUrl(manifest.version), { headers: headers(opts.current), signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
    const hash = createHash("sha256");
    let received = 0;
    let lastStep = -1;
    const check = new Transform({
      transform(chunk: Buffer, _enc, done) {
        clearTimeout(stall);
        stall = setTimeout(() => abort.abort(), DOWNLOAD_STALL_MS);
        received += chunk.length;
        if (received > manifest.size) return done(new Error("the download is larger than the release says"));
        hash.update(chunk);
        const step = Math.floor((received / manifest.size) * 10);
        if (step !== lastStep) {
          lastStep = step;
          opts.onProgress?.(step * 10);
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), check, createWriteStream(dest));
    if (received !== manifest.size) throw new Error("the download is incomplete");
    if (hash.digest("hex") !== manifest.sha256) throw new Error("the download doesn't match the signed release");
  } catch (e) {
    rmSync(dest, { force: true });
    if (abort.signal.aborted) throw new Error("the download stalled");
    throw e;
  } finally {
    clearTimeout(stall);
  }
}

/**
 * Puts `newFile` where `exe` is: exe -> exe.old, newFile -> exe. Works while `exe` is running.
 * Throws (with `exe` back in place) if either rename fails.
 */
export function swapInPlace(exe: string, newFile: string, rename: (from: string, to: string) => void = renameSync): void {
  const old = `${exe}.old`;
  rmSync(old, { force: true });
  rename(exe, old);
  try {
    rename(newFile, exe);
  } catch (e) {
    rename(old, exe);
    throw e;
  }
}

/** Deletes what an update left behind. The old process may still be exiting, so retry a while. */
export function cleanUpAfterUpdate(exe: string, tries = 20, delayMs = 250): void {
  rmSync(`${exe}.new`, { force: true });
  const old = `${exe}.old`;
  const attempt = (left: number) => {
    if (!existsSync(old)) return;
    try {
      unlinkSync(old);
    } catch {
      if (left > 1) setTimeout(() => attempt(left - 1), delayMs).unref();
    }
  };
  attempt(tries);
}

/** cmd.exe quoting for the `start` line. Null if an argument can't be passed through safely. */
function cmdQuote(arg: string): string | null {
  return /["%^\r\n]/.test(arg) ? null : `"${arg}"`;
}

/**
 * Starts `exe` in a new console window. Goes through `start` so it gets a window of its own
 * (a window this process has closes when this process exits).
 * Returns false if the arguments can't be passed on safely; the caller asks the user to restart.
 */
export function openInNewWindow(exe: string, args: readonly string[], env: Record<string, string> = {}): boolean {
  const quoted = [exe, ...args].map(cmdQuote);
  if (quoted.some((q) => q === null)) return false;
  const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"start "Ward" ${quoted.join(" ")}"`], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
    env: { ...process.env, ...env },
  });
  child.unref();
  return true;
}

/** Starts `exe` with no window at all (the background Ward). */
export function startInBackground(exe: string, args: readonly string[], env: Record<string, string> = {}): void {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (!(JUST_UPDATED_ENV in env)) delete childEnv[JUST_UPDATED_ENV];
  spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true, env: childEnv }).unref();
}
