import { describe, expect, it } from "vitest";
import { bearerToken, FailureLimiter, formatCode, generateToken, normalizeCode, Pairing, safeEqual } from "../src/server/auth";

describe("token", () => {
  it("is 32 random bytes in base64url and different each time", () => {
    const a = generateToken();
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it("compares safely, including different lengths", () => {
    const t = generateToken();
    expect(safeEqual(t, t)).toBe(true);
    expect(safeEqual(t, t.slice(0, -1))).toBe(false);
    expect(safeEqual(t, "")).toBe(false);
  });

  it("parses only well-formed bearer headers", () => {
    const t = generateToken();
    expect(bearerToken(`Bearer ${t}`)).toBe(t);
    expect(bearerToken(`bearer ${t}`)).toBeNull();
    expect(bearerToken(`Basic ${t}`)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Bearer short")).toBeNull();
  });
});

describe("Pairing", () => {
  it("issues 8-char codes that work exactly once", () => {
    const p = new Pairing();
    const code = p.issue();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(p.redeem(formatCode(code).toLowerCase())).toBe(true);
    expect(p.redeem(code)).toBe(false);
  });

  it("normalises look-alike characters", () => {
    expect(normalizeCode("abco-il 23")).toBe("ABC01123");
  });

  it("expires", () => {
    let now = 0;
    const p = new Pairing({ now: () => now, ttlMs: 1000 });
    const code = p.issue();
    now = 1000;
    expect(p.redeem(code)).toBe(false);
  });

  it("burns the code after 5 wrong attempts in total", () => {
    const p = new Pairing();
    const code = p.issue();
    for (let i = 0; i < 5; i++) expect(p.redeem("00000000")).toBe(false);
    expect(p.redeem(code)).toBe(false);
    expect(p.active).toBe(false);
  });

  it("rejects non-strings and oversized input without consuming attempts", () => {
    const p = new Pairing({ maxAttempts: 1 });
    const code = p.issue();
    expect(p.redeem(123)).toBe(false);
    expect(p.redeem("x".repeat(100))).toBe(false);
    expect(p.redeem(code)).toBe(true);
  });
});

describe("FailureLimiter", () => {
  it("locks an IP after N failures and unlocks after the window", () => {
    let now = 0;
    const l = new FailureLimiter(3, 1000, () => now);
    l.fail("10.0.0.2");
    l.fail("10.0.0.2");
    expect(l.isLocked("10.0.0.2")).toBe(false);
    l.fail("10.0.0.2");
    expect(l.isLocked("10.0.0.2")).toBe(true);
    expect(l.isLocked("10.0.0.3")).toBe(false);
    now = 1000;
    expect(l.isLocked("10.0.0.2")).toBe(false);
  });
});
