/**
 * Mock League Client (LCU) for development without the real game.
 *
 *   npm run mock-lcu                       start (prints the --league-dir to pass to the connector)
 *   npm run mock-lcu -- --no-complete      make POST .../complete return 404 (tests the PATCH fallback)
 *   npm run mock-lcu -- --lazy-complete    make POST .../complete answer 204 without locking (like a live client did)
 *
 * Serves HTTPS + WSS on 127.0.0.1 with a throwaway self-signed cert and writes a
 * lockfile into a temp folder. Shapes are modelled on the real client but
 * simplified; the real client is the source of truth.
 *
 * Keys: l=lobby  q=queue  r=ready check  c=champ select  n=finish current turn  g=in game  0=none  h=help
 *       s / o / t = a teammate asks you to swap roles / pick order / champions
 *       i = a friend invites you to their lobby   w = a teammate writes in the lobby / champ select chat
 *       f = freeze (stop answering HTTP, like a hung client); f again to thaw
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
// Imitates what a live client did on 2026-11-12: POST .../complete answers 204 but locks nothing.
const lazyComplete = process.argv.includes("--lazy-complete");

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
  // More names so a full draft (10 bans + 10 picks) still leaves a grid to choose from.
  ...[
    [2, "Olaf"], [3, "Galio"], [4, "Twisted Fate"], [5, "Xin Zhao"], [6, "Urgot"], [7, "LeBlanc"], [8, "Vladimir"],
    [10, "Kayle"], [11, "Master Yi"], [12, "Alistar"], [13, "Ryze"], [14, "Sion"], [15, "Sivir"], [16, "Soraka"],
    [17, "Teemo"], [18, "Tristana"], [19, "Warwick"], [20, "Nunu & Willump"], [21, "Miss Fortune"], [23, "Tryndamere"],
    [24, "Jax"], [25, "Morgana"], [26, "Zilean"], [27, "Singed"], [28, "Evelynn"], [29, "Twitch"], [30, "Karthus"],
  ].map(([id, name], i) => ({
    id: id as number,
    name: name as string,
    alias: (name as string).replace(/[^A-Za-z]/g, ""),
    color: [60 + ((i * 47) % 180), 60 + ((i * 89) % 180), 60 + ((i * 131) % 180)] as [number, number, number],
  })),
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

const SPELLS = [
  { id: 4, name: "Flash", color: [240, 220, 80] },
  { id: 14, name: "Ignite", color: [230, 90, 40] },
  { id: 12, name: "Teleport", color: [150, 80, 220] },
  { id: 7, name: "Heal", color: [80, 200, 120] },
  { id: 21, name: "Barrier", color: [240, 200, 140] },
  { id: 3, name: "Exhaust", color: [150, 120, 60] },
  { id: 11, name: "Smite", color: [90, 150, 230] },
  { id: 6, name: "Ghost", color: [120, 200, 230] },
  { id: 1, name: "Cleanse", color: [100, 220, 220] },
  { id: 32, name: "Mark", color: [200, 220, 240] }, // ARAM only: never offered in this mock's CLASSIC games
  { id: 13, name: "Clarity", color: [60, 120, 240] }, // ARAM only
] as const;
const SPELL_ICONS = new Map<number, Buffer>(SPELLS.map((s) => [s.id, png([...s.color] as [number, number, number])]));
const ARAM_ONLY = new Set([32, 13]);

/** Skins for a champion: the base skin, two owned skins (one with chromas) and one not owned. */
function skinsFor(champ: number) {
  const tile = (id: number) => `/lol-game-data/assets/v1/champion-tiles/${champ}/${id}.jpg`;
  const chroma = (id: number, name: string, color: string) => ({ id, championId: champ, name, unlocked: true, disabled: false, chromaPreviewPath: `/lol-game-data/assets/v1/champion-chroma-images/${champ}/${id}.png`, colors: [color, color] });
  const b = champ * 1000;
  return [
    { id: b, championId: champ, name: CHAMPIONS.find((c) => c.id === champ)?.name ?? "Champion", isBase: true, unlocked: true, disabled: false, tilePath: tile(b), childSkins: [] },
    { id: b + 1, championId: champ, name: "Arcade " + (CHAMPIONS.find((c) => c.id === champ)?.name ?? ""), isBase: false, unlocked: true, disabled: false, tilePath: tile(b + 1), childSkins: [chroma(b + 21, "Ruby", "#d33a3a"), chroma(b + 22, "Sapphire", "#3a6bd3"), { ...chroma(b + 23, "Obsidian", "#222222"), unlocked: false }] },
    { id: b + 2, championId: champ, name: "Star Guardian " + (CHAMPIONS.find((c) => c.id === champ)?.name ?? ""), isBase: false, unlocked: true, disabled: false, tilePath: tile(b + 2), childSkins: [] },
    { id: b + 3, championId: champ, name: "Prestige " + (CHAMPIONS.find((c) => c.id === champ)?.name ?? ""), isBase: false, unlocked: false, disabled: false, tilePath: tile(b + 3), childSkins: [] },
  ];
}
function jpgLike(seed: number): Buffer {
  // The phone only needs a valid image; a PNG served as image/png is fine for the mock.
  return png([60 + ((seed * 53) % 180), 60 + ((seed * 97) % 180), 60 + ((seed * 31) % 180)], 48);
}

// ---------- friends & invitations ----------

