import https from "node:https";
import type { AddressInfo } from "node:net";
import selfsigned from "selfsigned";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcuHttp } from "../src/lcu/http";
import { EVENTDATA_PATH, LiveGameWatch, hasStarted, liveGamePort, probeLiveGame, type GameProbe } from "../src/live-game";
import { Store, URI } from "../src/state/store";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A probe that answers from a list (the last answer repeats). */
function scripted(...answers: GameProbe[]) {
  const calls: number[] = [];
  const probe = async () => {
    calls.push(Date.now());
    return answers.length > 1 ? answers.shift()! : answers[0]!;
  };
  return { probe, calls };
}

afterEach(() => vi.useRealTimers());

describe("live game watch", () => {
  it("counts only a GameStart event as started", () => {
    expect(hasStarted({ events: 1, gameStart: 0.05 })).toBe(true);
    expect(hasStarted({ events: 0, gameStart: null })).toBe(false);
    expect(hasStarted({ events: 3, gameStart: null })).toBe(false);
    expect(hasStarted({ status: 404 })).toBe(false);
    expect(hasStarted({ error: "ECONNREFUSED" })).toBe(false);
  });

  it("stays loading until GameStart, then stops asking", async () => {
    vi.useFakeTimers();
    const { probe, calls } = scripted({ error: "ECONNREFUSED" }, { status: 404 }, { events: 0, gameStart: null }, { events: 1, gameStart: 0.05 });
    const onChange = vi.fn();
    const w = new LiveGameWatch(onChange, { probe, intervalMs: 1000 });
    w.start();
    expect(w.stage).toBe("loading");
    await vi.advanceTimersByTimeAsync(2500);
    expect(w.stage).toBe("loading");
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.stage).toBe("playing");
    expect(onChange).toHaveBeenCalledTimes(1);
    const asked = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(asked);
  });

  it("gives up and shows the game as started when the game never answers", async () => {
    vi.useFakeTimers();
    const w = new LiveGameWatch(() => {}, { probe: scripted({ error: "ECONNREFUSED" }).probe, intervalMs: 1000, giveUpMs: 5000 });
    w.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(w.stage).toBe("loading");
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.stage).toBe("playing");
  });

  it("ignores an answer that arrives after the game ended", async () => {
    let answer!: (p: GameProbe) => void;
    const onChange = vi.fn();
    const w = new LiveGameWatch(onChange, { probe: () => new Promise((r) => (answer = r)) });
    w.start();
    w.stop();
    answer({ events: 1, gameStart: 0.05 });
    await tick();
    expect(w.stage).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses port 2999 unless WARD_LIVE_GAME_PORT names another", () => {
    expect(liveGamePort({})).toBe(2999);
    expect(liveGamePort({ WARD_LIVE_GAME_PORT: "47897" })).toBe(47897);
    expect(liveGamePort({ WARD_LIVE_GAME_PORT: "nope" })).toBe(2999);
  });
});

describe("live game probe", () => {
  it("reads the event list from a self-signed local server and reports other answers", async () => {
    const pems = await selfsigned.generate([{ name: "commonName", value: "127.0.0.1" }], { keyType: "ec" });
    let reply: { status: number; body: string } = { status: 404, body: '{"errorCode":"RESOURCE_NOT_FOUND"}' };
    const paths: string[] = [];
    const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(reply.status, { "Content-Type": "application/json" }).end(reply.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await probeLiveGame(port)).toEqual({ status: 404 });
      reply = { status: 200, body: '{"Events":[]}' };
      expect(await probeLiveGame(port)).toEqual({ events: 0, gameStart: null });
      reply = { status: 200, body: '{"Events":[{"EventID":0,"EventName":"GameStart","EventTime":0.0563616},{"EventID":1,"EventName":"MinionsSpawning","EventTime":65.0}]}' };
      expect(await probeLiveGame(port)).toEqual({ events: 2, gameStart: 0.0563616 });
      reply = { status: 200, body: '{"gameMode":"CLASSIC","gameTime":12.5}' };
      expect(await probeLiveGame(port)).toEqual({ status: 200 });
      reply = { status: 200, body: "not json" };
      expect(await probeLiveGame(port)).toEqual({ status: 200 });
      expect(paths.every((p) => p === EVENTDATA_PATH)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await probeLiveGame(port)).toMatchObject({ error: expect.any(String) });
  });
});

describe("store game stage", () => {
  function lcu(phase: string) {
    return { async getOrNull(path: string) { return path === URI.phase ? phase : null; } } as unknown as LcuHttp;
  }

  it("shows the loading screen during InProgress until the game has loaded", async () => {
    let started = false;
    const store = new Store({ liveGame: { probe: async () => ({ events: started ? 1 : 0, gameStart: started ? 0.05 : null }), intervalMs: 5 } });
    store.setLcuStatus("connected");
    store.attach(lcu("InProgress"));
    await tick();
    await tick();
    expect(store.state.phase).toBe("InProgress");
    expect(store.state.game).toBe("loading");
    started = true;
    await vi.waitFor(() => expect(store.state.game).toBe("playing"));
    store.handleEvent({ uri: URI.phase, eventType: "Update", data: "EndOfGame" });
    expect(store.state.game).toBeNull();
    store.detach();
  });

  it("has no game stage outside a game", async () => {
    const probe = vi.fn(async (): Promise<GameProbe> => ({ events: 1, gameStart: 0.05 }));
    const store = new Store({ liveGame: { probe } });
    store.setLcuStatus("connected");
    store.attach(lcu("Lobby"));
    await tick();
    expect(store.state.phase).toBe("Lobby");
    expect(store.state.game).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    store.detach();
  });
});
