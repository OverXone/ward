import { describe, expect, it } from "vitest";
import { runAction } from "../src/actions";
import { chatRoomFor, cleanText, deriveMessages, findConversation, type ChatRoom, type RawChatMessage } from "../src/chat";
import type { LcuHttp } from "../src/lcu/http";
import { Store, URI } from "../src/state/store";
import { expectError, fakeLcu, ok, type Route } from "./fake-lcu";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const LOBBY_CONV = "abc-123@sec.eu1.pvp.net";
const CS_CONV = "champ-select-9@champ-select.eu1.pvp.net";
const CONVERSATIONS = [
  { id: "1234@eu1.pvp.net", type: "chat" },
  { id: LOBBY_CONV, type: "customGame" },
  { id: CS_CONV, type: "championSelect" },
];

describe("finding the room's conversation", () => {
  it("matches the room's chat id to the conversation id, ignoring the domain", () => {
    expect(findConversation(CONVERSATIONS, { kind: "lobby", mucId: "abc-123" })).toEqual({ id: LOBBY_CONV, by: "id" });
    expect(findConversation(CONVERSATIONS, { kind: "lobby", mucId: "ABC-123@sec.eu1.pvp.net" })).toEqual({ id: LOBBY_CONV, by: "id" });
  });

  it("falls back to the only conversation of the room's type", () => {
    expect(findConversation(CONVERSATIONS, { kind: "champSelect", mucId: "something-else" })).toEqual({ id: CS_CONV, by: "type" });
    expect(findConversation(CONVERSATIONS, { kind: "champSelect", mucId: null })).toEqual({ id: CS_CONV, by: "type" });
    const two = [...CONVERSATIONS, { id: "other@champ-select.eu1.pvp.net", type: "championSelect" }];
    expect(findConversation(two, { kind: "champSelect", mucId: null })).toBeNull();
  });

  it("never picks a private conversation or an id with unexpected characters", () => {
    expect(findConversation([{ id: "1234@eu1.pvp.net", type: "chat" }], { kind: "lobby", mucId: null })).toBeNull();
    expect(findConversation([{ id: "x/../y", type: "customGame" }, { id: 5, type: "customGame" }], { kind: "lobby", mucId: null })).toBeNull();
    expect(findConversation(null, { kind: "lobby", mucId: "abc-123" })).toBeNull();
  });

  it("knows which room goes with each phase", () => {
    const lobby = { multiUserChatId: "abc-123" };
    const session = { chatDetails: { multiUserChatId: "cs-1" } };
    expect(chatRoomFor("Lobby", lobby, null)).toEqual({ kind: "lobby", mucId: "abc-123" });
    expect(chatRoomFor("Matchmaking", lobby, null)?.kind).toBe("lobby");
    expect(chatRoomFor("ChampSelect", lobby, session)).toEqual({ kind: "champSelect", mucId: "cs-1" });
    expect(chatRoomFor("InProgress", lobby, session)).toBeNull();
    expect(chatRoomFor("Lobby", null, null)).toBeNull();
  });
});