const FRIENDS = [
  { summonerId: 2001, gameName: "DuoPartner", availability: "chat", product: "league_of_legends", lol: { gameStatus: "outOfGame" } },
  { summonerId: 2002, gameName: "MidOrFeed", availability: "away", product: "league_of_legends", lol: { gameStatus: "outOfGame" } },
  { summonerId: 2003, gameName: "RankedGrinder", availability: "dnd", product: "league_of_legends", lol: { gameStatus: "inGame" } },
  { summonerId: 2004, gameName: "ValorantMain", availability: "chat", product: "valorant", lol: null },
  { summonerId: 2005, gameName: "Sleepy", availability: "offline", product: "league_of_legends", lol: null },
  { summonerId: 2006, gameName: "OnTheBus", availability: "mobile", product: "league_of_legends", lol: null },
].map((f) => ({ ...f, name: f.gameName, puuid: `0000mock-0000-0000-0000-00000000${f.summonerId}`, pid: `${f.summonerId}@mock.pvp.net`, note: "" }));
const INVITATIONS = "/lol-lobby/v2/received-invitations";
let invitations: { invitationId: string; state: string; canAcceptInvitation: boolean; fromSummonerId: number; fromSummonerName: string; gameConfig: { queueId: number; gameMode: string } }[] = [];
let sentInvites: { toSummonerId: number; state: string }[] = [];
let nextInvite = 1;

function publishInvitations(): void {
  set(INVITATIONS, structuredClone(invitations));
}

/** Key i: a friend invites me to a Ranked Flex lobby. */
function incomingInvite(): void {
  invitations.push({ invitationId: `inv-${nextInvite++}`, state: "Pending", canAcceptInvitation: true, fromSummonerId: 2001, fromSummonerName: "", gameConfig: { queueId: 440, gameMode: "CLASSIC" } });
  say("DuoPartner invited you to Ranked Flex");
  publishInvitations();
}

// ---------- game modes ----------

/** Like LolGameQueuesQueue, trimmed. Includes entries the phone must not offer (custom, tutorial, switched off, hidden). */
const QUEUE_LIST = [
  { id: 490, name: "Quickplay", description: "Quickplay", gameMode: "CLASSIC", category: "PvP", slots: true },
  { id: 480, name: "Swiftplay", description: "Swiftplay", gameMode: "SWIFTPLAY", category: "PvP", slots: true },
  { id: 400, name: "Normal Draft", description: "Normal Draft", gameMode: "CLASSIC", category: "PvP", roles: true },
  { id: 420, name: "Ranked Solo/Duo", description: "Ranked Solo/Duo", shortName: "Ranked", gameMode: "CLASSIC", category: "PvP", roles: true, allowablePremadeSizes: [1, 2] },
  { id: 440, name: "Ranked Flex", description: "Ranked Flex", shortName: "Flex", gameMode: "CLASSIC", category: "PvP", roles: true, allowablePremadeSizes: [1, 2, 3, 5] },
  { id: 450, name: "ARAM", description: "ARAM", gameMode: "ARAM", category: "PvP" },
  { id: 1700, name: "Arena", description: "Arena", gameMode: "CHERRY", category: "PvP" },
  { id: 1900, name: "URF", description: "URF", gameMode: "URF", category: "PvP", queueAvailability: "PlatformDisabled" },
  { id: 870, name: "Co-op vs. AI Intro", description: "Co-op vs. AI Intro", gameMode: "CLASSIC", category: "VersusAi" },
  { id: 890, name: "Co-op vs. AI Intermediate", description: "Co-op vs. AI Intermediate", gameMode: "CLASSIC", category: "VersusAi" },
  { id: 1090, name: "Teamfight Tactics", description: "Teamfight Tactics", gameMode: "TFT", category: "PvP" },
  { id: 2000, name: "Tutorial 1", description: "Tutorial 1", gameMode: "TUTORIAL_MODULE_1", category: "VersusAi" },
  { id: 3100, name: "Custom", description: "Custom", gameMode: "PRACTICETOOL", category: "Custom", isCustom: true },
  { id: 3200, name: "Hidden test queue", description: "Hidden test queue", gameMode: "CLASSIC", category: "PvP", isVisible: false },
].map((q) => ({
  isVisible: true,
  isEnabled: true,
  isCustom: false,
  queueAvailability: "Available",
  allowablePremadeSizes: [1, 2, 3, 4, 5],
  ...q,
  showPositionSelector: !!q.roles,
  showQuickPlaySlotSelection: !!q.slots,
}));

/** Like POST /lol-lobby/v2/eligibility/party: Co-op Intro is for new accounts, Solo/Duo takes at most two. */
function eligibility(partySize: number) {
  return QUEUE_LIST.map((q) => {
    const restrictions: { restrictionCode: string }[] = [];
    if (q.id === 870) restrictions.push({ restrictionCode: "PlayerMaxLevelRestriction" });
    if (!q.allowablePremadeSizes.includes(partySize)) restrictions.push({ restrictionCode: "TeamMaxSizeRestriction" });
    if (q.slots) restrictions.push({ restrictionCode: "QPPlayerPositionCoverageRestriction" }); // slots not set yet: still pickable
    return { queueId: q.id, eligible: restrictions.length === 0, restrictions };
  });
}

/** My roles in the lobby (LolLobbyLobbyParticipantDto first/secondPositionPreference). */
let myRoles: [string, string] = ["MIDDLE", "BOTTOM"];
const ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY", "FILL", "UNSELECTED"];

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
/** When the current champ-select phase/turn ends (like the real client, timeLeft counts down within a turn). */
let phaseEndsAt = 0;
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
  subset: "/lol-lobby-team-builder/champ-select/v1/subset-champion-list",
};

function set(uri: string, value: unknown): void {
  if (value === null || value === undefined) delete state[uri];
  else state[uri] = value;
  emit(uri, value == null ? "Delete" : "Update", value ?? null);
}

