/**
 * Pure champion-select helpers.
 *
 * Turn logic adapted from Mimic (https://github.com/molenzwiebel/Mimic),
 * Copyright (c) 2017 Thijs Molendijk, MIT License. See NOTICE.
 */

import type { ActionType, ChampSelectPlayer, ChampSelectView, SwapKind, SwapState } from "../shared/phone-api";

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
  spell1Id?: number;
  spell2Id?: number;
  selectedSkinId?: number;
  /** Other fields (puuid, ids, skins...) are deliberately not typed and never forwarded. */
}

export interface LcuSession {
  localPlayerCellId: number;
  actions: LcuAction[][];
  myTeam: LcuMember[];
  theirTeam: LcuMember[];
  bans?: { myTeamBans?: number[]; theirTeamBans?: number[] };
  timer?: { phase?: string; adjustedTimeLeftInPhase?: number; internalNowInEpochMs?: number; isInfinite?: boolean };
  isSpectating?: boolean;
  /** One entry per teammate (not me). Seen on a live client, 2026-11-12. */
  trades?: LcuSwap[];
  pickOrderSwaps?: LcuSwap[];
  positionSwaps?: LcuSwap[];
  queueId?: number;
  /** ARAM-style modes: champions anyone on my team can swap for. */
  benchEnabled?: boolean;
  benchChampions?: { championId: number; isPriority?: boolean }[];
  /** Older clients listed the bench as plain ids. */
  benchChampionIds?: number[];
  allowRerolling?: boolean;
  rerollsRemaining?: number;
  /**
   * League offers each player a few champions to choose from (GET .../subset-champion-list).
   * Live ARAM, queue 450 (2026-11-14): 3 offered, 10 simultaneous pick actions during BAN_PICK,
   * the champions nobody chose fill the bench, and allowRerolling with 0 rerolls.
   */
  allowSubsetChampionPicks?: boolean;
  allowDuplicatePicks?: boolean;
}

/** A swap slot between me and one teammate. state: AVAILABLE, SENT, RECEIVED, BUSY, INVALID, ... */
export interface LcuSwap {
  id: number;
  cellId: number;
  state: string;
}

/** Where each swap kind lives in the session (champion trades are still called "trades" there). */
export const SWAP_FIELDS = {
  position: "positionSwaps",
  pickOrder: "pickOrderSwaps",
  champion: "trades",
} as const satisfies Record<SwapKind, keyof LcuSession>;

const SWAP_STATES: Record<string, SwapState> = { AVAILABLE: "available", SENT: "sent", RECEIVED: "received" };

/** The swap slot of this kind with this teammate, if the client lists one. */
export function findSwap(session: LcuSession, kind: SwapKind, cellId: number): LcuSwap | null {
  const list = session[SWAP_FIELDS[kind]];
  if (!Array.isArray(list)) return null;
  return list.find((s) => s && s.cellId === cellId && Number.isInteger(s.id)) ?? null;
}

/** This player has locked in a pick (their pick actions are all completed). */
export function hasLockedPickCell(session: LcuSession, cellId: number): boolean {
  const picks = flatActions(session).filter((a) => a.actorCellId === cellId && a.type === "pick");
  return picks.length > 0 && picks.every((a) => a.completed);
}

/**
 * League keeps offering a pick-order swap after one of us has locked in, but the request does
 * nothing then (live draft, 2026-11-14), so it only counts while both of us still have to pick.
 */
export function pickOrderSwapPossible(session: LcuSession, cellId: number): boolean {
  return !hasLockedPickCell(session, cellId) && !hasLockedPickCell(session, session.localPlayerCellId);
}

function swapsWith(session: LcuSession, cellId: number): ChampSelectPlayer["swaps"] {
  const out: ChampSelectPlayer["swaps"] = {};
  for (const kind of Object.keys(SWAP_FIELDS) as SwapKind[]) {
    const raw = findSwap(session, kind, cellId)?.state ?? "";
    if (kind === "pickOrder" && raw === "AVAILABLE" && !pickOrderSwapPossible(session, cellId)) continue;
    const state = SWAP_STATES[raw];
    if (state) out[kind] = state;
  }
  return out;
}