describe("chat messages for the phone", () => {
  const seqs = new Map<string, number>();
  const seq = (k: string) => seqs.get(k) ?? (seqs.set(k, seqs.size + 1), seqs.size);
  const msg = (m: RawChatMessage): RawChatMessage => ({ type: "groupchat", timestamp: "2026-11-14T18:00:00.000Z", ...m });

  const champRoom: ChatRoom = {
    kind: "champSelect",
    mucId: "cs-1",
    members: [
      { ids: ["puuid-me", 1002], name: "You", championId: 103, isMe: true },
      { ids: ["", 0, "obf-ally", 777], name: "Ally 2", championId: 64, isMe: false },
      { ids: ["puuid-jg", 1001], name: "JungleDiff", championId: 0, isMe: false },
    ],
  };

  it("names senders from the session (hidden names via obfuscated ids) and shows their champion", () => {
    const out = deriveMessages(
      [
        msg({ id: "1", body: "hi", fromPuuid: "puuid-jg", fromSummonerId: 1001 }),
        msg({ id: "2", body: "mid pls", fromPuuid: "", fromSummonerId: 0, fromObfuscatedPuuid: "obf-ally" }),
        msg({ id: "3", body: "ok", fromPuuid: "puuid-me" }),
        msg({ id: "4", body: "who?", fromPuuid: "stranger" }),
      ],
      champRoom,
      new Set(),
      new Map([["stranger", "RealName"]]),
      seq,
    );
    expect(out.map(({ from, isMe, championId, text }) => ({ from, isMe, championId, text }))).toEqual([
      { from: "JungleDiff", isMe: false, championId: 0, text: "hi" },
      { from: "Ally 2", isMe: false, championId: 64, text: "mid pls" },
      { from: "You", isMe: true, championId: 103, text: "ok" },
      // Names from elsewhere are never used in champ select, where League hides some on purpose.
      { from: "Teammate", isMe: false, championId: 0, text: "who?" },
    ]);
    expect(out[0]!.time).toBe(Date.parse("2026-11-14T18:00:00.000Z"));
    expect(out.map((m) => m.id)).toEqual([seq("1"), seq("2"), seq("3"), seq("4")]);
    expect(JSON.stringify(out)).not.toMatch(/puuid|obf-ally|1001/);
  });

  it("shows joins and leaves in the lobby, skips other system messages, and recognises me by my chat ids", () => {
    const lobby: ChatRoom = { kind: "lobby", mucId: "abc", members: [{ ids: ["p-duo"], name: "", championId: 0, isMe: false }] };
    const out = deriveMessages(
      [
        msg({ id: "a", type: "system", body: "joined_room", fromPuuid: "p-duo" }),
        msg({ id: "b", type: "system", body: "something_else", fromPuuid: "p-duo" }),
        msg({ id: "c", body: "gl", fromPuuid: "p-duo" }),
        msg({ id: "d", body: "ty", fromPid: "me@pvp.net" }),
        msg({ id: "e", type: "celebration", body: "x" }),
        msg({ id: "f", body: "   " }),
        msg({ id: "g", type: "system", body: "left_room", fromPuuid: "p-duo" }),
      ],
      lobby,
      new Set(["me@pvp.net"]),
      new Map([["p-duo", "DuoPartner"]]),
      seq,
    );
    expect(out.map(({ kind, from, text }) => `${kind}:${from}:${text}`)).toEqual([
      "joined:DuoPartner:",
      "message:DuoPartner:gl",
      "message:You:ty",
      "left:DuoPartner:",
    ]);
    // In champ select everyone "joins" at the start: that's noise, so it's dropped there.
    expect(deriveMessages([msg({ type: "system", body: "joined_room" })], champRoom, new Set(), new Map(), seq)).toEqual([]);
  });

  it("keeps text plain and short, and only the last 60 messages", () => {
    const out = deriveMessages([msg({ id: "x", body: `a\nb\u0000c${String.fromCharCode(0x2028)}d ` + "z".repeat(600) })], champRoom, new Set(), new Map(), seq);
    expect(out[0]!.text.startsWith("a b c d z")).toBe(true);
    expect([...out[0]!.text].length).toBe(500);
    const many = Array.from({ length: 80 }, (_, i) => msg({ id: `n${i}`, body: `m${i}` }));
    const last = deriveMessages(many, champRoom, new Set(), new Map(), seq);
    expect(last.length).toBe(60);
    expect(last.at(-1)!.text).toBe("m79");
    expect(cleanText(42, 10)).toBe("");
    expect(cleanText("😀".repeat(5), 3)).toBe("😀😀😀");
  });
});

