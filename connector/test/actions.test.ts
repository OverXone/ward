import { describe, expect, it } from "vitest";
import { ActionError, runAction, type ActionName } from "../src/actions";
import type { HttpMethod, LcuHttp, LcuResponse } from "../src/lcu/http";
import { advanceTo, draftSession } from "./fixtures/sessions";

type Route = (body: unknown) => { status: number; json?: unknown };

/** Fake LCU: records every call and answers from a route table keyed by "METHOD path". */
function fakeLcu(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const request = async (method: HttpMethod, path: string, body?: unknown): Promise<LcuResponse> => {
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    const r = route ? route(body) : { status: 404, json: { message: "Invalid URI format" } };
    return { status: r.status, contentType: "application/json", body: Buffer.from(r.json === undefined ? "" : JSON.stringify(r.json)) };
  };
  const http = {
    request,
    async json(method: HttpMethod, path: string, body?: unknown) {
      const res = await request(method, path, body);
      return { status: res.status, data: res.body.length ? JSON.parse(res.body.toString()) : undefined };
    },
    async getOrNull(path: string) {
      const res = await request("GET", path);
      return res.status === 200 && res.body.length ? JSON.parse(res.body.toString()) : null;
    },
  } as unknown as LcuHttp;
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { http, calls, writes };
}

const ok = (json?: unknown): Route => () => ({ status: json === undefined ? 204 : 200, json });

async function expectError(p: Promise<unknown>, status: number, msg?: RegExp) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ActionError);
  expect((err as ActionError).status).toBe(status);
  if (msg) expect((err as ActionError).message).toMatch(msg);
}

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

  it("re-hovers, completes, and verifies the lock", async () => {
    const { lcu, path } = lockSetup(103, (mine) => ({
      [`PATCH /lol-champ-select/v1/session/actions/${mine.id}`]: ok(),
      [`POST /lol-champ-select/v1/session/actions/${mine.id}/complete`]: () => ((mine.completed = true), { status: 204 }),
    }));
    await run("champ-select/lock", {}, lcu.http);
    expect(lcu.writes()).toEqual([
      { method: "PATCH", path, body: { championId: 103 } },
      { method: "POST", path: `${path}/complete`, body: undefined },
    ]);
  });

  it("falls back to PATCH {completed:true} when /complete says OK but doesn't lock (seen on a live client)", async () => {
    const { lcu, path } = lockSetup(222, (mine) => ({
      [`PATCH /lol-champ-select/v1/session/actions/${mine.id}`]: (body) => {
        if ((body as { completed?: boolean }).completed) mine.completed = true;
        return { status: 204 };
      },
      [`POST /lol-champ-select/v1/session/actions/${mine.id}/complete`]: ok(), // 204, no effect
    }));
    await run("champ-select/lock", undefined, lcu.http);
    expect(lcu.writes().map((w) => `${w.method} ${w.path}`)).toEqual([`PATCH ${path}`, `POST ${path}/complete`, `PATCH ${path}`]);
    expect(lcu.writes()[2]?.body).toEqual({ championId: 222, completed: true });
  });

  it("falls back when /complete is 404 (older clients)", async () => {
    const { lcu } = lockSetup(222, (mine) => ({
      [`PATCH /lol-champ-select/v1/session/actions/${mine.id}`]: (body) => {
        if ((body as { completed?: boolean }).completed) mine.completed = true;
        return { status: 204 };
      },
    }));
    await run("champ-select/lock", undefined, lcu.http);
    expect(lcu.writes()).toHaveLength(3);
  });

  it("reports an error instead of pretending, when nothing locks", async () => {
    const { lcu } = lockSetup(103, (mine) => ({
      [`PATCH /lol-champ-select/v1/session/actions/${mine.id}`]: ok(),
      [`POST /lol-champ-select/v1/session/actions/${mine.id}/complete`]: ok(),
    }));
    await expectError(run("champ-select/lock", undefined, lcu.http), 502, /didn't accept/);
  });

  it("re-validates the hovered champion before locking", async () => {
    const s = advanceTo(draftSession(), 4);
    s.actions[4]!.find((a) => a.actorCellId === 2)!.championId = 1; // not in pickable list anymore
    const lcu = csLcu(s);
    await expectError(run("champ-select/lock", undefined, lcu.http), 400);
    expect(lcu.writes()).toHaveLength(0);
  });
});