/** cellId -> 1-based pick order within that player's team. */
function pickTurns(session: LcuSession): Map<number, number> {
  const allies = new Set((session.myTeam ?? []).map((m) => m.cellId));
  const turns = new Map<number, number>();
  let ally = 0;
  let enemy = 0;
  for (const a of flatActions(session)) {
    if (a.type !== "pick" || turns.has(a.actorCellId)) continue;
    turns.set(a.actorCellId, allies.has(a.actorCellId) ? ++ally : ++enemy);
  }
  return turns;
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

/**
 * Actions currently in progress (anyone's). Only during BAN_PICK: the real client
 * already flags the ban actions isInProgress during PLANNING (verified 2026-11-12),
 * but they can't be acted on until BAN_PICK starts.
 */
export function inProgressActions(session: LcuSession): LcuAction[] {
  // Choose-from-a-few modes have no ban phase to wait for, and their phase names aren't known yet,
  // so there an action League flags in progress counts in any phase but the last.
  if (session.allowSubsetChampionPicks && hasInProgressFlag(session) && session.timer?.phase !== "GAME_STARTING") {
    return flatActions(session).filter((a) => a.isInProgress === true && !a.completed);
  }
  if (session.timer?.phase !== "BAN_PICK") return [];
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
  // No pick actions at all: treat as "nothing to lock".
  return hasLockedPickCell(session, session.localPlayerCellId);
}

/** Champions someone has locked in (either team). Empty in modes that allow duplicate picks. */
export function lockedChampions(session: LcuSession): number[] {
  if (session.allowDuplicatePicks) return [];
  const ids = flatActions(session).filter((a) => a.type === "pick" && a.completed).map((a) => a.championId);
  return positiveIds(ids);
}

/** All banned champions, both teams. */
export function bannedChampions(session: LcuSession): number[] {
  const b = bans(session);
  return positiveIds([...b.myTeam, ...b.theirTeam]);
}

const positiveIds = (list: unknown): number[] =>
  Array.isArray(list) ? [...new Set(list.filter((n): n is number => Number.isInteger(n) && n > 0))] : [];

/** Champions on the bench (ARAM), or null when this mode has no bench. */
export function benchChampions(session: LcuSession): number[] | null {
  if (!session.benchEnabled) return null;
  const fromObjects = Array.isArray(session.benchChampions) ? session.benchChampions.map((b) => b?.championId) : [];
  return positiveIds(fromObjects.length ? fromObjects : session.benchChampionIds);
}

/** Rerolls I have left, or null when this mode doesn't allow rerolling. */
export function rerollsLeft(session: LcuSession): number | null {
  if (!session.allowRerolling || session.isSpectating) return null;
  const n = session.rerollsRemaining;
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : 0;
}

/** One line for the log describing how this champ select works (no names or ids of people). */
export function describeMode(session: LcuSession, subset: number[] | null): string {
  const types = new Map<string, number>();
  for (const a of flatActions(session)) types.set(a.type, (types.get(a.type) ?? 0) + 1);
  const actions = [...types].map(([t, n]) => `${n} ${t}`).join(", ") || "none";
  const bench = benchChampions(session);
  return [
    `queue ${session.queueId ?? "?"}`,
    `phase ${session.timer?.phase ?? "?"}`,
    `actions: ${actions}`,
    `bench ${bench ? bench.length : "off"}`,
    `rerolls ${session.allowRerolling ? (session.rerollsRemaining ?? "?") : "off"}`,
    `subset ${session.allowSubsetChampionPicks ? (subset?.length ?? "?") : "off"}`,
  ].join("; ");
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

function toPlayer(
  m: LcuMember,
  index: number,
  friendly: boolean,
  session: LcuSession,
  active: LcuAction[],
  turns: Map<number, number>,
): ChampSelectPlayer {
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
    pickTurn: turns.get(m.cellId) ?? 0,
    swaps: friendly && !isMe && !session.isSpectating ? swapsWith(session, m.cellId) : {},
  };
}

/**
 * Time left right now. The LCU reports `adjustedTimeLeftInPhase` as of
 * `internalNowInEpochMs` (the PC's clock, same as ours), and often sends the
 * same value (e.g. 25000) at the start of several turns, so we convert it to
 * "ms left at this moment" and the phone restarts its countdown on every push.
 */
export function timeLeftMs(timer: LcuSession["timer"], now = Date.now()): number {
  const left = timer?.adjustedTimeLeftInPhase ?? 0;
  const at = timer?.internalNowInEpochMs;
  const ms = typeof at === "number" && at > 0 ? at + left - now : left;
  return Math.max(0, Math.round(ms));
}

export function deriveChampSelect(
  session: LcuSession,
  pickable: number[] | null,
  bannable: number[] | null,
  now = Date.now(),
  subset: number[] | null = null,
): ChampSelectView {
  const active = inProgressActions(session);
  const my = findMyActiveAction(session);
  const hoverTarget = findHoverTarget(session);
  const turns = pickTurns(session);
  const me = (session.myTeam ?? []).find((m) => m.cellId === session.localPlayerCellId);
  const pos = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0);
  return {
    phase: session.timer?.phase ?? "UNKNOWN",
    timeLeftMs: timeLeftMs(session.timer, now),
    isInfinite: !!session.timer?.isInfinite,
    myTeam: (session.myTeam ?? []).map((m, i) => toPlayer(m, i, true, session, active, turns)),
    theirTeam: (session.theirTeam ?? []).map((m, i) => toPlayer(m, i, false, session, active, turns)),
    bans: bans(session),
    myTurn: my ? { type: my.type as ActionType, championId: my.championId > 0 ? my.championId : 0 } : null,
    canHoverIntent: !my && !!hoverTarget,
    hasLockedPick: hasLockedPick(session),
    pickableChampionIds: (pickable ?? []).filter((n) => Number.isInteger(n) && n > 0),
    bannableChampionIds: (bannable ?? []).filter((n) => Number.isInteger(n) && n > 0),
    mySpells: [pos(me?.spell1Id), pos(me?.spell2Id)],
    mySkinId: pos(me?.selectedSkinId),
    lockedChampionIds: lockedChampions(session),
    bench: session.isSpectating ? null : benchChampions(session),
    rerollsLeft: rerollsLeft(session),
    choices: session.allowSubsetChampionPicks ? positiveIds(subset) : [],
  };
}