function emit(uri: string, eventType: string, data: unknown): void {
  const msg = JSON.stringify([8, "OnJsonApiEvent", { uri, eventType, data }]);
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

// ---------- chat ----------

const CHAT = "/lol-chat/v1/conversations";
const ME_IN_CHAT = { puuid: "mock-puuid", summonerId: 1002, pid: "1002@mock.pvp.net", id: "1002@mock.pvp.net", gameName: "You", name: "You" };
interface MockConversation {
  id: string;
  type: string;
  messages: Record<string, unknown>[];
}
// A private conversation with a friend: the phone must never show it.
const conversations = new Map<string, MockConversation>([
  ["2001@mock.pvp.net", { id: "2001@mock.pvp.net", type: "chat", messages: [{ id: "dm-1", type: "chat", body: "private: not for the lobby", fromPuuid: FRIENDS[0]!.puuid, timestamp: new Date().toISOString() }] }],
]);
let lobbyChat: string | null = null;
let champSelectChat: string | null = null;
let nextChat = 1;
let nextMessage = 1;

/** Opens a group chat; returns its multiUserChatId (the conversation id is that plus a domain, like on a live client). */
function openChat(kind: "lobby" | "champSelect"): string {
  const muc = `${kind === "lobby" ? "lobby" : "champ-select"}-${nextChat++}`;
  const id = `${muc}@${kind === "lobby" ? "sec" : "champ-select"}.mock.pvp.net`;
  conversations.set(id, { id, type: kind === "lobby" ? "customGame" : "championSelect", messages: [] });
  emit(`${CHAT}/${id}`, "Create", { id });
  return muc;
}

function closeChat(muc: string | null): void {
  const c = muc ? conversationOf(muc) : undefined;
  if (!c) return;
  conversations.delete(c.id);
  emit(`${CHAT}/${c.id}`, "Delete", null);
}

const conversationOf = (muc: string) => [...conversations.values()].find((c) => c.id.startsWith(`${muc}@`));

type Sender = { puuid: string; summonerId: number; pid?: string };
const friendSender = (summonerId: number): Sender => {
  const f = FRIENDS.find((x) => x.summonerId === summonerId)!;
  return { puuid: f.puuid, summonerId, pid: f.pid };
};
const allySender = (cell: number): Sender => ({ puuid: `puuid-${cell}`, summonerId: 1000 + cell });

function postChat(muc: string | null, from: Sender, body: string, type = "groupchat"): void {
  const c = muc ? conversationOf(muc) : undefined;
  if (!c) return;
  const msg = {
    id: `m${nextMessage++}`,
    type,
    body,
    timestamp: new Date().toISOString(),
    isHistorical: false,
    fromPuuid: from.puuid,
    fromSummonerId: from.summonerId,
    fromPid: from.pid ?? `${from.summonerId}@mock.pvp.net`,
    fromId: from.pid ?? `${from.summonerId}@mock.pvp.net`,
    fromObfuscatedPuuid: "",
    fromObfuscatedSummonerId: 0,
  };
  c.messages.push(msg);
  emit(`${CHAT}/${c.id}/messages/${msg.id}`, "Create", msg);
}

/** Key w: a teammate writes in the current chat (in a solo lobby, DuoPartner joins first). */
function teammateWrites(): void {
  if (state[URIS.phase] === "ChampSelect" && session) {
    postChat(champSelectChat, allySender(0), "I'll go top, can someone ward river at 3?");
    say("Teemo Enjoyer wrote in the champ select chat");
    return;
  }
  if (!lobbyChat) return say("no chat open (press l or c first)");
  if (!lobbyMembers.some((m) => m.summonerId === 2001)) {
    lobbyMembers.push({ summonerId: 2001, puuid: FRIENDS[0]!.puuid });
    publishLobby(((state[URIS.lobby] as any)?.gameConfig?.queueId as number) ?? 420, true);
    postChat(lobbyChat, friendSender(2001), "joined_room", "system");
  }
  postChat(lobbyChat, friendSender(2001), "ready? <b>not bold</b>");
  say("DuoPartner wrote in the lobby chat");
}

/** Someone answers what I wrote, a moment later. */
function replyTo(muc: string | null): void {
  if (!muc) return;
  if (muc === champSelectChat) later(1200, () => postChat(muc, allySender(1), "ok"));
  else {
    const friend = lobbyMembers.find((m) => m.summonerId !== 1002);
    if (friend) later(1200, () => postChat(muc, friendSender(friend.summonerId), "👍"));
  }
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
  sentInvites = [];
  closeChat(lobbyChat);
  closeChat(champSelectChat);
  lobbyChat = champSelectChat = null;
  for (const uri of Object.values(URIS)) set(uri, null);
  set(URIS.phase, "None");
}

// Lobby members carry no name (like LolLobbyLobbyParticipantDto on a live client); chat names come from the participants.
let lobbyMembers: { summonerId: number; puuid: string }[] = [];
function publishLobby(queueId: number, leader: boolean): void {
  const q = QUEUE_LIST.find((x) => x.id === queueId);
  const rolesDone = !q?.showPositionSelector || (myRoles[0] !== "UNSELECTED" && (myRoles[0] === "FILL" || myRoles[1] !== "UNSELECTED"));
  set(URIS.lobby, {
    // Quickplay needs champion slots, which this mock never sets: like a real client, it won't start then.
    canStartActivity: rolesDone && !q?.showQuickPlaySlotSelection,
    localMember: {
      isLeader: leader,
      allowedInviteOthers: leader,
      allowedChangeActivity: leader,
      puuid: "mock-puuid",
      summonerId: 1002,
      firstPositionPreference: q?.showPositionSelector ? myRoles[0] : "UNSELECTED",
      secondPositionPreference: q?.showPositionSelector ? myRoles[1] : "UNSELECTED",
    },
    gameConfig: { queueId, gameMode: q?.gameMode ?? "CLASSIC", showPositionSelector: !!q?.showPositionSelector, showQuickPlaySlotSelection: !!q?.showQuickPlaySlotSelection },
    members: structuredClone(lobbyMembers),
    multiUserChatId: lobbyChat,
    multiUserChatPassword: "secret-chat-pw",
  });
}

/** Enters a lobby. Coming back from the queue keeps the same lobby (and chat); `fresh` starts a new one. */
function toLobby(queueId = 420, leader = true, others: number[] = [], fresh = true): void {
  clearTimers();
  session = null;
  sentInvites = [];
  closeChat(champSelectChat);
  champSelectChat = null;
  if (fresh || !lobbyChat) {
    closeChat(lobbyChat);
    lobbyChat = openChat("lobby");
  }
  if (fresh || !lobbyMembers.length) {
    lobbyMembers = [{ summonerId: 1002, puuid: "mock-puuid" }, ...others.map((summonerId) => ({ summonerId, puuid: friendSender(summonerId).puuid }))];
  }
  set(URIS.session, null);
  set(URIS.readyCheck, null);
  set(URIS.search, null);
  publishLobby(queueId, leader);
  set(URIS.phase, "Lobby");
  say(`phase Lobby (queue ${queueId}${leader ? "" : ", not leader"})`);
}

/** Back to the same lobby (queue cancelled, ready check declined). */
function backToLobby(): void {
  toLobby(((state[URIS.lobby] as any)?.gameConfig?.queueId as number) ?? 420, true, [], false);
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
  closeChat(champSelectChat);
  champSelectChat = openChat("champSelect");
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
    championPickIntent: cell === 3 ? 51 : 0, // AdcMain plans Caitlyn: League refuses to let teammates ban her
    assignedPosition: positions[cell % 5],
    gameName: cell < 5 ? ["Teemo Enjoyer", "JungleDiff", "", "AdcMain", "WardBot"][cell] : "",
    tagLine: "EUW",
    puuid: cell === LOCAL_CELL ? "mock-puuid" : `puuid-${cell}`,
    summonerId: 1000 + cell,
    playerType: "PLAYER",
    team: cell < 5 ? 1 : 2,
    spell1Id: 4,
    spell2Id: 14,
    selectedSkinId: 0,
  });
  session = {
    actions,
    localPlayerCellId: LOCAL_CELL,
    myTeam: [0, 1, 2, 3, 4].map(member),
    theirTeam: [5, 6, 7, 8, 9].map(member),
    bans: { myTeamBans: [], theirTeamBans: [], numBans: 10 },
    timer: { phase: "PLANNING", adjustedTimeLeftInPhase: 10000, totalTimeInPhase: 10000, isInfinite: false, internalNowInEpochMs: Date.now() },
    chatDetails: { multiUserChatId: champSelectChat, multiUserChatPassword: "secret-chat-pw" },
    isSpectating: false,
    hasSimultaneousBans: true,
    hasSimultaneousPicks: false,
  };
  // One swap slot per teammate, like the real client (ids shared across the three lists).
  for (const field of Object.values(SWAP_FIELDS)) {
    session[field] = [0, 1, 3, 4].map((cell) => ({ cellId: cell, id: 100 + cell, state: field === "trades" ? "INVALID" : "AVAILABLE" }));
  }
  phaseEndsAt = Date.now() + 10000;
  set(URIS.phase, "ChampSelect");
  publishSession();
  say(`phase ChampSelect (you are cell ${LOCAL_CELL}); planning 10 s`);
  later(10000, () => startNextTurn());
}

