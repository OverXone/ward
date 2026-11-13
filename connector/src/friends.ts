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
  gameName?: unknown;
  name?: unknown;
  availability?: unknown;
  product?: unknown;
  lol?: { gameStatus?: unknown } | null;
}

interface RawLobbyForInvites {
  members?: { summonerId?: unknown }[];
}

interface RawSentInvite {
  toSummonerId?: unknown;
  state?: unknown;
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

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
  const members = new Set((lobby?.members ?? []).map((m) => m?.summonerId).filter(isId));
  const invited = new Set(
    (Array.isArray(sent) ? sent : []).filter((i) => i?.state === "Pending" || i?.state === "Requested").map((i) => i.toSummonerId).filter(isId),
  );
  const out = friends
    .filter((f) => f && isId(f.summonerId) && inLeague(f))
    .map((f) => {
      const id = f.summonerId as number;
      const name = [f.gameName, f.name].find((n): n is string => typeof n === "string" && n.trim() !== "")?.trim().slice(0, 32) ?? "Friend";
      const game = typeof f.lol?.gameStatus === "string" ? GAME_STATUS[f.lol.gameStatus] : undefined;
      let status = game ?? (f.availability === "away" ? "Away" : "Online");
      let canInvite = true;
      if (members.has(id)) [status, canInvite] = ["In your lobby", false];
      else if (invited.has(id)) [status, canInvite] = ["Invited", false];
      const rank = game ? 2 : f.availability === "away" ? 1 : 0;
      return { handle: handles.handle("friend", id), name, status, canInvite, rank };
    })
    // Invitable first (online, then away, then busy), then the ones already with me; alphabetical within each.
    .sort((a, b) => Number(b.canInvite) - Number(a.canInvite) || a.rank - b.rank || a.name.localeCompare(b.name));
  return out.map(({ rank: _rank, ...f }) => f);
}

export async function listFriends(http: LcuHttp, handles: Handles): Promise<FriendOption[] | null> {
  const [friends, lobby, sent] = await Promise.all([
    http.getOrNull<RawFriend[]>("/lol-chat/v1/friends"),
    http.getOrNull<RawLobbyForInvites>("/lol-lobby/v2/lobby"),
    http.getOrNull<RawSentInvite[]>("/lol-lobby/v2/lobby/invitations"),
  ]);
  if (!Array.isArray(friends)) return null;
  return deriveFriends(friends, lobby, sent, handles);
}
