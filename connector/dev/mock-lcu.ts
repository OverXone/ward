/**
 * Mock League Client (LCU) for development without the real game.
 *
 *   npm run mock-lcu                       start (prints the --league-dir to pass to the connector)
 *   npm run mock-lcu -- --no-complete      make POST .../complete return 404 (tests the PATCH fallback)
 *
 * Serves HTTPS + WSS on 127.0.0.1 with a throwaway self-signed cert and writes a
 * lockfile into a temp folder. Shapes are modelled on the real client but
 * simplified; the real client is the source of truth.
 *
 * Keys: l=lobby  q=queue  r=ready check  c=champ select  n=finish current turn  g=in game  0=none  h=help
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import selfsigned from "selfsigned";
import { WebSocketServer, WebSocket } from "ws";

const noComplete = process.argv.includes("--no-complete");

// ---------- static data ----------

const CHAMPIONS: { id: number; name: string; alias: string; color: [number, number, number] }[] = [
  { id: 1, name: "Annie", alias: "Annie", color: [200, 60, 60] },
  { id: 22, name: "Ashe", alias: "Ashe", color: [90, 140, 220] },
  { id: 51, name: "Caitlyn", alias: "Caitlyn", color: [140, 90, 200] },
  { id: 64, name: "Lee Sin", alias: "LeeSin", color: [220, 140, 40] },
  { id: 86, name: "Garen", alias: "Garen", color: [60, 120, 200] },
  { id: 89, name: "Leona", alias: "Leona", color: [230, 190, 60] },
  { id: 99, name: "Lux", alias: "Lux", color: [240, 220, 120] },
  { id: 103, name: "Ahri", alias: "Ahri", color: [220, 90, 160] },
  { id: 157, name: "Yasuo", alias: "Yasuo", color: [80, 160, 160] },
  { id: 222, name: "Jinx", alias: "Jinx", color: [70, 110, 230] },
  { id: 266, name: "Aatrox", alias: "Aatrox", color: [150, 30, 40] },
  { id: 412, name: "Thresh", alias: "Thresh", color: [50, 170, 110] },
  { id: 875, name: "Sett", alias: "Sett", color: [180, 100, 60] },
  { id: 147, name: "Seraphine", alias: "Seraphine", color: [240, 150, 200] },
];
const ALL_IDS = CHAMPIONS.map((c) => c.id);

function png(color: [number, number, number], size = 32): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from(color)))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const ICONS = new Map(CHAMPIONS.map((c) => [c.id, png(c.color)]));

// ---------- state ----------

interface Action {
  id: number;
  actorCellId: number;
  championId: number;
  completed: boolean;
  isAllyAction: boolean;
  isInProgress: boolean;
  pickTurn: number;
  type: string;
}

const LOCAL_CELL = 2;
const state: Record<string, unknown> = {};
let session: any = null;
let timers: NodeJS.Timeout[] = [];
const sockets = new Set<WebSocket>();

const URIS = {
  phase: "/lol-gameflow/v1/gameflow-phase",
  lobby: "/lol-lobby/v2/lobby",
  search: "/lol-matchmaking/v1/search",
  readyCheck: "/lol-matchmaking/v1/ready-check",
  session: "/lol-champ-select/v1/session",
  pickable: "/lol-champ-select/v1/pickable-champion-ids",
  bannable: "/lol-champ-select/v1/bannable-champion-ids",
};

function set(uri: string, value: unknown): void {
  if (value === null || value === undefined) delete state[uri];
  else state[uri] = value;
  const msg = JSON.stringify([8, "OnJsonApiEvent", { uri, eventType: value == null ? "Delete" : "Update", data: value ?? null }]);
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function later(ms: number, fn: () => void): void {
  timers.push(setTimeout(fn, ms));
}

function clearTimers(): void {
  timers.forEach(clearTimeout);
  timers = [];
}

function say(msg: string): void {
  console.log(`[mock] ${msg}`);
}

// ---------- scenario ----------

function toNone(): void {
  clearTimers();
  session = null;
  for (const uri of Object.values(URIS)) set(uri, null);
  set(URIS.phase, "None");
}

function toLobby(): void {
  clearTimers();
  session = null;
  set(URIS.session, null);
  set(URIS.readyCheck, null);
  set(URIS.search, null);
  set(URIS.lobby, { canStartActivity: true, localMember: { isLeader: true, puuid: "mock-puuid" }, gameConfig: { queueId: 420 }, members: [{}] });
  set(URIS.phase, "Lobby");
  say("phase Lobby");
}

function toQueue(): void {
  clearTimers();
  let t = 0;
  const tick = () => {
    set(URIS.search, { searchState: "Searching", timeInQueue: t, estimatedQueueTime: 95, isCurrentlyInQueue: true, errors: [], lowPriorityData: { penaltyTime: 0, penaltyTimeRemaining: 0 } });
    t++;
    if (t === 8) toReadyCheck();
    else later(1000, tick);
  };
  set(URIS.phase, "Matchmaking");
  say("phase Matchmaking (ready check pops in 8 s)");
  tick();
}

function toReadyCheck(): void {
  clearTimers();
  let t = 0;
  const tick = () => {
    const rc = (state[URIS.readyCheck] as any) ?? {};
    set(URIS.readyCheck, { state: "InProgress", playerResponse: rc.playerResponse ?? "None", timer: t, declinerIds: [], dodgeWarning: "None" });
    t++;
    if (t > 12) {
      say("ready check expired");
      set(URIS.readyCheck, null);
      toQueue();
    } else later(1000, tick);
  };
  set(URIS.readyCheck, { state: "InProgress", playerResponse: "None", timer: 0 });
  set(URIS.phase, "ReadyCheck");
  say("phase ReadyCheck");
  tick();
}

function toChampSelect(): void {
  clearTimers();
  set(URIS.readyCheck, null);
  set(URIS.search, null);
  let id = 1;
  const mk = (cell: number, type: string, turn: number): Action => ({
    id: id++,
    actorCellId: cell,
    championId: 0,
    completed: false,
    isAllyAction: cell < 5,
    isInProgress: false,
    pickTurn: turn,
    type,
  });
  const actions: Action[][] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => mk(c, "ban", 1)),
    [mk(-1, "ten_bans_reveal", 2)],
    [mk(0, "pick", 3)],
    [mk(5, "pick", 4), mk(6, "pick", 4)],
    [mk(1, "pick", 5), mk(2, "pick", 5)],
    [mk(7, "pick", 6), mk(8, "pick", 6)],
    [mk(3, "pick", 7), mk(4, "pick", 7)],
    [mk(9, "pick", 8)],
  ];
  const positions = ["top", "jungle", "middle", "bottom", "utility"];
  const member = (cell: number) => ({
    cellId: cell,
    championId: 0,
    championPickIntent: 0,
    assignedPosition: positions[cell % 5],
    gameName: cell < 5 ? ["Teemo Enjoyer", "JungleDiff", "", "AdcMain", "WardBot"][cell] : "",
    tagLine: "EUW",
    puuid: `puuid-${cell}`,
    summonerId: 1000 + cell,
    playerType: "PLAYER",
    team: cell < 5 ? 1 : 2,
    spell1Id: 4,
    spell2Id: 14,
  });
  session = {
    actions,
    localPlayerCellId: LOCAL_CELL,
    myTeam: [0, 1, 2, 3, 4].map(member),
    theirTeam: [5, 6, 7, 8, 9].map(member),
    bans: { myTeamBans: [], theirTeamBans: [], numBans: 10 },
    timer: { phase: "PLANNING", adjustedTimeLeftInPhase: 10000, totalTimeInPhase: 10000, isInfinite: false, internalNowInEpochMs: Date.now() },
    chatDetails: { multiUserChatId: "mock", multiUserChatPassword: "secret-chat-pw" },
    isSpectating: false,
    hasSimultaneousBans: true,
    hasSimultaneousPicks: false,
  };
  set(URIS.phase, "ChampSelect");
  publishSession();
  say(`phase ChampSelect (you are cell ${LOCAL_CELL}); planning 10 s`);
  later(10000, () => startNextTurn());
}

function allActions(): Action[] {
  return session ? (session.actions as Action[][]).flat() : [];
}

function memberByCell(cell: number): any {
  return [...session.myTeam, ...session.theirTeam].find((m: any) => m.cellId === cell);
}

function takenIds(): Set<number> {
  const s = new Set<number>();
  for (const a of allActions()) if (a.completed && a.championId > 0) s.add(a.championId);
  return s;
}

function publishSession(): void {
  if (!session) return;
  const taken = takenIds();
  const banned = new Set(allActions().filter((a) => a.type === "ban" && a.completed).map((a) => a.championId));
  set(URIS.pickable, ALL_IDS.filter((x) => !taken.has(x)));
  set(URIS.bannable, ALL_IDS.filter((x) => !banned.has(x)));
  session.timer.internalNowInEpochMs = Date.now();
  set(URIS.session, structuredClone(session));
}

function currentGroup(): Action[] | null {
  return (session?.actions as Action[][]).find((g) => g.some((a) => !a.completed)) ?? null;
}

function startNextTurn(): void {
  if (!session) return;
  clearTimers();
  for (const a of allActions()) a.isInProgress = false;
  const group = currentGroup();
  if (!group) {
    session.timer = { ...session.timer, phase: "FINALIZATION", adjustedTimeLeftInPhase: 10000, totalTimeInPhase: 10000 };
    publishSession();
    say("FINALIZATION (game starts in 10 s)");
    later(10000, toGame);
    return;
  }
  group.forEach((a) => (a.isInProgress = true));
  session.timer = { ...session.timer, phase: "BAN_PICK", adjustedTimeLeftInPhase: 30000, totalTimeInPhase: 30000 };
  publishSession();

  if (group[0]?.type === "ten_bans_reveal") {
    later(2000, () => {
      group[0]!.completed = true;
      session.bans.myTeamBans = allActions().filter((a) => a.type === "ban" && a.isAllyAction && a.championId > 0).map((a) => a.championId);
      session.bans.theirTeamBans = allActions().filter((a) => a.type === "ban" && !a.isAllyAction && a.championId > 0).map((a) => a.championId);
      startNextTurn();
    });
    return;
  }
  const mine = group.find((a) => a.actorCellId === LOCAL_CELL);
  say(`turn: ${group.map((a) => `${a.type}@cell${a.actorCellId}`).join(", ")}${mine ? "  <-- YOUR TURN" : ""}`);
  // Everyone else acts after a few seconds.
  for (const a of group.filter((x) => x.actorCellId !== LOCAL_CELL)) {
    later(2000 + Math.random() * 3000, () => botAct(a));
  }
}

function botAct(a: Action): void {
  const taken = takenIds();
  const options = ALL_IDS.filter((x) => !taken.has(x) && !allActions().some((o) => o !== a && o.isInProgress && o.championId === x));
  a.championId = options[Math.floor(Math.random() * options.length)] ?? 0;
  complete(a);
}

function complete(a: Action): void {
  a.completed = true;
  a.isInProgress = false;
  if (a.type === "pick") memberByCell(a.actorCellId).championId = a.championId;
  const group = (session.actions as Action[][]).find((g) => g.includes(a))!;
  if (group.every((x) => x.completed)) startNextTurn();
  else publishSession();
}

function finishCurrentTurn(): void {
  const group = currentGroup();
  if (!group) return;
  for (const a of group.filter((x) => !x.completed)) botAct(a);
}

function toGame(): void {
  clearTimers();
  session = null;
  set(URIS.session, null);
  set(URIS.pickable, null);
  set(URIS.bannable, null);
  set(URIS.phase, "GameStart");
  later(1500, () => set(URIS.phase, "InProgress"));
  say("phase GameStart -> InProgress");
}

// ---------- HTTP ----------

const password = randomBytes(16).toString("base64url");
const expectedAuth = "Basic " + Buffer.from(`riot:${password}`).toString("base64");

function lcuError(res: any, status: number, message: string): void {
  const body = JSON.stringify({ errorCode: "RPC_ERROR", httpStatus: status, message });
  res.writeHead(status, { "Content-Type": "application/json" }).end(body);
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function handle(req: any, res: any): Promise<void> {
  if (req.headers.authorization !== expectedAuth) return lcuError(res, 401, "Unauthorized");
  const url = new URL(req.url, "https://127.0.0.1");
  const p = url.pathname;
  const m = req.method;
  const body = await readBody(req);
  say(`${m} ${p}${body !== undefined ? " " + JSON.stringify(body) : ""}`);

  if (m === "GET" && Object.values(URIS).includes(p)) {
    if (!(p in state)) return lcuError(res, 404, `No ${p}`);
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state[p]));
  }
  if (m === "GET" && p === "/lol-game-data/assets/v1/champion-summary.json") {
    const list = [{ id: -1, name: "None", alias: "None" }, ...CHAMPIONS.map(({ id, name, alias }) => ({ id, name, alias, squarePortraitPath: `/lol-game-data/assets/v1/champion-icons/${id}.png`, roles: [] }))];
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list));
  }
  const icon = /^\/lol-game-data\/assets\/v1\/champion-icons\/(\d+)\.png$/.exec(p);
  if (m === "GET" && icon) {
    const buf = ICONS.get(Number(icon[1]));
    if (!buf) return lcuError(res, 404, "no icon");
    return void res.writeHead(200, { "Content-Type": "image/png" }).end(buf);
  }
  if (m === "GET" && p === "/lol-game-queues/v1/queues/420") {
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: 420, name: "Ranked Solo/Duo", description: "Ranked Solo/Duo", shortName: "Ranked" }));
  }
  if (m === "POST" && p === "/lol-lobby/v2/lobby/matchmaking/search") {
    if (state[URIS.phase] !== "Lobby") return lcuError(res, 400, "Not in lobby");
    toQueue();
    return void res.writeHead(204).end();
  }
  if (m === "DELETE" && p === "/lol-lobby/v2/lobby/matchmaking/search") {
    toLobby();
    return void res.writeHead(204).end();
  }
  if (m === "POST" && (p === "/lol-matchmaking/v1/ready-check/accept" || p === "/lol-matchmaking/v1/ready-check/decline")) {
    const rc = state[URIS.readyCheck] as any;
    if (!rc) return lcuError(res, 400, "No ready check");
    const accepted = p.endsWith("accept");
    set(URIS.readyCheck, { ...rc, playerResponse: accepted ? "Accepted" : "Declined" });
    clearTimers();
    if (accepted) later(1500, toChampSelect);
    else later(500, toLobby);
    return void res.writeHead(204).end();
  }
  const act = /^\/lol-champ-select\/v1\/session\/actions\/(\d+)(\/complete)?$/.exec(p);
  if (act && session) {
    const a = allActions().find((x) => x.id === Number(act[1]));
    if (!a) return lcuError(res, 404, "No such action");
    if (a.actorCellId !== LOCAL_CELL) return lcuError(res, 403, "Not your action");
    if (act[2]) {
      if (noComplete) return lcuError(res, 404, "Invalid URI format");
      if (m !== "POST") return lcuError(res, 405, "Method not allowed");
      if (!a.isInProgress || !(a.championId > 0)) return lcuError(res, 400, "Action not completable");
      complete(a);
      return void res.writeHead(204).end();
    }
    if (m === "PATCH") {
      if (body?.championId !== undefined) {
        if (!ALL_IDS.includes(body.championId) || takenIds().has(body.championId)) return lcuError(res, 400, "Invalid champion");
        a.championId = body.championId;
        if (a.type === "pick" && !a.isInProgress) memberByCell(LOCAL_CELL).championPickIntent = body.championId;
      }
      if (body?.completed === true) {
        if (!a.isInProgress || !(a.championId > 0)) return lcuError(res, 400, "Action not completable");
        complete(a);
      } else publishSession();
      return void res.writeHead(204).end();
    }
  }
  return lcuError(res, 404, `Invalid URI format: ${p}`);
}

// ---------- boot ----------

const dir = path.join(os.tmpdir(), "ward-mock");

void selfsigned.generate([{ name: "commonName", value: "127.0.0.1" }], { days: 1, keySize: 2048 }).then((pems) => {
  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => void handle(req, res));
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== expectedAuth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg[0] === 5) {
          sockets.add(ws);
          say(`websocket subscribed to ${msg[1]}`);
        }
      });
      ws.on("close", () => sockets.delete(ws));
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "lockfile"), `LeagueClient:${process.pid}:${port}:${password}:https`);
    toLobby();
    console.log(`\nMock LCU on https://127.0.0.1:${port}${noComplete ? "  (POST /complete disabled)" : ""}`);
    console.log(`Run the connector with:  npm run dev -- --league-dir "${dir}"`);
    console.log("Keys: l=lobby q=queue r=ready check c=champ select n=finish current turn g=in game 0=none x=quit\n");
  });
});

const cleanup = () => {
  try {
    rmSync(path.join(dir, "lockfile"));
  } catch {
    // ignore
  }
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", (_s, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
    if (key.ctrl && key.name === "c") cleanup();
    const k = key.sequence;
    if (k === "x") cleanup();
    else if (k === "l") toLobby();
    else if (k === "q") toQueue();
    else if (k === "r") toReadyCheck();
    else if (k === "c") toChampSelect();
    else if (k === "n") finishCurrentTurn();
    else if (k === "g") toGame();
    else if (k === "0") toNone();
  });
} else {
  // Non-interactive: accept commands line by line on stdin (used by automated smoke tests).
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const k = line.trim();
    ({ l: toLobby, q: toQueue, r: toReadyCheck, c: toChampSelect, n: finishCurrentTurn, g: toGame, "0": toNone, x: cleanup } as Record<string, () => void>)[k]?.();
  });
}