// ---------- ARAM (bench + rerolls) and choose-one-of-two ----------

function randomFree(taken: Set<number>): number {
  const free = ALL_IDS.filter((x) => !taken.has(x));
  return free[Math.floor(Math.random() * free.length)] ?? ALL_IDS[0]!;
}

/** Every champion anyone holds or the bench has. */
function heldIds(): Set<number> {
  const s = new Set<number>([...session.myTeam, ...session.theirTeam].map((m: any) => m.championId).filter((x: number) => x > 0));
  for (const b of session.benchChampions ?? []) s.add(b.championId);
  return s;
}

/** Key a: ARAM. Everyone gets a random champion; a teammate rerolls after 4 s, filling the bench. */
function toAram(): void {
  toChampSelect();
  clearTimers();
  session.actions = [];
  session.queueId = 450;
  for (const field of Object.values(SWAP_FIELDS)) session[field] = [];
  const taken = new Set<number>();
  for (const m of [...session.myTeam, ...session.theirTeam]) {
    m.championId = randomFree(taken);
    m.championPickIntent = 0;
    m.assignedPosition = "";
    m.selectedSkinId = m.championId * 1000;
    taken.add(m.championId);
  }
  Object.assign(session, { benchEnabled: true, benchChampions: [], allowRerolling: true, rerollsRemaining: 2 });
  session.timer = { ...session.timer, phase: "FINALIZATION", adjustedTimeLeftInPhase: 60000, totalTimeInPhase: 60000 };
  phaseEndsAt = Date.now() + 60000;
  publishSession();
  say(`ARAM: you got champion ${memberByCell(LOCAL_CELL).championId}; game starts in 60 s`);
  later(4000, () => reroll(0));
  later(60000, toGame);
}

function reroll(cell: number): boolean {
  const m = memberByCell(cell);
  const next = randomFree(heldIds());
  session.benchChampions.push({ championId: m.championId, isPriority: false });
  m.championId = next;
  m.selectedSkinId = next * 1000;
  say(`cell ${cell} rerolled into ${next}`);
  publishSession();
  return true;
}