describe("sending a chat message", () => {
  const lobbyRoutes = {
    "GET /lol-gameflow/v1/gameflow-phase": ok("Lobby"),
    "GET /lol-lobby/v2/lobby": ok({ multiUserChatId: "abc-123" }),
    "GET /lol-chat/v1/conversations": ok(CONVERSATIONS),
  };

  it("posts to the lobby's conversation, looked up fresh from the client", async () => {
    const posted: unknown[] = [];
    const { http, writes } = fakeLcu({
      ...lobbyRoutes,
      [`POST /lol-chat/v1/conversations/${encodeURIComponent(LOBBY_CONV)}/messages`]: (b) => (posted.push(b), { status: 200, json: {} }),
    });
    await runAction("chat/send", { text: "  hola\nequipo  " }, { http });
    expect(posted).toEqual([{ body: "hola equipo", type: "groupchat" }]);
    expect(writes().length).toBe(1);
  });

  it("posts to champ select's conversation during champ select", async () => {
    const { http, writes } = fakeLcu({
      "GET /lol-gameflow/v1/gameflow-phase": ok("ChampSelect"),
      [`GET ${URI.session}`]: ok({ chatDetails: { multiUserChatId: "champ-select-9" }, myTeam: [], actions: [] }),
      "GET /lol-chat/v1/conversations": ok(CONVERSATIONS),
      [`POST /lol-chat/v1/conversations/${encodeURIComponent(CS_CONV)}/messages`]: ok({}),
    });
    await runAction("chat/send", { text: "mid" }, { http });
    expect(writes()[0]!.path).toContain("champ-select-9");
  });

  it("refuses bad input before touching the client", async () => {
    const { http, calls } = fakeLcu(lobbyRoutes);
    await expectError(runAction("chat/send", { text: "" }, { http }), 400, /Write something/);
    await expectError(runAction("chat/send", { text: " \n " }, { http }), 400);
    await expectError(runAction("chat/send", { text: "x".repeat(201) }, { http }), 400, /200 characters/);
    await expectError(runAction("chat/send", { text: 5 }, { http }), 400);
    await expectError(runAction("chat/send", { text: "hi", conversation: LOBBY_CONV }, { http }), 400, /unexpected field/);
    expect(calls.length).toBe(0);
  });

  it("refuses when there's no room to write to", async () => {
    const cases: Record<string, Route>[] = [
      { "GET /lol-gameflow/v1/gameflow-phase": ok("InProgress") },
      { ...lobbyRoutes, "GET /lol-chat/v1/conversations": ok([{ id: "1234@eu1.pvp.net", type: "chat" }]) },
      { "GET /lol-gameflow/v1/gameflow-phase": ok("ChampSelect"), [`GET ${URI.session}`]: ok({ isSpectating: true, chatDetails: { multiUserChatId: "champ-select-9" } }), "GET /lol-chat/v1/conversations": ok(CONVERSATIONS) },
    ];
    for (const routes of cases) {
      const { http, writes } = fakeLcu(routes);
      await expectError(runAction("chat/send", { text: "hi" }, { http }), 409, /no chat/);
      expect(writes().length).toBe(0);
    }
  });
});

describe("store chat", () => {
  function fakeHttp(answers: Record<string, unknown>) {
    const gets: string[] = [];
    const http = {
      async getOrNull(path: string) {
        gets.push(path);
        return path in answers ? structuredClone(answers[path]) : null;
      },
    } as unknown as LcuHttp;
    return { http, gets, answers };
  }
  const messagesPath = `/lol-chat/v1/conversations/${encodeURIComponent(LOBBY_CONV)}/messages`;

  it("follows the lobby's chat and re-reads it when League says something changed", async () => {
    const lcu = fakeHttp({
      [URI.phase]: "Lobby",
      [URI.lobby]: { multiUserChatId: "abc-123", localMember: { puuid: "p-me" }, members: [{ puuid: "p-me" }, { puuid: "p-duo", summonerName: "DuoPartner" }] },
      "/lol-chat/v1/conversations": CONVERSATIONS,
      "/lol-chat/v1/me": { puuid: "p-me" },
      [messagesPath]: [{ id: "1", type: "groupchat", body: "hey", fromPuuid: "p-duo" }],
    });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick(120);
    const chat = store.state.chat!;
    expect(chat).toMatchObject({ kind: "lobby", ready: true });
    expect(chat.messages.map((m) => `${m.from}:${m.text}`)).toEqual(["DuoPartner:hey"]);

    (lcu.answers[messagesPath] as unknown[]).push({ id: "2", type: "groupchat", body: "hi", fromPuuid: "p-me" });
    store.handleEvent({ uri: `/lol-chat/v1/conversations/${LOBBY_CONV}/messages/2`, eventType: "Create", data: {} });
    await tick(120);
    expect(store.state.chat!.messages.map((m) => `${m.from}:${m.text}`)).toEqual(["DuoPartner:hey", "You:hi"]);
    expect(store.state.chat!.room).toBe(chat.room);

    // Leaving for the game: no chat, and a new lobby is a new room.
    store.handleEvent({ uri: URI.phase, eventType: "Update", data: "InProgress" });
    expect(store.state.chat).toBeNull();
    store.handleEvent({ uri: URI.phase, eventType: "Update", data: "Lobby" });
    await tick(120);
    expect(store.state.chat!.room).not.toBe(chat.room);
    store.detach();
  });

  it("says the chat isn't ready while League hasn't joined the room", async () => {
    const lcu = fakeHttp({ [URI.phase]: "Lobby", [URI.lobby]: { multiUserChatId: "abc-123" }, "/lol-chat/v1/conversations": [] });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick(120);
    expect(store.state.chat).toMatchObject({ kind: "lobby", ready: false, messages: [] });
    store.detach();
    expect(store.state.chat).toBeNull();
  });
});
