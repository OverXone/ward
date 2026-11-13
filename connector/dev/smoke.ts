/**
 * End-to-end smoke test against the mock LCU:  npm run smoke
 *
 * Spawns the mock client and the real connector, pairs via the API like a
 * phone would, plays through lobby → queue → ready check → ban → pick → game,
 * checks that no secret reaches the connector's output, then kills and
 * restarts the mock to verify reconnect, and restarts the connector to check
 * the phone stays paired. Remembered phones go to a temp folder, not %APPDATA%.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { PhoneState } from "../src/shared/phone-api";

const PORT = 47899;
const root = path.resolve(__dirname, "..");
let out = "";
let state: PhoneState | null = null;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "ward-smoke-"));
process.env.WARD_DATA_DIR = dataDir; // inherited by the connector

function start(file: string, args: string[] = [], onLine?: (l: string) => void): ChildProcess {
  const p = spawn(process.execPath, ["--import", "tsx", file, ...args], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const feed = (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      onLine?.(line);
    }
  };
  p.stdout!.on("data", feed);
  p.stderr!.on("data", feed);
  return p;
}

function waitFor<T>(what: string, fn: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function main() {
  // --- mock LCU ---
  let mockLines: string[] = [];
  const mockArgs = process.argv.slice(2); // e.g. --no-complete
  let mock = start("dev/mock-lcu.ts", mockArgs, (l) => mockLines.push(l));
  const dir = await waitFor("mock lockfile dir", () => /--league-dir "([^"]+)"/.exec(mockLines.join("\n"))?.[1]);
  const lcuPassword = readFileSync(path.join(dir, "lockfile"), "utf8").split(":")[3]!;

  // --- connector ---
  const connArgs = ["--league-dir", dir, "--port", String(PORT)];
  const conn = start("src/main.ts", connArgs, (l) => (out += l + "\n"));
  const code = await waitFor("pairing code", () => /enter code:\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(out)?.[1]);
  const base = await waitFor("base url", () => /Or open\s+(http:\/\/[\d.]+:\d+)/.exec(out)?.[1]);
  const host = base.replace("http://", "");
  console.log(`connector at ${base}, code ${code}`);

  const post = async (p: string, body?: unknown, tok?: string) =>
    fetch(base + p, {
      method: "POST",
      headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  // --- pairing ---
  const pairRes = await post("/api/pair", { code });
  check(pairRes.status === 200, "pairing code accepted");
  const { token } = (await pairRes.json()) as { token: string };
  check((await post("/api/pair", { code })).status === 401, "pairing code is single-use");

  // --- websocket ---
  const ws = new WebSocket(`ws://${host}/ws`, { origin: base });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "auth", token }));
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "state") state = m.state;
  });

  await waitFor("Lobby", () => state?.lcu === "connected" && state.phase === "Lobby");
  check(state!.lobby?.queueName === "Ranked Solo/Duo", "lobby + queue name pushed over websocket");

  const act = (name: string, body?: unknown) => post(`/api/${name}`, body, token);
  const get = async <T>(p: string) => (await (await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } })).json()) as T;
  const mockKey = (k: string) => mock.stdin!.write(k + "\n");

  // --- friends & invitations ---
  const friends = await get<{ handle: string; name: string; canInvite: boolean }[]>("/api/friends");
  check(friends.map((f) => f.name).join() === "DuoPartner,MidOrFeed,RankedGrinder", "only online League friends listed");
  check(!JSON.stringify(friends).includes("2001"), "friend ids never reach the phone");
  check((await act("lobby/invite", { friend: friends[0]!.handle })).status === 204, "invite a friend");
  await waitFor("friend joined", () => state?.lobby?.memberCount === 2, 10_000);
  check(true, "invited friend joined the lobby");
  mockKey("i");
  await waitFor("invitation", () => state?.invitations[0]?.from === "DuoPartner" && state.invitations[0].queueName === "Ranked Flex");
  check(true, "received invitation shows inviter and queue");
  check((await act("invitations/decline", { invitation: state!.invitations[0]!.handle })).status === 204, "decline invitation");
  await waitFor("invitation gone", () => state?.invitations.length === 0);
  mockKey("i");
  await waitFor("second invitation", () => state?.invitations.length === 1);
  check((await act("invitations/accept", { invitation: state!.invitations[0]!.handle })).status === 204, "accept invitation");
  await waitFor("joined friend's lobby", () => state?.lobby?.queueName === "Ranked Flex" && !state.lobby.isLeader);
  check(true, "joined the friend's lobby");
  mockKey("l");
  await waitFor("own lobby again", () => state?.lobby?.queueName === "Ranked Solo/Duo" && state.lobby.isLeader);

  check((await act("queue/cancel")).status === 409, "cancel queue refused while not queued");
  check((await act("queue/start")).status === 204, "start queue");
  await waitFor("Matchmaking", () => state?.phase === "Matchmaking" && state.queue);
  check((state as PhoneState | null)?.queue?.estimatedQueueTime === 95, "queue timer pushed");
  await waitFor("ReadyCheck", () => state?.phase === "ReadyCheck" && state.readyCheck?.state === "InProgress", 15_000);
  check((await act("ready-check/accept")).status === 204, "accept ready check");
  await waitFor("ChampSelect", () => state?.phase === "ChampSelect" && state.champSelect);

  // --- champions & icons ---
  const champs = (await (await fetch(base + "/api/champions", { headers: { Authorization: `Bearer ${token}` } })).json()) as { id: number }[];
  check(champs.length > 20 && !champs.some((c) => c.id <= 0), "champion list proxied (id -1 filtered)");
  const icon = await fetch(base + "/api/champions/103/icon", { headers: { Authorization: `Bearer ${token}` } });
  check(icon.status === 200 && icon.headers.get("content-type") === "image/png", "champion icon proxied");
  check((await fetch(base + "/api/champions/999999/icon", { headers: { Authorization: `Bearer ${token}` } })).status === 404, "unknown champion icon → 404");

  // --- planning: intent ---
  check(state!.champSelect!.phase === "PLANNING" && state!.champSelect!.canHoverIntent, "planning phase allows intent");
  check((await act("champ-select/hover", { championId: 103 })).status === 204, "declare intent (Ahri)");
  await waitFor("intent shown", () => state?.champSelect?.myTeam.find((p) => p.isMe)?.pickIntentId === 103);
  check((await act("champ-select/lock")).status === 409, "can't lock during planning");

  // --- ban ---
  await waitFor("my ban turn", () => state?.champSelect?.myTurn?.type === "ban", 20_000);
  check((await act("champ-select/hover", { championId: 999 })).status === 400, "non-existent champion rejected");
  check((await act("champ-select/lock")).status === 409, "lock without hover refused");
  check((await act("champ-select/hover", { championId: 157 })).status === 204, "hover ban (Yasuo)");
  await waitFor("ban hovered", () => state?.champSelect?.myTurn?.championId === 157);
  check((await act("champ-select/lock")).status === 204, "lock ban");
  await waitFor("ban done", () => state?.champSelect?.myTurn === null);

  // --- pick ---
  await waitFor("my pick turn", () => state?.champSelect?.myTurn?.type === "pick", 40_000);
  const cs = state!.champSelect!;
  check(!cs.pickableChampionIds.includes(157), "banned champion no longer pickable");
  const choice = cs.pickableChampionIds.includes(222) ? 222 : cs.pickableChampionIds[0]!;
  const banned = [...cs.bans.myTeam, ...cs.bans.theirTeam][0];
  if (banned) check((await act("champ-select/hover", { championId: banned })).status === 400, "banned champion can't be hovered");
  check((await act("champ-select/hover", { championId: choice })).status === 204, `hover pick (${choice})`);
  await waitFor("pick hovered", () => state?.champSelect?.myTurn?.championId === choice);
  check((await act("champ-select/lock")).status === 204, "lock in");
  await waitFor("locked", () => state?.champSelect?.hasLockedPick);
  check(state!.champSelect!.myTeam.find((p) => p.isMe)!.championId === choice, "my locked champion shown");
  await waitFor("InProgress", () => state?.phase === "InProgress", 60_000);
  check(true, "game started (InProgress)");
  mockKey("i");
  await waitFor("invitation in game", () => state?.invitations.length === 1);
  check((await act("invitations/accept", { invitation: state!.invitations[0]!.handle })).status === 409, "can't join a lobby mid-game");
  check((await act("invitations/decline", { invitation: state!.invitations[0]!.handle })).status === 204, "can decline mid-game");

  // --- reconnect ---
  mock.kill();
  await waitFor("disconnect noticed", () => state?.lcu === "searching", 15_000);
  check(state!.phase === null && state!.champSelect === null, "state cleared when client closes");
  mockLines = [];
  mock = start("dev/mock-lcu.ts", mockArgs, (l) => mockLines.push(l));
  await waitFor("reconnected", () => state?.lcu === "connected" && state.phase === "Lobby", 20_000);
  check(true, "reconnected after client restart");
  const lcuPassword2 = readFileSync(path.join(dir, "lockfile"), "utf8").split(":")[3]!;

  // --- the phone stays paired when Ward restarts ---
  ws.close();
  const exited = new Promise((r) => conn.once("exit", r));
  conn.kill();
  await exited;
  const from = out.length;
  const conn2 = start("src/main.ts", connArgs, (l) => (out += l + "\n"));
  await waitFor("connector restarted", () => out.slice(from).includes("enter code:"));
  check(/Remembered phones[\s\S]*1\. /.test(out.slice(from)), "window lists the remembered phone");
  const again = await fetch(base + "/api/state", { headers: { Authorization: `Bearer ${token}` } });
  check(again.status === 200, "phone key still works after restarting Ward");

  // --- secrets never printed ---
  check(!out.includes(token), "phone key never printed as text");
  check(!out.includes(lcuPassword) && !out.includes(lcuPassword2), "LCU passwords never printed");

  conn2.kill();
  mock.kill();
  rmSync(dataDir, { recursive: true, force: true });
  console.log("\nSMOKE TEST PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n" + (e as Error).message);
  console.error("---- connector output ----\n" + out.split("\n").slice(-40).join("\n"));
  process.exit(1);
});
