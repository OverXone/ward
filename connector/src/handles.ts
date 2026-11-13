/**
 * Opaque handles for League objects the phone needs to point at (invitations, friends).
 *
 * The phone never sees or sends an LCU id: it gets a random handle per object, the connector maps
 * it back, and the action then re-checks that object against a fresh list from the client.
 * Handles are random per connector run (and per League connection), so they mean nothing anywhere else.
 */

import { randomBytes } from "node:crypto";

export type HandleKind = "invite" | "friend";
type Key = string | number;

const MAX = 2000;
export const HANDLE_RE = /^[A-Za-z0-9_-]{12}$/;

export class Handles {
  private toHandle = new Map<string, string>();
  private toKey = new Map<string, { kind: HandleKind; key: Key }>();

  /** The handle for this object, the same one every time it's asked for. */
  handle(kind: HandleKind, key: Key): string {
    const k = `${kind}:${typeof key}:${key}`;
    let h = this.toHandle.get(k);
    if (h) return h;
    if (this.toHandle.size >= MAX) this.clear();
    h = randomBytes(9).toString("base64url");
    this.toHandle.set(k, h);
    this.toKey.set(h, { kind, key });
    return h;
  }

  /** The object a handle from the phone stands for, or null (unknown, wrong kind or malformed). */
  resolve(kind: HandleKind, handle: unknown): Key | null {
    if (typeof handle !== "string" || !HANDLE_RE.test(handle)) return null;
    const entry = this.toKey.get(handle);
    return entry && entry.kind === kind ? entry.key : null;
  }

  clear(): void {
    this.toHandle.clear();
    this.toKey.clear();
  }
}
