/**
 * Game modes I could switch my lobby to, read from the League client on demand (GET /api/queues).
 *
 * Endpoints (from the client's own API list, 2026-11-14):
 * - GET  /lol-game-queues/v1/queues          every queue (LolGameQueuesQueue)
 * - POST /lol-lobby/v2/eligibility/party     which queues my party may play (LolLobbyEligibility[])
 * - POST /lol-lobby/v2/eligibility/self      the same for me alone, when I'm not in a lobby
 *
 * The eligibility calls are POSTs but only read: the client asks them itself to grey out its play menu.
 */

import type { LcuHttp } from "./lcu/http";
import type { QueueOption } from "./shared/phone-api";
import { URI, type RawLobby } from "./state/store";

export const QUEUES = "/lol-game-queues/v1/queues";

/** The subset of LolGameQueuesQueue we read. */
export interface RawQueue {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  shortName?: unknown;
  gameMode?: unknown;
  category?: unknown;
  queueAvailability?: unknown;
  isEnabled?: unknown;
  isVisible?: unknown;
  isCustom?: unknown;
  allowablePremadeSizes?: unknown;
}

export interface RawEligibility {
  queueId?: unknown;
  eligible?: unknown;
  restrictions?: { restrictionCode?: unknown }[];
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 100_000;

/** Restriction codes (LolLobbyEligibilityRestrictionCode) in words, most common first. */
const REASONS: [RegExp, string][] = [
  [/^(QueueDisabled|QueueUnsupported|SeasonVersionLockout|UnsupportedClientPlatform)$/, "Turned off right now"],
  [/^(TeamMaxSizeRestriction|TeamSizeRestriction|FullPartyUnranked|TooManyIncompleteSubteamsRestriction)$/, "Party too big for this mode"],
  [/^TeamMinSizeRestriction$/, "Needs a bigger party"],
  [/^(TeamDivisionRestriction|TeamSkillRestriction|TeamHighMMRMaxSizeRestriction|MmrStandardDeviationTooLarge|PlayerRankSoloOnlyRestriction)$/, "Party ranks too far apart"],
  [/^(PlayerLevelRestriction|PlayerMinLevelRestriction)$/, "Level too low"],
  [/^PlayerMaxLevelRestriction$/, "Level too high"],
  [/^PlayerAvailableChampionRestriction$/, "Needs more champions"],
  [/^(PrerequisiteQueuesNotPlayedRestriction|MinNormalGamesForRankedRestriction|LOLNewPlayerRestriction|TFTNewPlayerRestriction|PlayerTimePlayedRestriction)$/, "Play more games to unlock"],
  [/^(PlayerDodgeRestriction|PlayerLeaverQueueLockoutRestriction|PlayerTimedRestriction|PlayerQueueSuspendedRestriction|PlayerRankedSuspensionRestriction|PlayerBannedRestriction|PlayerBingeRestriction|PlayerDisruptiveGameplayLockoutRestriction|PlayerReadyCheckFailRestriction|PlayerLeaverBustedRestriction)$/, "Locked by a penalty"],
  [/^PlayerInGameRestriction$/, "Someone is in a game"],
  [/^PlayerMinorRestriction$/, "Not available on this account"],
];

/**
 * Codes that don't stop me from switching to the mode: warnings, and Quickplay's champion-slot
 * checks (those are about slots not chosen yet, which the PC sets after the switch).
 */
const SOFT = /^QP|Warning|^PlayerNoRankedUpdatesDueToRankDisparity$/;

function reasonFor(e: RawEligibility | undefined): string | null {
  if (!e || e.eligible !== false) return null;
  const codes = (Array.isArray(e.restrictions) ? e.restrictions : [])
    .map((r) => (typeof r?.restrictionCode === "string" ? r.restrictionCode : ""))
    .filter((c) => c && !SOFT.test(c));
  // eligible:false with only soft codes: League still lets me pick it.
  if (!codes.length && Array.isArray(e.restrictions) && e.restrictions.length) return null;
  for (const code of codes) {
    const hit = REASONS.find(([re]) => re.test(code));
    if (hit) return hit[1];
  }
  return "Not available right now";
}

function groupOf(q: RawQueue): QueueOption["group"] {
  if (q.gameMode === "TFT") return "Teamfight Tactics";
  return q.category === "VersusAi" ? "Co-op vs AI" : "PvP";
}

/** Usual play-menu order for the queues most people play; others follow alphabetically. */
const ORDER = [490, 480, 400, 420, 440, 450, 1700, 1710, 900, 1900, 870, 880, 890, 1090, 1100, 1160, 1130];
const rank = (id: number) => {
  const i = ORDER.indexOf(id);
  return i < 0 ? ORDER.length : i;
};

const GROUPS: QueueOption["group"][] = ["PvP", "Co-op vs AI", "Teamfight Tactics"];

/**
 * The modes the PC's play menu would offer: enabled, visible, not custom games or tutorials.
 * Pure, so it can be tested with recorded answers.
 */
export function deriveQueues(queues: RawQueue[] | null, eligibility: RawEligibility[] | null, partySize: number): QueueOption[] {
  if (!Array.isArray(queues)) return [];
  const playable = queues.filter(
    (q) =>
      q &&
      isId(q.id) &&
      q.isCustom !== true &&
      q.isEnabled !== false &&
      q.queueAvailability !== "PlatformDisabled" &&
      (q.category === undefined || q.category === "PvP" || q.category === "VersusAi") &&
      !(typeof q.gameMode === "string" && q.gameMode.startsWith("TUTORIAL")),
  );
  // isVisible marks what the play menu shows. If a client sends none as visible, don't hide everything.
  const visible = playable.filter((q) => q.isVisible !== false);
  const shown = visible.length ? visible : playable;

  const byQueue = new Map<number, RawEligibility>();
  for (const e of Array.isArray(eligibility) ? eligibility : []) if (e && isId(e.queueId)) byQueue.set(e.queueId, e);

  const seen = new Set<number>();
  const out: QueueOption[] = [];
  for (const q of shown) {
    const id = q.id as number;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = [q.description, q.name, q.shortName].find((n): n is string => typeof n === "string" && n.trim() !== "")?.trim().slice(0, 60);
    if (!name) continue;
    const sizes = Array.isArray(q.allowablePremadeSizes) ? q.allowablePremadeSizes.filter((n): n is number => Number.isInteger(n)) : [];
    let reason = reasonFor(byQueue.get(id));
    if (!reason && q.queueAvailability === "DoesntMeetRequirements") reason = "Requirements not met";
    if (!reason && partySize > 1 && sizes.length && !sizes.includes(partySize)) reason = "Party too big for this mode";
    out.push({ id, name, group: groupOf(q), canPick: !reason, reason });
  }
  return out.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** The modes League would let me switch to now, or null if the client didn't answer. */
export async function listQueues(http: LcuHttp): Promise<QueueOption[] | null> {
  const [queues, lobby] = await Promise.all([http.getOrNull<RawQueue[]>(QUEUES), http.getOrNull<RawLobby>(URI.lobby)]);
  if (!Array.isArray(queues)) return null;
  // Without eligibility the list still works: League refuses what it won't allow, and the phone shows why.
  const res = await http.json<RawEligibility[]>("POST", lobby ? "/lol-lobby/v2/eligibility/party" : "/lol-lobby/v2/eligibility/self").catch(() => null);
  const eligibility = res && res.status === 200 && Array.isArray(res.data) ? res.data : null;
  const partySize = Array.isArray(lobby?.members) ? lobby.members.length : 1;
  return deriveQueues(queues, eligibility, partySize);
}
