import { describe, expect, it } from "vitest";
import { friendlyLcuError, runAction, type ActionName } from "../src/actions";
import type { LcuHttp } from "../src/lcu/http";
import { expectError, fakeLcu, ok, type Route } from "./fake-lcu";
import { advanceTo, draftSession } from "./fixtures/sessions";

const run = (name: ActionName, body: unknown, http: LcuHttp | null) => runAction(name, body, { http });

describe("input validation", () => {
  const { http, writes } = fakeLcu({});

  it("rejects unknown fields", async () => {
    await expectError(run("ready-check/accept", { path: "/lol-anything" }, http), 400, /unexpected field/);
    await expectError(run("champ-select/hover", { championId: 1, actionId: 5 }, http), 400, /unexpected field/);
  });

  it("rejects non-integer, negative, string or huge championIds", async () => {
    for (const championId of [1.5, -3, 0, "103", null, 1e9, Number.NaN]) {
      await expectError(run("champ-select/hover", { championId }, http), 400, /championId/);
    }
    await expectError(run("champ-select/hover", [103], http), 400);
  });

  it("answers 503 when the client isn't connected", async () => {
    await expectError(run("queue/start", undefined, null), 503);
  });

  it("never wrote anything to the LCU", () => expect(writes()).toHaveLength(0));
});

describe("ready check", () => {
  it("accepts only while a ready check is in progress", async () => {
    const lcu = fakeLcu({
      "GET /lol-matchmaking/v1/ready-check": ok({ state: "InProgress" }),
      "POST /lol-matchmaking/v1/ready-check/accept": ok(),
    });
    await run("ready-check/accept", undefined, lcu.http);
    expect(lcu.writes()).toEqual([{ method: "POST", path: "/lol-matchmaking/v1/ready-check/accept", body: undefined }]);

    const idle = fakeLcu({ "GET /lol-matchmaking/v1/ready-check": ok({ state: "Invalid" }) });
    await expectError(run("ready-check/decline", undefined, idle.http), 409);
    expect(idle.writes()).toHaveLength(0);
  });
});

describe("queue", () => {
  it("starts only from Lobby and cancels only while in Matchmaking", async () => {
    const lobby = fakeLcu({
      "GET /lol-gameflow/v1/gameflow-phase": ok("Lobby"),
      "POST /lol-lobby/v2/lobby/matchmaking/search": ok(),
    });
    await run("queue/start", undefined, lobby.http);
    expect(lobby.writes()[0]).toMatchObject({ method: "POST", path: "/lol-lobby/v2/lobby/matchmaking/search" });
    await expectError(run("queue/cancel", undefined, lobby.http), 409);
  });

  it("surfaces the client's error message", async () => {
    const lcu = fakeLcu({
      "GET /lol-gameflow/v1/gameflow-phase": ok("Lobby"),
      "POST /lol-lobby/v2/lobby/matchmaking/search": () => ({ status: 400, json: { message: "QUEUE_DODGE penalty" } }),
    });
    await expectError(run("queue/start", undefined, lcu.http), 502, /QUEUE_DODGE/);
  });
});