/** Key m: everyone is offered two champions and picks one at the same time. */
function toChooseOne(): void {
  toChampSelect();
  clearTimers();
  for (const a of allActions()) a.completed = true;
  let id = 500;
  const picks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((cell) => ({ id: id++, actorCellId: cell, championId: 0, completed: false, isAllyAction: cell < 5, isInProgress: true, pickTurn: 1, type: "pick" }));
  session.actions = [picks];
  session.queueId = 2400;
  session.allowSubsetChampionPicks = true;
  session.hasSimultaneousPicks = true;
  for (const m of [...session.myTeam, ...session.theirTeam]) m.championPickIntent = 0;
  const offer = [randomFree(new Set()), 0];
  offer[1] = randomFree(new Set([offer[0]!]));
  set(URIS.subset, offer);
  session.timer = { ...session.timer, phase: "BAN_PICK", adjustedTimeLeftInPhase: 30000, totalTimeInPhase: 30000 };
  phaseEndsAt = Date.now() + 30000;
  publishSession();
  say(`choose one of ${offer.join(" / ")}`);
  for (const a of picks.filter((x) => x.actorCellId !== LOCAL_CELL)) later(2000 + Math.random() * 6000, () => botAct(a));
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

// ---------- swaps ----------

const SWAP_FIELDS: Record<string, string> = { "position-swaps": "positionSwaps", "pick-order-swaps": "pickOrderSwaps", "champion-swaps": "trades" };

function swapSlot(field: string, cell: number): { cellId: number; id: number; state: string } | undefined {
  return (session?.[field] as { cellId: number; id: number; state: string }[] | undefined)?.find((s) => s.cellId === cell);
}

/** Champion trades only open once both players have locked a pick. */
function refreshTrades(): void {
  const lockedPick = (cell: number) => allActions().some((a) => a.actorCellId === cell && a.type === "pick" && a.completed);
  for (const slot of session?.trades ?? []) {
    if (slot.state === "SENT" || slot.state === "RECEIVED") continue;
    slot.state = lockedPick(LOCAL_CELL) && lockedPick(slot.cellId) ? "AVAILABLE" : "INVALID";
  }
}

/** Carries out an accepted swap between me and `cell`. */
function doSwap(field: string, cell: number): void {
  const me = memberByCell(LOCAL_CELL);
  const them = memberByCell(cell);
  if (field === "positionSwaps") [me.assignedPosition, them.assignedPosition] = [them.assignedPosition, me.assignedPosition];
  if (field === "pickOrderSwaps") {
    for (const a of allActions()) {
      if (a.type !== "pick" || a.completed) continue;
      if (a.actorCellId === LOCAL_CELL) a.actorCellId = cell;
      else if (a.actorCellId === cell) a.actorCellId = LOCAL_CELL;
    }
  }
  if (field === "trades") {
    [me.championId, them.championId] = [them.championId, me.championId];
    for (const a of allActions()) {
      if (a.type === "pick" && a.actorCellId === LOCAL_CELL) a.championId = me.championId;
      if (a.type === "pick" && a.actorCellId === cell) a.championId = them.championId;
    }
  }
}

/** A teammate asks me for a swap (keys s / o / t). */
function incomingSwap(field: string, cell: number): void {
  const slot = session && swapSlot(field, cell);
  if (!slot) return void say("no champ select / no such teammate");
  if (field === "trades") refreshTrades();
  if (slot.state !== "AVAILABLE") return void say(`${field} with cell ${cell} is ${slot.state}, can't request`);
  slot.state = "RECEIVED";
  say(`cell ${cell} requests a ${field} swap with you`);
  publishSession();
}

function publishSession(): void {
  if (!session) return;
  refreshTrades();
  const taken = takenIds();
  const banned = new Set(allActions().filter((a) => a.type === "ban" && a.completed).map((a) => a.championId));
  set(URIS.pickable, ALL_IDS.filter((x) => !taken.has(x)));
  set(URIS.bannable, ALL_IDS.filter((x) => !banned.has(x)));
  session.timer.internalNowInEpochMs = Date.now();
  session.timer.adjustedTimeLeftInPhase = Math.max(0, phaseEndsAt - Date.now());
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
    phaseEndsAt = Date.now() + 10000;
    publishSession();
    say("FINALIZATION (game starts in 10 s)");
    later(10000, toGame);
    return;
  }
  group.forEach((a) => (a.isInProgress = true));
  session.timer = { ...session.timer, phase: "BAN_PICK", adjustedTimeLeftInPhase: 30000, totalTimeInPhase: 30000 };
  phaseEndsAt = Date.now() + 30000;
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
  if (a.type === "pick") {
    const mem = memberByCell(a.actorCellId);
    mem.championId = a.championId;
    mem.selectedSkinId = a.championId * 1000;
  }
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
  closeChat(champSelectChat);
  closeChat(lobbyChat);
  champSelectChat = lobbyChat = null;
  set(URIS.session, null);
  set(URIS.pickable, null);
  set(URIS.bannable, null);
  set(URIS.subset, null);
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

/** Key f: stop answering HTTP (sockets stay open), like a frozen client. Press again to thaw. */
let frozen = false;
function toggleFreeze(): void {
  frozen = !frozen;
  say(frozen ? "FROZEN: not answering HTTP" : "thawed");
}

async function handle(req: any, res: any): Promise<void> {
  if (frozen) return; // never answer
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
  if (m === "GET" && p === "/lol-game-data/assets/v1/summoner-spells.json") {
    const list = SPELLS.map((sp) => ({ id: sp.id, name: sp.name, description: "", summonerLevel: 1, gameModes: ARAM_ONLY.has(sp.id) ? ["ARAM"] : ["CLASSIC", "ARAM"], iconPath: `/lol-game-data/assets/DATA/Spells/Icons2D/Summoner${sp.name}.png` }));
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list));
  }
  const spellIcon = /^\/lol-game-data\/assets\/DATA\/Spells\/Icons2D\/Summoner(\w+)\.png$/.exec(p);
  if (m === "GET" && spellIcon) {
    const sp = SPELLS.find((x) => x.name === spellIcon[1]);
    if (!sp) return lcuError(res, 404, "no icon");
    return void res.writeHead(200, { "Content-Type": "image/png" }).end(SPELL_ICONS.get(sp.id));
  }
  if (m === "GET" && p === "/lol-summoner/v1/current-summoner") {
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ summonerId: 1002, gameName: "You", puuid: "mock-puuid" }));
  }
  if (m === "GET" && p === "/lol-collections/v1/inventories/1002/spells") {
    // Owns everything except Clarity.
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ summonerId: 1002, spells: SPELLS.map((x) => x.id).filter((id) => id !== 13) }));
  }
  if (m === "GET" && p === "/lol-gameflow/v1/session") {
    if (!session) return lcuError(res, 404, "No session");
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ phase: state[URIS.phase], gameData: { queue: { id: 420, gameMode: "CLASSIC", mapId: 11 }, password: "" } }));
  }
  if (m === "GET" && p === "/lol-champ-select/v1/skin-carousel-skins") {
    const me = session && memberByCell(LOCAL_CELL);
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(me?.championId > 0 ? skinsFor(me.championId) : []));
  }
  const skinImg = /^\/lol-game-data\/assets\/v1\/(champion-tiles|champion-chroma-images)\/(\d+)\/(\d+)\.(jpg|png)$/.exec(p);
  if (m === "GET" && skinImg) {
    return void res.writeHead(200, { "Content-Type": "image/png" }).end(jpgLike(Number(skinImg[3])));
  }
  if (m === "PATCH" && p === "/lol-champ-select/v1/session/my-selection") {
    if (!session) return lcuError(res, 404, "No champ select");
    const me = memberByCell(LOCAL_CELL);
    if (body?.spell1Id !== undefined || body?.spell2Id !== undefined) {
      const ok = (id: unknown) => SPELLS.some((x) => x.id === id) && !ARAM_ONLY.has(id as number);
      if (!ok(body.spell1Id ?? me.spell1Id) || !ok(body.spell2Id ?? me.spell2Id)) return lcuError(res, 400, "INVALID_SPELL");
      me.spell1Id = body.spell1Id ?? me.spell1Id;
      me.spell2Id = body.spell2Id ?? me.spell2Id;
    }
    if (body?.selectedSkinId !== undefined) {
      const usable = me.championId > 0 && skinsFor(me.championId).flatMap((sk: any) => [sk, ...sk.childSkins]).some((sk: any) => sk.id === body.selectedSkinId && sk.unlocked);
      if (!usable) return lcuError(res, 400, "INVALID_SKIN");
      me.selectedSkinId = body.selectedSkinId;
    }
    publishSession();
    return void res.writeHead(204).end();
  }
  if (m === "GET" && p === "/lol-game-queues/v1/queues") {
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(QUEUE_LIST.map(({ roles: _r, slots: _s, ...q }) => q)));
  }
  const queueById = /^\/lol-game-queues\/v1\/queues\/(\d+)$/.exec(p);
  if (m === "GET" && queueById) {
    const q = QUEUE_LIST.find((x) => x.id === Number(queueById[1]));
    if (!q) return lcuError(res, 404, "No queue");
    const { roles: _r, slots: _s, ...out } = q;
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
  }
  if (m === "POST" && (p === "/lol-lobby/v2/eligibility/party" || p === "/lol-lobby/v2/eligibility/self")) {
    const size = p.endsWith("party") && state[URIS.phase] === "Lobby" ? lobbyMembers.length : 1;
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(eligibility(size)));
  }
  if (m === "POST" && p === "/lol-lobby/v2/lobby") {
    const phase = state[URIS.phase];
    const q = QUEUE_LIST.find((x) => x.id === body?.queueId);
    if (!q || q.isCustom || q.queueAvailability !== "Available") return lcuError(res, 400, "INVALID_QUEUE");
    if (phase !== "None" && phase !== "Lobby") return lcuError(res, 400, "INVALID_LOBBY_STATE");
    const lobby = state[URIS.lobby] as any;
    if (phase === "Lobby" && !lobby?.localMember?.isLeader) return lcuError(res, 400, "NOT_LEADER");
    if (phase === "Lobby" && !q.allowablePremadeSizes.includes(lobbyMembers.length)) return lcuError(res, 400, "INVALID_PARTY_SIZE");
    // Switching from a lobby keeps the party and its chat (assumed; not yet checked on a live client).
    toLobby(q.id, true, [], phase !== "Lobby");
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state[URIS.lobby]));
  }
  if (m === "PUT" && p === "/lol-lobby/v2/lobby/members/localMember/position-preferences") {
    const lobby = state[URIS.lobby] as any;
    if (state[URIS.phase] !== "Lobby" || !lobby) return lcuError(res, 404, "No lobby");
    const first = body?.firstPreference;
    const second = body?.secondPreference ?? "UNSELECTED";
    if (!ROLES.includes(first) || !ROLES.includes(second) || (first === second && first !== "UNSELECTED")) return lcuError(res, 400, "INVALID_POSITION_PREFERENCES");
    myRoles = [first, second];
    publishLobby(lobby.gameConfig.queueId, lobby.localMember.isLeader);
    say(`roles ${first} / ${second}`);
    return void res.writeHead(201).end();
  }

  // --- invitations & friends ---
  const json = (status: number, value: unknown) => void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  if (m === "GET" && p === INVITATIONS) return json(200, invitations);
  const inv = /^\/lol-lobby\/v2\/received-invitations\/([\w-]+)\/(accept|decline)$/.exec(p);
  if (m === "POST" && inv) {
    const found = invitations.find((x) => x.invitationId === inv[1] && x.state === "Pending");
    if (!found) return lcuError(res, 404, "No such invitation");
    invitations = invitations.filter((x) => x !== found);
    publishInvitations();
    if (inv[2] === "accept") later(500, () => toLobby(found.gameConfig.queueId, false, [found.fromSummonerId]));
    say(`invitation ${inv[2]}ed`);
    return void res.writeHead(204).end();
  }
  const summoner = /^\/lol-summoner\/v1\/summoners\/(\d+)$/.exec(p);
  if (m === "GET" && summoner) {
    const f = FRIENDS.find((x) => x.summonerId === Number(summoner[1]));
    return f ? json(200, { summonerId: f.summonerId, gameName: f.gameName, tagLine: "EUW", puuid: f.puuid }) : lcuError(res, 404, "No summoner");
  }
  if (m === "GET" && p === "/lol-chat/v1/friends") return json(200, FRIENDS);
  if (m === "GET" && p === "/lol-chat/v1/me") return json(200, { ...ME_IN_CHAT, availability: "chat" });
  if (m === "GET" && p === CHAT) return json(200, [...conversations.values()].map(({ id, type }) => ({ id, type, unreadMessageCount: 0 })));
  const chatPath = /^\/lol-chat\/v1\/conversations\/([^/]+)\/(messages|participants)$/.exec(p);
  if (chatPath) {
    const c = conversations.get(decodeURIComponent(chatPath[1]!));
    if (!c) return lcuError(res, 404, "No such conversation");
    if (chatPath[2] === "participants" && m === "GET") {
      const inLobby = c.id.startsWith(`${lobbyChat}@`) ? lobbyMembers.filter((x) => x.summonerId !== 1002).map((x) => FRIENDS.find((f) => f.summonerId === x.summonerId)!) : [];
      return json(200, [ME_IN_CHAT, ...inLobby.map((f) => ({ puuid: f.puuid, summonerId: f.summonerId, pid: f.pid, id: f.pid, gameName: f.gameName, name: f.gameName }))]);
    }
    if (chatPath[2] === "messages" && m === "GET") return json(200, c.messages);
    if (chatPath[2] === "messages" && m === "POST") {
      if (typeof body?.body !== "string" || !body.body || body.type !== "groupchat") return lcuError(res, 400, "INVALID_MESSAGE");
      const muc = c.id.split("@")[0]!;
      postChat(muc, ME_IN_CHAT, body.body);
      replyTo(muc);
      return json(200, c.messages[c.messages.length - 1]);
    }
  }
  if (m === "GET" && p === "/lol-lobby/v2/lobby/invitations") return state[URIS.phase] === "Lobby" ? json(200, sentInvites) : lcuError(res, 404, "No lobby");
  if (m === "POST" && p === "/lol-lobby/v2/lobby/invitations") {
    if (state[URIS.phase] !== "Lobby") return lcuError(res, 400, "NOT_IN_LOBBY");
    // Like LolLobbyLobbyInvitationDto: toSummonerId and/or toPuuid.
    const invitees = Array.isArray(body) ? body.map((x: any) => FRIENDS.find((f) => f.summonerId === x?.toSummonerId || f.puuid === x?.toPuuid)) : [];
    if (!invitees.length || invitees.some((f) => !f)) return lcuError(res, 400, "INVALID_INVITEE");
    for (const id of invitees.map((f) => f!.summonerId)) {
      sentInvites.push({ toSummonerId: id, state: "Pending" });
      const name = FRIENDS.find((f) => f.summonerId === id)!.gameName;
      say(`invited ${name}; they join in 3 s`);
      later(3000, () => {
        const sent = sentInvites.find((x) => x.toSummonerId === id && x.state === "Pending");
        if (!sent || state[URIS.phase] !== "Lobby") return;
        sent.state = "Accepted";
        lobbyMembers.push({ summonerId: id, puuid: friendSender(id).puuid });
        postChat(lobbyChat, friendSender(id), "joined_room", "system");
        publishLobby(((state[URIS.lobby] as any)?.gameConfig?.queueId as number) ?? 420, true);
        say(`${name} joined your lobby`);
      });
    }
    return json(200, sentInvites);
  }
  if (m === "POST" && p === "/lol-lobby/v2/lobby/matchmaking/search") {
    if (state[URIS.phase] !== "Lobby") return lcuError(res, 400, "Not in lobby");
    if (!(state[URIS.lobby] as any)?.canStartActivity) return lcuError(res, 400, "INVALID_LOBBY_STATE");
    toQueue();
    return void res.writeHead(204).end();
  }
  if (m === "DELETE" && p === "/lol-lobby/v2/lobby/matchmaking/search") {
    backToLobby();
    return void res.writeHead(204).end();
  }
  if (m === "POST" && (p === "/lol-matchmaking/v1/ready-check/accept" || p === "/lol-matchmaking/v1/ready-check/decline")) {
    const rc = state[URIS.readyCheck] as any;
    if (!rc) return lcuError(res, 400, "No ready check");
    const accepted = p.endsWith("accept");
    set(URIS.readyCheck, { ...rc, playerResponse: accepted ? "Accepted" : "Declined" });
    clearTimers();
    if (accepted) later(1500, toChampSelect);
    else later(500, backToLobby);
    return void res.writeHead(204).end();
  }
  const swap = /^\/lol-champ-select\/v1\/session\/(position-swaps|pick-order-swaps|champion-swaps)\/(\d+)\/(accept|decline|request|cancel)$/.exec(p);
  if (swap && m === "POST" && session) {
    const field = SWAP_FIELDS[swap[1]!]!;
    const slot = (session[field] as { cellId: number; id: number; state: string }[]).find((s) => s.id === Number(swap[2]));
    if (!slot) return lcuError(res, 404, "No such swap");
    const verb = swap[3];
    const need = verb === "request" ? "AVAILABLE" : verb === "cancel" ? "SENT" : "RECEIVED";
    if (slot.state !== need) return lcuError(res, 400, `SWAP_NOT_${need}`);
    if (verb === "accept") {
      doSwap(field, slot.cellId);
      slot.state = field === "trades" ? "INVALID" : "AVAILABLE";
    } else if (verb === "request") {
      slot.state = "SENT";
      // The teammate answers after 3 s: role swaps get accepted, everything else declined.
      setTimeout(() => {
        if (slot.state !== "SENT" || !session) return;
        if (field === "positionSwaps") doSwap(field, slot.cellId);
        slot.state = field === "trades" ? "INVALID" : "AVAILABLE";
        say(`cell ${slot.cellId} ${field === "positionSwaps" ? "accepted" : "declined"} your ${field} request`);
        publishSession();
      }, 3000);
    } else slot.state = "AVAILABLE";
    publishSession();
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(slot));
  }

  const bench = /^\/lol-champ-select\/v1\/session\/bench\/swap\/(\d+)$/.exec(p);
  if (bench && m === "POST" && session?.benchEnabled) {
    const i = (session.benchChampions as { championId: number }[]).findIndex((b) => b.championId === Number(bench[1]));
    if (i < 0) return lcuError(res, 400, "CHAMPION_NOT_ON_BENCH");
    const me = memberByCell(LOCAL_CELL);
    const [taken] = session.benchChampions.splice(i, 1, { championId: me.championId, isPriority: false });
    me.championId = taken.championId;
    me.selectedSkinId = taken.championId * 1000;
    publishSession();
    return void res.writeHead(204).end();
  }
  if (m === "POST" && p === "/lol-champ-select/v1/session/my-selection/reroll" && session?.allowRerolling) {
    if (!(session.rerollsRemaining > 0)) return lcuError(res, 400, "NO_REROLLS_REMAINING");
    session.rerollsRemaining--;
    reroll(LOCAL_CELL);
    return void res.writeHead(204).end();
  }

  const act = /^\/lol-champ-select\/v1\/session\/actions\/(\d+)(\/complete)?$/.exec(p);
  if (act && session) {
    const a = allActions().find((x) => x.id === Number(act[1]));
    if (!a) return lcuError(res, 404, "No such action");
    if (a.actorCellId !== LOCAL_CELL) return lcuError(res, 403, "Not your action");
    if (act[2]) {
      if (noComplete) return lcuError(res, 404, "Invalid URI format");
      if (lazyComplete) return void res.writeHead(204).end();
      if (m !== "POST") return lcuError(res, 405, "Method not allowed");
      if (!a.isInProgress || !(a.championId > 0)) return lcuError(res, 400, "Action not completable");
      complete(a);
      return void res.writeHead(204).end();
    }
    if (m === "PATCH") {
      if (body?.championId !== undefined) {
        if (!ALL_IDS.includes(body.championId) || takenIds().has(body.championId)) return lcuError(res, 400, "Invalid champion");
        const offer = state[URIS.subset] as number[] | undefined;
        if (session.allowSubsetChampionPicks && offer && !offer.includes(body.championId)) return lcuError(res, 400, "CHAMPION_NOT_OFFERED");
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

void selfsigned.generate([{ name: "commonName", value: "127.0.0.1" }], { keyType: "ec", notAfterDate: new Date(Date.now() + 86_400_000) }).then((pems) => {
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
    publishInvitations();
    toLobby();
    console.log(`\nMock LCU on https://127.0.0.1:${port}${noComplete ? "  (POST /complete disabled)" : ""}`);
    console.log(`Run the connector with:  npm run dev -- --league-dir "${dir}"`);
    console.log("Keys: l=lobby q=queue r=ready check c=champ select a=ARAM m=choose one of two n=finish current turn g=in game 0=none x=quit");
    console.log("      s/o/t = a teammate asks you to swap roles / pick order / champions   i = a friend invites you   w = a teammate writes in chat\n");
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
    else if (k === "i") incomingInvite();
    else if (k === "w") teammateWrites();
    else if (k === "q") toQueue();
    else if (k === "r") toReadyCheck();
    else if (k === "c") toChampSelect();
    else if (k === "a") toAram();
    else if (k === "m") toChooseOne();
    else if (k === "n") finishCurrentTurn();
    else if (k === "g") toGame();
    else if (k === "f") toggleFreeze();
    else if (k === "s") incomingSwap("positionSwaps", 1);
    else if (k === "o") incomingSwap("pickOrderSwaps", 4);
    else if (k === "t") incomingSwap("trades", 0);
    else if (k === "0") toNone();
  });
} else {
  // Non-interactive: accept commands line by line on stdin (used by automated smoke tests).
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const k = line.trim();
    const swaps: Record<string, () => void> = {
      f: toggleFreeze,
      s: () => incomingSwap("positionSwaps", 1),
      o: () => incomingSwap("pickOrderSwaps", 4),
      t: () => incomingSwap("trades", 0),
      i: incomingInvite,
      w: teammateWrites,
      a: toAram,
      m: toChooseOne,
    };
    ({ l: () => toLobby(), q: toQueue, r: toReadyCheck, c: toChampSelect, n: finishCurrentTurn, g: toGame, "0": toNone, x: cleanup, ...swaps } as Record<string, () => void>)[k]?.();
  });
}
