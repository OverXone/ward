/**
 * Which champions I can play: owned, rented, or free this week / for this queue.
 *
 * The ARAM bench lists every champion nobody took, and League only lets me swap for one I'm allowed
 * to pick (the PC shows the others with a lock). The session doesn't say which those are. League's
 * pickable list does, and it's the main source (see benchAllowed); ownership from the champion grid
 * fills in when that list is missing, e.g. when Ward connects in the middle of champ select.
 *
 * Endpoints (from the client's own API list):
 * - /lol-champ-select/v1/all-grid-champions   per champion: owned, rented, freeToPlay, freeToPlayForQueue, ...
 * - /lol-champions/v1/owned-champions-minimal  fallback: ownership.owned, ownership.rental.rented, freeToPlay
 */

import type { LcuHttp } from "./lcu/http";

export const GRID_PATH = "/lol-champ-select/v1/all-grid-champions";
export const OWNED_PATH = "/lol-champions/v1/owned-champions-minimal";

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const yes = (v: unknown) => v === true;

interface RawGridChampion {
  id?: unknown;
  owned?: unknown;
  rented?: unknown;
  freeToPlay?: unknown;
  freeToPlayForQueue?: unknown;
  loyaltyReward?: unknown;
  xboxGPReward?: unknown;
}

interface RawOwnedChampion {
  id?: unknown;
  freeToPlay?: unknown;
  ownership?: { owned?: unknown; freeToPlayReward?: unknown; xboxGPReward?: unknown; loyaltyReward?: unknown; rental?: { rented?: unknown } };
}

/** Grid entries say outright whether I can play each champion. Null if this isn't such a list. */
export function playableFromGrid(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter((c): c is RawGridChampion => !!c && typeof c === "object" && isId((c as RawGridChampion).id));
  // Without an "owned" flag on any entry this isn't telling us about ownership at all.
  if (!rows.some((c) => typeof c.owned === "boolean")) return null;
  return rows
    .filter((c) => yes(c.owned) || yes(c.rented) || yes(c.freeToPlay) || yes(c.freeToPlayForQueue) || yes(c.loyaltyReward) || yes(c.xboxGPReward))
    .map((c) => c.id as number);
}

export function playableFromOwned(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((c): c is RawOwnedChampion => !!c && typeof c === "object" && isId((c as RawOwnedChampion).id))
    .filter((c) => {
      const o = c.ownership ?? {};
      return yes(o.owned) || yes(o.rental?.rented) || yes(o.freeToPlayReward) || yes(o.loyaltyReward) || yes(o.xboxGPReward) || yes(c.freeToPlay);
    })
    .map((c) => c.id as number);
}

/**
 * The champions I can play, and where that came from, or null when the client won't say.
 * An empty answer counts as "won't say": everyone can play some champion, so locking every
 * bench slot on a bad answer would be worse than letting League refuse.
 */
export async function readPlayableChampions(http: LcuHttp): Promise<{ ids: Set<number>; source: string } | null> {
  const grid = playableFromGrid(await http.getOrNull(GRID_PATH));
  if (grid?.length) return { ids: new Set(grid), source: "champion grid" };
  const owned = playableFromOwned(await http.getOrNull(OWNED_PATH));
  if (owned?.length) return { ids: new Set(owned), source: "owned champions" };
  return null;
}

/**
 * The bench champions I can swap for: what League's pickable list says, plus what I can play.
 * ARAM's pickable list adds champions I don't own (live, 2026-11-20: 107 pickable with 63 owned or
 * free), and the PC's bench lock follows it; ownership alone locked some the PC allowed. Either
 * source alone counts when the other is missing. Null when neither is known: then nothing is locked.
 */
export function benchAllowed(pickable: readonly number[] | null | undefined, playable: ReadonlySet<number> | null | undefined): ReadonlySet<number> | null {
  if (!pickable?.length) return playable?.size ? playable : null;
  return new Set([...pickable, ...(playable ?? [])]);
}
