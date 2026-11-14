import { describe, expect, it } from "vitest";
import { deriveChampSelect, describeMode, findHoverTarget, findMyActiveAction, hasLockedPick } from "../src/state/champ-select";
import { advanceTo, aramSession, draftSession, subsetSession } from "./fixtures/sessions";

describe("findMyActiveAction", () => {
  it("finds my in-progress ban during the simultaneous ban phase", () => {
    const s = advanceTo(draftSession(), 0);
    const a = findMyActiveAction(s);
    expect(a?.type).toBe("ban");
    expect(a?.actorCellId).toBe(2);
  });

  it("returns null while someone else is picking", () => {
    const s = advanceTo(draftSession(), 3); // enemies 5,6 picking
    expect(findMyActiveAction(s)).toBeNull();
  });

  it("finds my pick when my group is in progress", () => {
    const s = advanceTo(draftSession(), 4); // cells 1,2
    expect(findMyActiveAction(s)).toMatchObject({ type: "pick", actorCellId: 2 });
  });

  it("ignores my action once completed even if its group is still running", () => {
    const s = advanceTo(draftSession(), 4);
    s.actions[4]!.find((a) => a.actorCellId === 2)!.completed = true;
    expect(findMyActiveAction(s)).toBeNull();
  });

  it("falls back to Mimic's turn order on clients without isInProgress", () => {
    const s = advanceTo(draftSession({ withInProgressFlag: false }), 4);
    expect(s.actions.flat().some((a) => "isInProgress" in a)).toBe(false);
    expect(findMyActiveAction(s)).toMatchObject({ type: "pick", actorCellId: 2 });
    expect(findMyActiveAction(advanceTo(draftSession({ withInProgressFlag: false }), 3))).toBeNull();
  });

  it("never acts while spectating", () => {
    const s = advanceTo(draftSession(), 4);
    s.isSpectating = true;
    expect(findMyActiveAction(s)).toBeNull();
  });
});

describe("findHoverTarget", () => {
  it("targets my first pending pick as intent during PLANNING", () => {
    const s = draftSession({ phase: "PLANNING" });
    expect(findHoverTarget(s)).toMatchObject({ type: "pick", actorCellId: 2, completed: false });
    expect(findMyActiveAction(s)).toBeNull();
  });

  it("real client: bans flagged isInProgress during PLANNING are not my turn yet", () => {
    // Shape recorded from a live Draft Pick lobby: all 10 bans isInProgress while timer.phase = PLANNING.
    const s = draftSession({ phase: "PLANNING" });
    for (const a of s.actions[0]!) a.isInProgress = true;
    expect(findMyActiveAction(s)).toBeNull();
    expect(findHoverTarget(s)).toMatchObject({ type: "pick", actorCellId: 2 });
    const v = deriveChampSelect(s, [], []);
    expect(v.myTurn).toBeNull();
    expect(v.canHoverIntent).toBe(true);
    expect(v.myTeam.every((p) => p.activeAction === null)).toBe(true);
  });

  it("targets my active ban rather than my future pick", () => {
    expect(findHoverTarget(advanceTo(draftSession(), 0))?.type).toBe("ban");
  });

  it("allows intent while others pick, but nothing in FINALIZATION", () => {
    expect(findHoverTarget(advanceTo(draftSession(), 3))?.type).toBe("pick");
    expect(findHoverTarget(advanceTo(draftSession({ phase: "FINALIZATION" }), 8))).toBeNull();
  });
});

describe("deriveChampSelect", () => {
  it("reports my turn, bans by team and lock state", () => {
    const v = deriveChampSelect(advanceTo(draftSession(), 4), [1, 2, 3], [4, 5]);
    expect(v.myTurn).toEqual({ type: "pick", championId: 0 });
    expect(v.canHoverIntent).toBe(false);
    expect(v.bans.myTeam).toEqual([100, 101, 102, 103, 104]);
    expect(v.bans.theirTeam).toEqual([105, 106, 107, 108, 109]);
    expect(v.timeLeftMs).toBe(27451);
    expect(v.myTeam.find((p) => p.isMe)).toMatchObject({ cellId: 2, name: "You", activeAction: "pick", position: "middle" });
    expect(v.myTeam[0]!.position).toBe("top");
    expect(v.myTeam[1]!.name).toBe("Player1");
    expect(v.theirTeam[0]!.name).toBe("Enemy 1");
    expect(v.hasLockedPick).toBe(false);
  });

  it("marks my pick as locked once completed", () => {
    const s = advanceTo(draftSession(), 5);
    expect(hasLockedPick(s)).toBe(true);
    expect(deriveChampSelect(s, [], []).hasLockedPick).toBe(true);
  });

  it("never leaks account identifiers or chat credentials", () => {
    const json = JSON.stringify(deriveChampSelect(advanceTo(draftSession(), 4), [1], [2]));
    expect(json).not.toMatch(/puuid|summonerId|chat-secret|900002/);
  });

  it("computes time left relative to the client's timestamp", () => {
    const s = draftSession();
    s.timer = { phase: "BAN_PICK", adjustedTimeLeftInPhase: 25000, internalNowInEpochMs: 1_000_000 };
    expect(deriveChampSelect(s, [], [], 1_004_000).timeLeftMs).toBe(21000);
    expect(deriveChampSelect(s, [], [], 1_030_000).timeLeftMs).toBe(0);
  });

  it("filters junk out of champion id lists", () => {
    const v = deriveChampSelect(draftSession(), [1, -1, 2.5, 0, 7], null);
    expect(v.pickableChampionIds).toEqual([1, 7]);
    expect(v.bannableChampionIds).toEqual([]);
  });
});

