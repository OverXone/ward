import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkForUpdate,
  cleanUpAfterUpdate,
  compareVersions,
  downloadUpdate,
  parseManifest,
  signedMessage,
  swapInPlace,
  type UpdateManifest,
} from "../src/update";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const other = generateKeyPairSync("ed25519");

function manifestFor(body: Buffer, version: string, key = keys.privateKey): UpdateManifest {
  const m = { version, sha256: createHash("sha256").update(body).digest("hex"), size: body.length };
  return { ...m, signature: sign(null, signedMessage(m), key).toString("base64") };
}

/** A fetch that answers every request with `body` (or the given status). */
function fakeFetch(body: string | Buffer, status = 200): typeof fetch {
  return (async () => new Response(status === 200 ? new Uint8Array(Buffer.from(body)) : null, { status })) as typeof fetch;
}

const exe = Buffer.from("pretend this is Ward.exe 0.4.0");

describe("compareVersions", () => {
  it("compares numerically, part by part", () => {
    expect(compareVersions("0.4.0", "0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.3.0", "0.3.1")).toBeLessThan(0);
  });

  it("rejects anything that isn't x.y.z", () => {
    expect(() => compareVersions("v0.4.0", "0.3.0")).toThrow();
    expect(() => compareVersions("0.4", "0.3.0")).toThrow();
  });
});

describe("parseManifest", () => {
  it("accepts a manifest signed by the release key", () => {
    const m = manifestFor(exe, "0.4.0");
    expect(parseManifest(m, publicKey)).toEqual(m);
  });

  it("rejects a manifest signed by another key", () => {
    expect(parseManifest(manifestFor(exe, "0.4.0", other.privateKey), publicKey)).toBeNull();
  });

  it("rejects a signed manifest whose version, hash or size was changed", () => {
    const m = manifestFor(exe, "0.4.0");
    expect(parseManifest({ ...m, version: "9.0.0" }, publicKey)).toBeNull();
    expect(parseManifest({ ...m, sha256: "0".repeat(64) }, publicKey)).toBeNull();
    expect(parseManifest({ ...m, size: m.size + 1 }, publicKey)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseManifest(null, publicKey)).toBeNull();
    expect(parseManifest({ ...manifestFor(exe, "0.4.0"), signature: 5 }, publicKey)).toBeNull();
    expect(parseManifest({ ...manifestFor(exe, "0.4.0"), signature: "not base64!" }, publicKey)).toBeNull();
  });
});

describe("checkForUpdate", () => {
  const check = (f: typeof fetch, current = "0.3.0") => checkForUpdate({ current, fetch: f, publicKey });

  it("reports a newer signed release", async () => {
    const m = manifestFor(exe, "0.4.0");
    expect(await check(fakeFetch(JSON.stringify(m)))).toEqual({ kind: "update", manifest: m });
  });

  it("says current for the same or an older release", async () => {
    expect(await check(fakeFetch(JSON.stringify(manifestFor(exe, "0.3.0"))))).toEqual({ kind: "current" });
    expect(await check(fakeFetch(JSON.stringify(manifestFor(exe, "0.2.0"))))).toEqual({ kind: "current" });
  });

  it("says current when the latest release has no manifest (404)", async () => {
    expect(await check(fakeFetch("", 404))).toEqual({ kind: "current" });
  });

  it("reports an error, never an update, for unsigned or broken answers", async () => {
    expect((await check(fakeFetch(JSON.stringify(manifestFor(exe, "0.4.0", other.privateKey))))).kind).toBe("error");
    expect((await check(fakeFetch("<html>"))).kind).toBe("error");
    expect((await check(fakeFetch("", 500))).kind).toBe("error");
    expect((await check((async () => Promise.reject(new Error("offline"))) as typeof fetch)).kind).toBe("error");
  });
});

describe("downloadUpdate and swapInPlace", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setup = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ward-update-"));
    const current = path.join(dir, "Ward.exe");
    writeFileSync(current, "old ward");
    return { current, next: `${current}.new` };
  };

  it("downloads, verifies and swaps the new exe in, keeping the old one aside", async () => {
    const { current, next } = setup();
    const progress: number[] = [];
    await downloadUpdate({
      manifest: manifestFor(exe, "0.4.0"),
      dest: next,
      current: "0.3.0",
      fetch: fakeFetch(exe),
      onProgress: (p) => progress.push(p),
    });
    expect(progress.at(-1)).toBe(100);
    swapInPlace(current, next);
    expect(readFileSync(current)).toEqual(exe);
    expect(readFileSync(`${current}.old`, "utf8")).toBe("old ward");
    expect(existsSync(next)).toBe(false);
  });

  it("deletes the download and throws when it doesn't match the manifest", async () => {
    const { next } = setup();
    const tampered = Buffer.from("pretend this is Ward.exe 0.4.X");
    await expect(
      downloadUpdate({ manifest: manifestFor(exe, "0.4.0"), dest: next, current: "0.3.0", fetch: fakeFetch(tampered) }),
    ).rejects.toThrow(/doesn't match/);
    expect(existsSync(next)).toBe(false);
  });

  it("rejects a download that is longer or shorter than the manifest says", async () => {
    const { next } = setup();
    const manifest = manifestFor(exe, "0.4.0");
    const opts = { manifest, dest: next, current: "0.3.0" };
    await expect(downloadUpdate({ ...opts, fetch: fakeFetch(Buffer.concat([exe, exe])) })).rejects.toThrow(/larger/);
    await expect(downloadUpdate({ ...opts, fetch: fakeFetch(exe.subarray(1)) })).rejects.toThrow(/incomplete/);
    await expect(downloadUpdate({ ...opts, fetch: fakeFetch("", 404) })).rejects.toThrow(/HTTP 404/);
    expect(existsSync(next)).toBe(false);
  });

  it("puts the old exe back when the second rename fails", () => {
    const { current, next } = setup();
    writeFileSync(next, "new ward");
    let calls = 0;
    const flaky = (from: string, to: string) => {
      if (++calls === 2) throw new Error("EBUSY");
      renameSync(from, to);
    };
    expect(() => swapInPlace(current, next, flaky)).toThrow("EBUSY");
    expect(readFileSync(current, "utf8")).toBe("old ward");
  });

  it("cleans up what an update left behind", () => {
    const { current, next } = setup();
    writeFileSync(`${current}.old`, "x");
    writeFileSync(next, "x");
    cleanUpAfterUpdate(current);
    expect(existsSync(`${current}.old`)).toBe(false);
    expect(existsSync(next)).toBe(false);
    expect(existsSync(current)).toBe(true);
  });
});
