import type { LcuAction, LcuSession } from "../../src/state/champ-select";

let nextId = 1;
export function act(actorCellId: number, type: string, extra: Partial<LcuAction> = {}): LcuAction {
  return { id: nextId++, actorCellId, championId: 0, completed: false, type, isAllyAction: actorCellId < 5, ...extra };
}

const member = (cellId: number) => ({
  cellId,
  championId: 0,
  championPickIntent: 0,
  assignedPosition: ["TOP", "jungle", "middle", "bottom", "utility"][cellId % 5],
  gameName: cellId < 5 ? `Player${cellId}` : "",
  puuid: `secret-puuid-${cellId}`,
  summonerId: 900000 + cellId,
  playerType: "PLAYER",
});

/** Ranked-draft-like session: 10 simultaneous bans, reveal, then 1-2-2-2-2-1 picks. Local player is cell 2. */
export function draftSession(opts: { phase?: string; withInProgressFlag?: boolean } = {}): LcuSession & Record<string, unknown> {
  nextId = 1;
  const actions: LcuAction[][] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => act(c, "ban")),
    [act(-1, "ten_bans_reveal")],
    [act(0, "pick")],
    [act(5, "pick"), act(6, "pick")],
    [act(1, "pick"), act(2, "pick")],
    [act(7, "pick"), act(8, "pick")],
    [act(3, "pick"), act(4, "pick")],
    [act(9, "pick")],
  ];
  if (opts.withInProgressFlag !== false) for (const a of actions.flat()) a.isInProgress = false;
  return {
    actions,
    localPlayerCellId: 2,
    myTeam: [0, 1, 2, 3, 4].map(member),
    theirTeam: [5, 6, 7, 8, 9].map(member),
    bans: { myTeamBans: [], theirTeamBans: [] },
    timer: { phase: opts.phase ?? "BAN_PICK", adjustedTimeLeftInPhase: 27450.7, isInfinite: false },
    chatDetails: { multiUserChatPassword: "chat-secret" },
  };
}

/** Marks every group before `groupIndex` completed and sets `groupIndex` in progress. Bans 100+cell, picks 300+cell. */
export function advanceTo(
  s: LcuSession,
  groupIndex: number,
  champ = (a: LcuAction) => (a.type === "pick" ? 300 : 100) + a.actorCellId,
): LcuSession {
  s.actions.forEach((group, i) => {
    for (const a of group) {
      if (i < groupIndex) {
        a.completed = true;
        if (a.type !== "ten_bans_reveal") a.championId = champ(a);
        if (a.isInProgress !== undefined) a.isInProgress = false;
      } else if (i === groupIndex && a.isInProgress !== undefined) {
        a.isInProgress = true;
      }
    }
  });
  return s;
}

/** ARAM-like session: champions handed out, no pick actions, a shared bench and rerolls. Local player is cell 2. */
export function aramSession(): LcuSession & Record<string, unknown> {
  const s = draftSession({ phase: "FINALIZATION" });
  s.actions = [];
  for (const m of [...s.myTeam, ...s.theirTeam]) m.championId = 200 + m.cellId;
  return {
    ...s,
    queueId: 450,
    benchEnabled: true,
    benchChampions: [
      { championId: 51, isPriority: false },
      { championId: 22, isPriority: true },
    ],
    allowRerolling: true,
    rerollsRemaining: 1,
  };
}

/**
 * A mode that offers each player a few champions: one simultaneous pick each, flagged in progress.
 * Live ARAM (queue 450, 2026-11-14) does this during BAN_PICK; FINALIZATION here checks the phase rule.
 */
export function subsetSession(phase = "FINALIZATION"): LcuSession & Record<string, unknown> {
  const s = draftSession({ phase });
  s.actions = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => act(c, "pick", { isInProgress: true }))];
  return { ...s, allowSubsetChampionPicks: true, hasSimultaneousPicks: true };
}
