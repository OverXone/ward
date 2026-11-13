/**
 * Friends I can invite to my lobby, read from the League client on demand (GET /api/friends).
 *
 * Endpoints:
 * - /lol-chat/v1/friends              my friends list with presence (availability, product, lol.gameStatus)
 * - /lol-lobby/v2/lobby               who's already in my lobby (members[].summonerId)
 * - /lol-lobby/v2/lobby/invitations   invitations I already sent (toSummonerId, state)
 *
 * The phone gets each friend's name, a status word and an opaque handle; summoner ids and puuids
 * never leave the connector.
 */

import type { Handles } from "./handles";
import type { LcuHttp } from "./lcu/http";
import type { FriendOption } from "./shared/phone-api";

export interface RawFriend {
  summonerId?: unknown;
  puuid?: unknown;
  gameName?: unknown;
  name?: unknown;
  availability?: unknown;
  product?: unknown;
  lol?: { gameStatus?: unknown } | null;
}

interface RawLobbyForInvites {
  members?: { summonerId?: unknown; puuid?: unknown }[];
}

interface RawSentInvite {
  toSummonerId?: unknown;
  toPuuid?: unknown;
  state?: unknown;
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const PUUID = /^[A-Za-z0-9_-]{20,100}$/;
const puuidOf = (v: unknown) => (typeof v === "string" && PUUID.test(v) ? v : null);

/**
 * How a friend is keyed: puuid, since on a live client (2026-11-13) only 40 of 65 friends had a
 * summonerId, and League's invitation type takes `toPuuid`. Summoner id only if there's no puuid.
 */
export const friendKey = (f: RawFriend): string | number | null => puuidOf(f.puuid) ?? (isId(f.summonerId) ? f.summonerId : null);

const GAME_STATUS: Record<string, string> = {
  inQueue: "In queue",
  championSelect: "In champ select",
  inGame: "In game",
  spectating: "Spectating",
};

/** Is this friend playing League right now (not offline, not on mobile, not in another Riot game)? */
function inLeague(f: RawFriend): boolean {
  const availability = typeof f.availability === "string" ? f.availability : "offline";
  if (availability === "offline" || availability === "mobile") return false;
  // Friends in another Riot game have product "valorant" etc.; older clients don't send product.
  return f.product === undefined || f.product === "league_of_legends";
}

/**
 * Online League friends, invitable ones first. Pure, so it can be tested with recorded answers.
 */
export function deriveFriends(
  friends: RawFriend[] | null,
  lobby: RawLobbyForInvites | null,
  sent: RawSentInvite[] | null,
  handles: Handles,
): FriendOption[] {
  if (!Array.isArray(friends)) return [];
  // Both ids, so a friend matches whichever one League filled in.
  const ids = (x: { summonerId?: unknown; puuid?: unknown }) => [x.summonerId, x.puuid].filter((v) => isId(v) || puuidOf(v));
  const members = new Set((lobby?.members ?? []).flatMap((m) => (m ? ids(m) : [])));
  const pending = (Array.isArray(sent) ? sent : []).filter((i) => i?.state === "Pending" || i?.state === "Requested");
  const invited = new Set(pending.flatMap((i) => ids({ summonerId: i.toSummonerId, puuid: i.toPuuid })));
  const has = (set: Set<unknown>, f: RawFriend) => ids(f).some((v) => set.has(v));
  const out = friends
    .filter((f) => f && friendKey(f) !== null && inLeague(f))
    .map((f) => {
      const key = friendKey(f)!;
      const name = [f.gameName, f.name].find((n): n is string => typeof n === "string" && n.trim() !== "")?.trim().slice(0, 32) ?? "Friend";
      const game = typeof f.lol?.gameStatus === "string" ? GAME_STATUS[f.lol.gameStatus] : undefined;
      let status = game ?? (f.availability === "away" ? "Away" : "Online");
      let canInvite = true;
      if (has(members, f)) [status, canInvite] = ["In your lobby", false];
      else if (has(invited, f)) [status, canInvite] = ["Invited", false];
      const rank = game ? 2 : f.availability === "away" ? 1 : 0;
      return { handle: handles.handle("friend", key), name, status, canInvite, rank };
    })
    // Invitable first (online, then away, then busy), then the ones already with me; alphabetical within each.
    .sort((a, b) => Number(b.canInvite) - Number(a.canInvite) || a.rank - b.rank || a.name.localeCompare(b.name));
  return out.map(({ rank: _rank, ...f }) => f);
}

export async function listFriends(http: LcuHttp, handles: Handles): Promise<FriendOption[] | null> {
  return (await readFriends(http, handles))?.options ?? null;
}

/** The phone's view plus the raw list it came from (actions need the ids behind a handle). */
export async function readFriends(http: LcuHttp, handles: Handles): Promise<{ options: FriendOption[]; raw: RawFriend[] } | null> {
  const [friends, lobby, sent] = await Promise.all([
    http.getOrNull<RawFriend[]>("/lol-chat/v1/friends"),
    http.getOrNull<RawLobbyForInvites>("/lol-lobby/v2/lobby"),
    http.getOrNull<RawSentInvite[]>("/lol-lobby/v2/lobby/invitations"),
  ]);
  if (!Array.isArray(friends)) return null;
  return { options: deriveFriends(friends, lobby, sent, handles), raw: friends };
}
