/**
 * Session token, one-time pairing codes and per-IP failure lockout.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison (hashing first makes lengths equal and hides length differences). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(header.trim());
  return m?.[1] ?? null;
}

// ---------- pairing codes ----------

// Crockford base32 without I, L, O, U: easy to read off a screen and type on a phone.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface PairingOptions {
  ttlMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

/**
 * One active code at a time: valid for ttlMs, single use, and invalidated after
 * maxAttempts wrong guesses *in total* (not per IP), so spreading guesses over
 * many addresses doesn't help. 32^8 ≈ 10^12 codes vs. 5 guesses.
 */
export class Pairing {
  private code: string | null = null;
  private expiresAt = 0;
  private attemptsLeft = 0;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(opts: PairingOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.now = opts.now ?? Date.now;
  }

  /** Creates a fresh code (replacing any previous one). Returns it unformatted. */
  issue(): string {
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    this.code = code;
    this.expiresAt = this.now() + this.ttlMs;
    this.attemptsLeft = this.maxAttempts;
    return code;
  }

  get active(): boolean {
    return this.code !== null && this.now() < this.expiresAt && this.attemptsLeft > 0;
  }

  /** Returns true exactly once for the right code; burns the code on success or on the last failed attempt. */
  redeem(input: unknown): boolean {
    if (typeof input !== "string" || input.length > 32 || !this.active || !this.code) return false;
    const ok = safeEqual(normalizeCode(input), this.code);
    if (ok) {
      this.code = null;
      return true;
    }
    this.attemptsLeft--;
    if (this.attemptsLeft <= 0) this.code = null;
    return false;
  }
}

// ---------- failure lockout ----------

export class FailureLimiter {
  private failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly lockMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isLocked(ip: string): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (f.lockedUntil && this.now() >= f.lockedUntil) {
      this.failures.delete(ip);
      return false;
    }
    return f.lockedUntil > 0;
  }

  fail(ip: string): void {
    const f = this.failures.get(ip) ?? { count: 0, lockedUntil: 0 };
    f.count++;
    if (f.count >= this.maxFailures) f.lockedUntil = this.now() + this.lockMs;
    this.failures.set(ip, f);
    if (this.failures.size > 1000) this.failures.clear(); // bounded memory
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}