describe("swaps", () => {
  // Shape recorded on a live client (2026-11-12): one slot per teammate, same ids in all three lists.
  const withSwaps = () => {
    const s = draftSession();
    s.positionSwaps = [
      { cellId: 0, id: 12, state: "INVALID" },
      { cellId: 1, id: 13, state: "RECEIVED" },
      { cellId: 3, id: 14, state: "AVAILABLE" },
      { cellId: 4, id: 15, state: "BUSY" },
    ];
    s.pickOrderSwaps = [{ cellId: 3, id: 14, state: "SENT" }];
    s.trades = [{ cellId: 3, id: 14, state: "INVALID" }];
    return s;
  };

  it("shows each teammate's open swaps, and none for me or enemies", () => {
    const v = deriveChampSelect(withSwaps(), [], []);
    const byCell = new Map(v.myTeam.map((p) => [p.cellId, p.swaps]));
    expect(byCell.get(0)).toEqual({});
    expect(byCell.get(1)).toEqual({ position: "received" });
    expect(byCell.get(3)).toEqual({ position: "available", pickOrder: "sent" });
    expect(byCell.get(4)).toEqual({}); // BUSY: nothing to do
    expect(byCell.get(2)).toEqual({}); // me
    expect(v.theirTeam.every((p) => Object.keys(p.swaps).length === 0)).toBe(true);
  });

  it("numbers picks within each team", () => {
    const v = deriveChampSelect(draftSession(), [], []);
    expect(v.myTeam.map((p) => p.pickTurn)).toEqual([1, 2, 3, 4, 5]);
    expect(v.theirTeam.map((p) => p.pickTurn)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows nothing while spectating", () => {
    const s = withSwaps();
    s.isSpectating = true;
    expect(deriveChampSelect(s, [], []).myTeam.every((p) => Object.keys(p.swaps).length === 0)).toBe(true);
  });
});

describe("ARAM and choose-from-a-few modes", () => {
  it("reports the bench and rerolls, and no turn", () => {
    const v = deriveChampSelect(aramSession(), [], []);
    expect(v.bench).toEqual([51, 22]);
    expect(v.rerollsLeft).toBe(1);
    expect(v.choices).toEqual([]);
    expect(v.myTurn).toBeNull();
    expect(v.canHoverIntent).toBe(false);
    expect(v.myTeam.find((p) => p.isMe)?.championId).toBe(202);
  });

  it("reads the older plain-id bench and drops junk ids", () => {
    const s = aramSession();
    delete s.benchChampions;
    s.benchChampionIds = [51, 0, -1, 51, 2.5, 22];
    expect(deriveChampSelect(s, [], []).bench).toEqual([51, 22]);
  });

  it("shows no bench or rerolls in draft, and 0 rerolls once they're used", () => {
    const draft = deriveChampSelect(draftSession(), [], []);
    expect(draft.bench).toBeNull();
    expect(draft.rerollsLeft).toBeNull();
    const s = aramSession();
    s.rerollsRemaining = 0;
    expect(deriveChampSelect(s, [], []).rerollsLeft).toBe(0);
  });

  it("hides the bench and rerolls while spectating", () => {
    const s = aramSession();
    s.isSpectating = true;
    const v = deriveChampSelect(s, [], []);
    expect(v.bench).toBeNull();
    expect(v.rerollsLeft).toBeNull();
  });

  it("offers the subset champions and treats my in-progress pick as my turn in any phase", () => {
    const s = subsetSession("FINALIZATION");
    expect(findMyActiveAction(s)).toMatchObject({ type: "pick", actorCellId: 2 });
    const v = deriveChampSelect(s, [7, 8], [], 0, [7, 0, 8, 7]);
    expect(v.choices).toEqual([7, 8]);
    expect(v.myTurn).toEqual({ type: "pick", championId: 0 });
    expect(deriveChampSelect(subsetSession("GAME_STARTING"), [], []).myTurn).toBeNull();
  });

  it("ignores a subset list when the mode doesn't use one", () => {
    expect(deriveChampSelect(draftSession(), [], [], 0, [7, 8]).choices).toEqual([]);
  });

  it("describes the mode for the log without player data", () => {
    const line = describeMode(aramSession(), null);
    expect(line).toBe("queue 450; phase FINALIZATION; actions: none; bench 2; rerolls 1; subset off");
    expect(describeMode(subsetSession(), [1, 2])).toContain("actions: 10 pick; bench off; rerolls off; subset 2");
  });
});
