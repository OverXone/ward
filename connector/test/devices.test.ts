import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Pairing } from "../src/server/auth";
import { Devices, phoneName } from "../src/server/devices";

const DAY = 86_400_000;
let dir = "";
const tmpFile = () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ward-test-"));
  return path.join(dir, "phones.json");
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("Devices", () => {
  it("remembers a phone across restarts and saves only a hash of its key", () => {
    const file = tmpFile();
    const { key } = new Devices({ file }).add("iPhone · Safari");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(key);
    const again = new Devices({ file });
    expect(again.verify(key)?.name).toBe("iPhone · Safari");
    expect(again.verify(key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(again.verify(undefined)).toBeNull();
    expect(again.verify(123)).toBeNull();
  });

  it("forgets phones unused for 30 days", () => {
    let now = 1_000_000;
    const d = new Devices({ file: null, now: () => now });
    const { key } = d.add("old");
    now += 29 * DAY;
    expect(d.verify(key)).not.toBeNull(); // using it resets the clock
    now += 31 * DAY;
    expect(d.verify(key)).toBeNull();
    expect(d.list()).toHaveLength(0);
  });

  it("prunes expired phones when loading", () => {
    const file = tmpFile();
    let now = 0;
    new Devices({ file, now: () => now }).add("old");
    now = 31 * DAY;
    expect(new Devices({ file, now: () => now }).list()).toHaveLength(0);
  });

  it("replaces the entry when a phone pairs again with its old key", () => {
    const d = new Devices({ file: null });
    const first = d.add("phone");
    const second = d.add("phone", first.key);
    expect(d.list()).toHaveLength(1);
    expect(d.verify(first.key)).toBeNull();
    expect(d.verify(second.key)).not.toBeNull();
  });

  it("keeps at most `max` phones, dropping the least recently used", () => {
    let now = 0;
    const d = new Devices({ file: null, max: 2, now: () => now++ });
    const a = d.add("a");
    d.add("b");
    d.verify(a.key);
    const removed: string[][] = [];
    d.on("removed", (ids) => removed.push(ids));
    d.add("c");
    expect(d.list().map((p) => p.name)).toEqual(["c", "a"]);
    expect(removed).toHaveLength(1);
  });

  it("removes one or all phones and reports which", () => {
    const d = new Devices({ file: null });
    const a = d.add("a");
    d.add("b");
    const removed: string[][] = [];
    d.on("removed", (ids) => removed.push(ids));
    expect(d.remove(a.id)).toBe(true);
    expect(d.remove(a.id)).toBe(false);
    expect(d.clear()).toBe(1);
    expect(removed.map((r) => r.length)).toEqual([1, 1]);
  });

  it("remembers the last address", () => {
    const file = tmpFile();
    const d = new Devices({ file });
    expect(d.previousAddress).toBeUndefined();
    d.rememberAddress("10.0.0.38:47800");
    expect(new Devices({ file }).previousAddress).toBe("10.0.0.38:47800");
  });

  it("starts empty from a damaged file and keeps it as .bad", () => {
    const file = tmpFile();
    writeFileSync(file, "{not json");
    expect(new Devices({ file }).list()).toHaveLength(0);
    expect(existsSync(`${file}.bad`)).toBe(true);
  });

  it("ignores malformed entries", () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ version: 1, phones: [{ id: "x", name: "n", hash: "zz", createdAt: 0, lastSeenAt: 0 }, null] }));
    expect(new Devices({ file }).list()).toHaveLength(0);
  });
});

describe("phoneName", () => {
  it("names common phones and browsers", () => {
    expect(phoneName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe(
      "iPhone · Safari",
    );
    expect(phoneName("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36")).toBe("Android · Chrome");
    expect(phoneName("Mozilla/5.0 (Linux; Android 14; SM-S918B) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36")).toBe(
      "Android · Samsung Internet",
    );
    expect(phoneName(undefined)).toBe("Phone");
  });
});

describe("Pairing QR ticket", () => {
  it("works exactly once and is replaced by a new one", () => {
    const p = new Pairing();
    const t1 = p.issueTicket();
    const t2 = p.issueTicket();
    expect(p.redeemTicket(t1)).toBe(false);
    expect(p.redeemTicket(t2)).toBe(true);
    expect(p.redeemTicket(t2)).toBe(false);
    expect(p.ticketActive).toBe(false);
  });

  it("rejects malformed input", () => {
    const p = new Pairing();
    p.issueTicket();
    for (const bad of [undefined, 5, "", "x".repeat(43), "x".repeat(200)]) expect(p.redeemTicket(bad)).toBe(false);
    expect(p.ticketActive).toBe(true);
  });
});