describe("champ select", () => {
  function csLcu(session: object, extra: Record<string, Route> = {}) {
    return fakeLcu({
      "GET /lol-champ-select/v1/session": ok(session),
      "GET /lol-champ-select/v1/pickable-champion-ids": ok([103, 222]),
      "GET /lol-champ-select/v1/bannable-champion-ids": ok([157, 103]),
      ...extra,
    });
  }

  it("hovers on MY active action, chosen by the server", async () => {
    const s = advanceTo(draftSession(), 4);
    const myId = s.actions[4]!.find((a) => a.actorCellId === 2)!.id;
    const lcu = csLcu(s, { [`PATCH /lol-champ-select/v1/session/actions/${myId}`]: ok() });
    await run("champ-select/hover", { championId: 103 }, lcu.http);
    expect(lcu.writes()).toEqual([{ method: "PATCH", path: `/lol-champ-select/v1/session/actions/${myId}`, body: { championId: 103 } }]);
  });

  it("validates against the bannable list during my ban", async () => {
    const s = advanceTo(draftSession(), 0);
    const lcu = csLcu(s);
    await expectError(run("champ-select/hover", { championId: 222 }, lcu.http), 400, /banned/);
    expect(lcu.writes()).toHaveLength(0);
  });

  it("rejects champions that aren't pickable", async () => {
    const lcu = csLcu(advanceTo(draftSession(), 4));
    await expectError(run("champ-select/hover", { championId: 1 }, lcu.http), 400, /pickable/);
  });

  it("declares intent on my future pick during planning", async () => {
    const s = draftSession({ phase: "PLANNING" });
    const pickId = s.actions.flat().find((a) => a.actorCellId === 2 && a.type === "pick")!.id;
    const lcu = csLcu(s, { [`PATCH /lol-champ-select/v1/session/actions/${pickId}`]: ok() });
    await run("champ-select/hover", { championId: 222 }, lcu.http);
    expect(lcu.writes()[0]?.path).toBe(`/lol-champ-select/v1/session/actions/${pickId}`);
  });

  it("refuses to lock when it's not my turn or nothing is hovered", async () => {
    await expectError(run("champ-select/lock", undefined, csLcu(advanceTo(draftSession(), 3)).http), 409, /not your turn/);
    await expectError(run("champ-select/lock", undefined, csLcu(advanceTo(draftSession(), 4)).http), 409, /Select a champion/);
  });

  /** My pick turn with `champ` hovered; routes decide what the fake client does on each call. */
  function lockSetup(champ: number, routes: (mine: { id: number; completed: boolean }) => Record<string, Route>) {
    const s = advanceTo(draftSession(), 4);
    const mine = s.actions[4]!.find((a) => a.actorCellId === 2)!;
    mine.championId = champ;
    const path = `/lol-champ-select/v1/session/actions/${mine.id}`;
    return { lcu: csLcu(s, routes(mine)), path };
  }

  it("locks with PATCH {completed:true} and verifies it", async () => {
    const { lcu, path } = lockSetup(103, (mine) => ({
      [`PATCH /lol-champ-select/v1/session/actions/${mine.id}`]: (body) => {
        if ((body as { completed?: boolean }).completed) mine.completed = true;
        return { status: 204 };
      },
    }));
    await run("champ-select/lock", {}, lcu.http);
    expect(lcu.writes()).toEqual([{ method: "PATCH", path, body: { championId: 103, completed: true } }]);
  });

  it("falls back to POST /complete when the PATCH doesn't lock", async () => {
    const { lcu, path } = lockSetup(222, (mine) => ({
      [`PATCH /lol-champ-select/v1/session/actions/${mine.id}`]: ok(), // 204, no effect
      [`POST /lol-champ-select/v1/session/actions/${mine.id}/complete`]: () => ((mine.completed = true), { status: 204 }),
    }));
    await run("champ-select/lock", undefined, lcu.http);
    expect(lcu.writes().map((w) => `${w.method} ${w.path}`)).toEqual([`PATCH ${path}`, `POST ${path}/complete`]);
  });

  it("reports an error instead of pretending, when nothing locks", async () => {
    const { lcu } = lockSetup(103, (mine) => ({
      [`PATCH /lol-champ-select/v1/session/actions/${mine.id}`]: ok(),
      [`POST /lol-champ-select/v1/session/actions/${mine.id}/complete`]: ok(),
    }));
    await expectError(run("champ-select/lock", undefined, lcu.http), 502, /didn't accept/);
  });

  it("bans using the list League pushed when GET /bannable-champion-ids is empty (seen on a live client)", async () => {
    const s = advanceTo(draftSession(), 0);
    const myBan = s.actions[0]!.find((a) => a.actorCellId === 2)!.id;
    const lcu = csLcu(s, {
      "GET /lol-champ-select/v1/bannable-champion-ids": ok([]),
      [`PATCH /lol-champ-select/v1/session/actions/${myBan}`]: ok(),
    });
    const lists = () => ({ pickable: [103], bannable: [51, 157] });
    await runAction("champ-select/hover", { championId: 51 }, { http: lcu.http, lists });
    expect(lcu.writes()).toEqual([{ method: "PATCH", path: `/lol-champ-select/v1/session/actions/${myBan}`, body: { championId: 51 } }]);
    await expectError(runAction("champ-select/hover", { championId: 222 }, { http: lcu.http, lists }), 400, /banned/);
  });

  it("bans after joining mid champ select: GET answers [-1] and nothing was pushed (2026-11-13)", async () => {
    const s = advanceTo(draftSession(), 0);
    const myBan = s.actions[0]!.find((a) => a.actorCellId === 2)!;
    const lcu = csLcu(s, {
      "GET /lol-champ-select/v1/bannable-champion-ids": ok([-1]),
      [`PATCH /lol-champ-select/v1/session/actions/${myBan.id}`]: ok(),
    });
    const lists = () => ({ pickable: [], bannable: [] });
    const knownChampions = async () => [{ id: 51 }, { id: 157 }, { id: 60051 }];
    const ctx = { http: lcu.http, lists, knownChampions };

    await runAction("champ-select/hover", { championId: 51 }, ctx);
    expect(lcu.writes()).toEqual([{ method: "PATCH", path: `/lol-champ-select/v1/session/actions/${myBan.id}`, body: { championId: 51 } }]);
    // Still only real champions: not a special-mode copy, not an unknown id.
    await expectError(runAction("champ-select/hover", { championId: 60051 }, ctx), 400, /banned/);
    await expectError(runAction("champ-select/hover", { championId: 999 }, ctx), 400, /banned/);
    // And nothing at all if the champion list isn't available either.
    await expectError(runAction("champ-select/hover", { championId: 51 }, { ...ctx, knownChampions: async () => null }), 400);
  });

  it("uses the fallback only when League gave no list", async () => {
    const s = advanceTo(draftSession(), 0);
    const lcu = csLcu(s); // GET bannable = [157, 103]
    const knownChampions = async () => [{ id: 51 }];
    await expectError(runAction("champ-select/hover", { championId: 51 }, { http: lcu.http, knownChampions }), 400, /banned/);
  });

  it("re-validates the hovered champion before locking", async () => {
    const s = advanceTo(draftSession(), 4);
    s.actions[4]!.find((a) => a.actorCellId === 2)!.championId = 1; // not in pickable list anymore
    const lcu = csLcu(s);
    await expectError(run("champ-select/lock", undefined, lcu.http), 400);
    expect(lcu.writes()).toHaveLength(0);
  });
});

describe("swaps", () => {
  const session = () => {
    const s = draftSession();
    s.positionSwaps = [
      { cellId: 1, id: 13, state: "RECEIVED" },
      { cellId: 3, id: 14, state: "AVAILABLE" },
    ];
    s.pickOrderSwaps = [{ cellId: 3, id: 14, state: "SENT" }];
    s.trades = [{ cellId: 0, id: 12, state: "AVAILABLE" }];
    return s;
  };
  const swapLcu = (extra: Record<string, Route> = {}) => fakeLcu({ "GET /lol-champ-select/v1/session": ok(session()), ...extra });

  it("accepts a received role swap using the id from the client's session", async () => {
    const lcu = swapLcu({ "POST /lol-champ-select/v1/session/position-swaps/13/accept": ok({}) });
    await run("champ-select/swap/accept", { kind: "position", cellId: 1 }, lcu.http);
    expect(lcu.writes()).toEqual([{ method: "POST", path: "/lol-champ-select/v1/session/position-swaps/13/accept", body: undefined }]);
  });

  it("requests, declines and cancels only in the matching state", async () => {
    const lcu = swapLcu({
      "POST /lol-champ-select/v1/session/position-swaps/14/request": ok({}),
      "POST /lol-champ-select/v1/session/pick-order-swaps/14/cancel": ok({}),
      "POST /lol-champ-select/v1/session/position-swaps/13/decline": ok({}),
    });
    await run("champ-select/swap/request", { kind: "position", cellId: 3 }, lcu.http);
    await run("champ-select/swap/cancel", { kind: "pickOrder", cellId: 3 }, lcu.http);
    await run("champ-select/swap/decline", { kind: "position", cellId: 1 }, lcu.http);
    expect(lcu.writes().map((w) => w.path)).toEqual([
      "/lol-champ-select/v1/session/position-swaps/14/request",
      "/lol-champ-select/v1/session/pick-order-swaps/14/cancel",
      "/lol-champ-select/v1/session/position-swaps/13/decline",
    ]);
    // Wrong state: accepting something nobody asked for, requesting one already sent, a teammate with no slot.
    await expectError(run("champ-select/swap/accept", { kind: "position", cellId: 3 }, lcu.http), 409);
    await expectError(run("champ-select/swap/request", { kind: "pickOrder", cellId: 3 }, lcu.http), 409);
    await expectError(run("champ-select/swap/request", { kind: "position", cellId: 7 }, lcu.http), 409);
    expect(lcu.writes()).toHaveLength(3);
  });

  it("falls back to the older /trades path for champion trades", async () => {
    const lcu = swapLcu({ "POST /lol-champ-select/v1/session/trades/12/request": ok({}) });
    await run("champ-select/swap/request", { kind: "champion", cellId: 0 }, lcu.http);
    expect(lcu.writes().map((w) => w.path)).toEqual([
      "/lol-champ-select/v1/session/champion-swaps/12/request",
      "/lol-champ-select/v1/session/trades/12/request",
    ]);
  });

  it("rejects bad input before talking to the client", async () => {
    const lcu = swapLcu();
    await expectError(run("champ-select/swap/accept", { kind: "skin", cellId: 1 }, lcu.http), 400, /kind/);
    await expectError(run("champ-select/swap/accept", { kind: "position", cellId: -1 }, lcu.http), 400, /cellId/);
    await expectError(run("champ-select/swap/accept", { kind: "position", cellId: "1" }, lcu.http), 400, /cellId/);
    await expectError(run("champ-select/swap/accept", { kind: "position", cellId: 1, id: 13 }, lcu.http), 400, /unexpected/);
    expect(lcu.calls).toHaveLength(0);
  });
});

describe("loadout", () => {
  const loadout = {
    availableSpells: async () => [{ id: 4 }, { id: 14 }, { id: 12 }],
    selectableSkinIds: async () => new Set([103000, 103001, 103021]),
  };
  const lcu = () =>
    fakeLcu({
      "GET /lol-champ-select/v1/session": ok(draftSession()),
      "PATCH /lol-champ-select/v1/session/my-selection": ok(),
    });

  it("sets two available spells", async () => {
    const l = lcu();
    await runAction("champ-select/spells", { spell1Id: 12, spell2Id: 4 }, { http: l.http, loadout });
    expect(l.writes()).toEqual([{ method: "PATCH", path: "/lol-champ-select/v1/session/my-selection", body: { spell1Id: 12, spell2Id: 4 } }]);
  });

  it("refuses the same spell twice, spells not in this game, and an unreadable spell list", async () => {
    const l = lcu();
    await expectError(runAction("champ-select/spells", { spell1Id: 4, spell2Id: 4 }, { http: l.http, loadout }), 400, /different/);
    await expectError(runAction("champ-select/spells", { spell1Id: 4, spell2Id: 32 }, { http: l.http, loadout }), 400, /isn't available/);
    await expectError(runAction("champ-select/spells", { spell1Id: 4, spell2Id: "14" }, { http: l.http, loadout }), 400, /spell2Id/);
    const blind = { ...loadout, availableSpells: async () => null };
    await expectError(runAction("champ-select/spells", { spell1Id: 4, spell2Id: 14 }, { http: l.http, loadout: blind }), 503);
    expect(l.writes()).toHaveLength(0);
  });

  it("sets a usable skin or chroma, nothing else", async () => {
    const l = lcu();
    await runAction("champ-select/skin", { skinId: 103021 }, { http: l.http, loadout });
    expect(l.writes()).toEqual([{ method: "PATCH", path: "/lol-champ-select/v1/session/my-selection", body: { selectedSkinId: 103021 } }]);
    await expectError(runAction("champ-select/skin", { skinId: 103003 }, { http: l.http, loadout }), 400);
    await expectError(runAction("champ-select/skin", { skinId: 103001, wardSkinId: 1 }, { http: l.http, loadout }), 400, /unexpected/);
  });

  it("needs champion select", async () => {
    const l = fakeLcu({});
    await expectError(runAction("champ-select/skin", { skinId: 103001 }, { http: l.http, loadout }), 409);
    await expectError(runAction("champ-select/spells", { spell1Id: 4, spell2Id: 14 }, { http: l.http, loadout }), 409);
  });
});

describe("friendlyLcuError", () => {
  it("explains the teammate-hover ban refusal and drops the endpoint path", () => {
    const msg = friendlyLcuError(
      "Error response for PATCH /lol-lobby-team-builder/champ-select/v1/session/actions/8: BAN_LOCK_FAILED_TEAMMATE_HOVERING_CHAMPION",
    );
    expect(msg).toMatch(/teammate wants to play that champion/);
    expect(msg).not.toMatch(/lol-lobby|PATCH/);
  });
  it("turns unknown codes into words", () => {
    expect(friendlyLcuError("Error response for POST /x/y: SOME_NEW_CODE")).toBe("League refused: some new code.");
  });
  it("keeps plain messages and handles none", () => {
    expect(friendlyLcuError("Something broke")).toBe("Something broke");
    expect(friendlyLcuError(null)).toBeNull();
  });
});
