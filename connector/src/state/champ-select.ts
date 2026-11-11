/**
 * Pure champion-select helpers.
 *
 * Turn logic adapted from Mimic (https://github.com/molenzwiebel/Mimic),
 * Copyright (c) 2017 Thijs Molendijk, MIT License. See NOTICE.
 */

import type { ActionType, ChampSelectPlayer, ChampSelectView } from "../shared/phone-api";

/** The subset of /lol-champ-select/v1/session we rely on. */
export interface LcuAction {
  id: number;
  actorCellId: number;
  championId: number;
  completed: boolean;
  /** Present on current clients; older ones only had turn order. */
  isInProgress?: boolean;
  isAllyAction?: boolean;
  type: string; // "pick" | "ban" | "ten_bans_reveal" | ...
}

export interface LcuMember {
  cellId: number;
  championId: number;
  championPickIntent?: number;
  assignedPosition?: string;
  gameName?: string;
  summonerId?: number;
  playerType?: string;
  team?: number;
  /** Other fields (puuid, ids, skins...) are deliberately not typed and never forwarded. */
}

export interface LcuSession {
  localPlayerCellId: number;
  actions: LcuAction[][];
  myTeam: LcuMember[];
  theirTeam: LcuMember[];
  bans?: { myTeamBans?: number[]; theirTeamBans?: number[] };
  timer?: { phase?: string; adjustedTimeLeftInPhase?: number; isInfinite?: boolean };
  isSpectating?: boolean;
}

const isActionType = (t: string): t is ActionType => t === "pick" || t === "ban";

export function flatActions(session: LcuSession): LcuAction[] {
  return (session.actions ?? []).flat();
}

function hasInProgressFlag(session: LcuSession): boolean {
  return flatActions(session).some((a) => typeof a.isInProgress === "boolean");
}

/** Mimic's definition: the first turn that still has an uncompleted action, only during BAN_PICK. */
export function currentTurn(session: LcuSession): LcuAction[] | null {
  if (session.timer?.phase !== "BAN_PICK") return null;
  return (session.actions ?? []).find((turn) => turn.some((a) => !a.completed)) ?? null;
}

/** Actions currently in progress (anyone's). */
export function inProgressActions(session: LcuSession): LcuAction[] {
  if (hasInProgressFlag(session)) {
    return flatActions(session).filter((a) => a.isInProgress === true && !a.completed);
  }
  return (currentTurn(session) ?? []).filter((a) => !a.completed);
}

/**
 * The one action that is mine, active and uncompleted, i.e. "it's my turn".
 * Only pick/ban actions count.
 */
export function findMyActiveAction(session: LcuSession): LcuAction | null {
  if (session.isSpectating) return null;
  const mine = inProgressActions(session).filter(
    (a) => a.actorCellId === session.localPlayerCellId && isActionType(a.type),
  );
  return mine[0] ?? null;
}

/** My first uncompleted pick action (used for declaring intent while it isn't my turn yet). */
export function findMyFirstPendingPick(session: LcuSession): LcuAction | null {
  return (
    flatActions(session).find(
      (a) => a.actorCellId === session.localPlayerCellId && a.type === "pick" && !a.completed,
    ) ?? null
  );
}

/**
 * The action a hover should be applied to:
 * - my active action when it's my turn (pick or ban);
 * - otherwise my next pending pick, as an intent, during PLANNING / BAN_PICK.
 */
export function findHoverTarget(session: LcuSession): LcuAction | null {
  const active = findMyActiveAction(session);
  if (active) return active;
  const phase = session.timer?.phase;
  if (phase !== "PLANNING" && phase !== "BAN_PICK") return null;
  return findMyFirstPendingPick(session);
}

export function hasLockedPick(session: LcuSession): boolean {
  const myPicks = flatActions(session).filter(
    (a) => a.actorCellId === session.localPlayerCellId && a.type === "pick",
  );
  // No pick actions at all (e.g. ARAM): treat as "nothing to lock".
  return myPicks.length > 0 && myPicks.every((a) => a.completed);
}

function completedBans(session: LcuSession, ally: boolean): number[] {
  const myCells = new Set(session.myTeam.map((m) => m.cellId));
  return flatActions(session)
    .filter((a) => a.type === "ban" && a.completed && a.championId > 0)
    .filter((a) => (a.isAllyAction ?? myCells.has(a.actorCellId)) === ally)
    .map((a) => a.championId);
}

function bans(session: LcuSession): { myTeam: number[]; theirTeam: number[] } {
  const myTeam = completedBans(session, true);
  const theirTeam = completedBans(session, false);
  // Some modes report bans only via session.bans.
  return {
    myTeam: myTeam.length ? myTeam : (session.bans?.myTeamBans ?? []).filter((id) => id > 0),
    theirTeam: theirTeam.length ? theirTeam : (session.bans?.theirTeamBans ?? []).filter((id) => id > 0),
  };
}

function toPlayer(m: LcuMember, index: number, friendly: boolean, session: LcuSession, active: LcuAction[]): ChampSelectPlayer {
  const action = active.find((a) => a.actorCellId === m.cellId && isActionType(a.type));
  const isMe = friendly && m.cellId === session.localPlayerCellId;
  const gameName = typeof m.gameName === "string" ? m.gameName.trim() : "";
  const isBot = m.playerType === "BOT";
  return {
    cellId: m.cellId,
    name: isMe ? "You" : friendly && gameName ? gameName.slice(0, 32) : isBot ? "Bot" : `${friendly ? "Ally" : "Enemy"} ${index + 1}`,
    position: typeof m.assignedPosition === "string" ? m.assignedPosition.toLowerCase() : "",
    championId: m.championId > 0 ? m.championId : 0,
    pickIntentId: (m.championPickIntent ?? 0) > 0 ? (m.championPickIntent as number) : 0,
    isMe,
    activeAction: action ? (action.type as ActionType) : null,
    isBot,
  };
}

export function deriveChampSelect(
  session: LcuSession,
  pickable: number[] | null,
  bannable: number[] | null,
): ChampSelectView {
  const active = inProgressActions(session);
  const my = findMyActiveAction(session);
  const hoverTarget = findHoverTarget(session);
  return {
    phase: session.timer?.phase ?? "UNKNOWN",
    timeLeftMs: Math.max(0, Math.round(session.timer?.adjustedTimeLeftInPhase ?? 0)),
    isInfinite: !!session.timer?.isInfinite,
    myTeam: (session.myTeam ?? []).map((m, i) => toPlayer(m, i, true, session, active)),
    theirTeam: (session.theirTeam ?? []).map((m, i) => toPlayer(m, i, false, session, active)),
    bans: bans(session),
    myTurn: my ? { type: my.type as ActionType, championId: my.championId > 0 ? my.championId : 0 } : null,
    canHoverIntent: !my && !!hoverTarget,
    hasLockedPick: hasLockedPick(session),
    pickableChampionIds: (pickable ?? []).filter((n) => Number.isInteger(n) && n > 0),
    bannableChampionIds: (bannable ?? []).filter((n) => Number.isInteger(n) && n > 0),
  };
}
