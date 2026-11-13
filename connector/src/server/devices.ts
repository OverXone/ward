/**
 * Phones this PC remembers, so a paired phone reconnects by itself after Ward restarts.
 *
 * Each phone gets its own random 32-byte key when it pairs. Only a SHA-256 hash of the key is
 * saved (the key is random, so a fast hash is enough), in %APPDATA%\Ward\phones.json. A phone
 * that hasn't connected for 30 days is forgotten; phones can also be removed from the Ward
 * window or from the phone itself.
 *
 * The same file remembers the address Ward last listened on, to notice when it changes
 * (the phone's saved key belongs to the old http://ip:port, so it has to pair once more).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../log";
import { generateToken } from "./auth";

export interface Phone {
  id: string;
  name: string;
  hash: string; // sha256(key), hex
  createdAt: number;
  lastSeenAt: number;
}

interface FileShape {
  version: 1;
  address?: string;
  phones: Phone[];
}

export interface DevicesOptions {
  /** null keeps everything in memory (tests). */
  file: string | null;
  now?: () => number;
  maxIdleMs?: number;
  max?: number;
}

const DAY = 24 * 60 * 60_000;
const SEEN_WRITE_INTERVAL = 60 * 60_000; // don't rewrite the file on every request

const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest();

export function defaultDataDir(): string {
  return process.env.WARD_DATA_DIR || path.join(process.env.APPDATA || os.homedir(), "Ward");
}

function isPhone(p: unknown): p is Phone {
  const r = p as Phone;
  return (
    !!r &&
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.hash === "string" &&
    /^[0-9a-f]{64}$/.test(r.hash) &&
    Number.isFinite(r.createdAt) &&
    Number.isFinite(r.lastSeenAt)
  );
}

/** "iPhone · Safari", "Android · Chrome", ... from a User-Agent header. Only for showing in the window. */
export function phoneName(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac or iPad"
          : /Windows/.test(ua)
            ? "Windows PC"
            : "Phone";
  const browser = /EdgA?\/|EdgiOS/.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /OPR\/|OPT\//.test(ua)
        ? "Opera"
        : /FxiOS|Firefox/.test(ua)
          ? "Firefox"
          : /CriOS|Chrome/.test(ua)
            ? "Chrome"
            : /Safari/.test(ua)
              ? "Safari"
              : null;
  return browser ? `${device} · ${browser}` : device;
}

export class Devices extends EventEmitter<{ removed: [ids: string[]] }> {
  private phones: Phone[] = [];
  private lastAddress: string | undefined;
  private readonly file: string | null;
  private readonly now: () => number;
  private readonly maxIdleMs: number;
  private readonly max: number;

  constructor(opts: DevicesOptions) {
    super();
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.maxIdleMs = opts.maxIdleMs ?? 30 * DAY;
    this.max = opts.max ?? 10;
    this.load();
    if (this.prune()) this.save();
  }

  /** Remembers a new phone and returns its key (sent to the phone once, never stored or logged). */
  add(name: string, replacingKey?: unknown): { id: string; key: string } {
    // Re-pairing the same phone (it sends its old key) replaces its entry instead of adding one.
    if (typeof replacingKey === "string") {
      const old = this.verify(replacingKey, false);
      if (old) this.remove(old.id);
    }
    const key = generateToken();
    const t = this.now();
    const phone: Phone = {
      id: randomBytes(6).toString("hex"),
      name: name.replace(/[^\x20-\x7e·]/g, "").slice(0, 40) || "Phone",
      hash: hashKey(key).toString("hex"),
      createdAt: t,
      lastSeenAt: t,
    };
    this.phones.push(phone);
    // Over the limit: forget the ones unused the longest.
    if (this.phones.length > this.max) {
      const dropped = this.sorted().slice(this.max).map((p) => p.id);
      this.phones = this.phones.filter((p) => !dropped.includes(p.id));
      this.emit("removed", dropped);
    }
    this.save();
    return { id: phone.id, key };
  }

  /** The phone this key belongs to, or null. Compares against every entry in constant time. */
  verify(key: unknown, touch = true): Phone | null {
    if (typeof key !== "string" || key.length < 16 || key.length > 128) return null;
    const h = hashKey(key);
    let found: Phone | null = null;
    for (const p of this.phones) if (timingSafeEqual(h, Buffer.from(p.hash, "hex")) && !found) found = p;
    if (!found) return null;
    if (this.now() - found.lastSeenAt > this.maxIdleMs) {
      this.remove(found.id);
      return null;
    }
    if (touch) {
      const t = this.now();
      const stale = t - found.lastSeenAt > SEEN_WRITE_INTERVAL;
      found.lastSeenAt = t;
      if (stale) this.save();
    }
    return found;
  }

  remove(id: string): boolean {
    const before = this.phones.length;
    this.phones = this.phones.filter((p) => p.id !== id);
    if (this.phones.length === before) return false;
    this.save();
    this.emit("removed", [id]);
    return true;
  }

  clear(): number {
    const ids = this.phones.map((p) => p.id);
    this.phones = [];
    this.save();
    if (ids.length) this.emit("removed", ids);
    return ids.length;
  }

  /** Most recently used first. */
  list(): readonly Phone[] {
    return this.sorted();
  }

  /** The "ip:port" Ward listened on last time (before `rememberAddress` is called for this run). */
  get previousAddress(): string | undefined {
    return this.lastAddress;
  }

  rememberAddress(address: string): void {
    if (this.lastAddress === address) return;
    this.lastAddress = address;
    this.save();
  }

  private sorted(): Phone[] {
    return [...this.phones].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  private prune(): boolean {
    const t = this.now();
    const before = this.phones.length;
    this.phones = this.phones.filter((p) => t - p.lastSeenAt <= this.maxIdleMs);
    return this.phones.length !== before;
  }

  private load(): void {
    if (!this.file) return;
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return; // first run
    }
    try {
      const data = JSON.parse(text) as FileShape;
      this.phones = Array.isArray(data.phones) ? data.phones.filter(isPhone) : [];
      this.lastAddress = typeof data.address === "string" ? data.address : undefined;
    } catch {
      log.warn(`${this.file} is damaged; starting with no remembered phones (the old file is kept as .bad).`);
      try {
        renameSync(this.file, `${this.file}.bad`);
      } catch {
        // ignore
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    const data: FileShape = { version: 1, address: this.lastAddress, phones: this.phones };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      log.warn(`Couldn't save remembered phones to ${this.file}: ${(e as Error).message}`);
    }
  }
}
