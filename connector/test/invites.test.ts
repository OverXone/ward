import { afterEach, describe, expect, it, vi } from "vitest";
import { runAction, type ActionContext, type ActionName } from "../src/actions";
import { deriveFriends, type RawFriend } from "../src/friends";
import { Handles } from "../src/handles";
import type { LcuHttp } from "../src/lcu/http";
import { deriveInvitations, Store, URI } from "../src/state/store";
import { expectError, fakeLcu, ok } from "./fake-lcu";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("handles", () => {
  it("gives the same opaque handle for the same object and maps it back only for its kind", () => {
    const h = new Handles();
    const a = h.handle("friend", 101);
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(h.handle("friend", 101)).toBe(a);
    expect(h.handle("friend", 102)).not.toBe(a);
    expect(h.handle("friend", "101")).not.toBe(a);
    expect(h.resolve("friend", a)).toBe(101);
    expect(h.resolve("invite", a)).toBeNull();
    for (const bad of [101, "101", "", "x".repeat(12), null, { a }]) expect(h.resolve("friend", bad)).toBeNull();
    h.clear();
    expect(h.resolve("friend", a)).toBeNull();
  });
});

describe("invitations view", () => {
  const raw = [
    { invitationId: "a1", state: "Pending", fromSummonerId: 7, fromSummonerName: "", gameConfig: { queueId: 440 }, canAcceptInvitation: true },
    { invitationId: "a2", state: "Declined", fromSummonerId: 8 },
    { invitationId: "a3", state: "Pending", fromSummonerId: 9, fromSummonerName: "OldName", canAcceptInvitation: false },
    { invitationId: "a4", state: "Pending" },
  ];
  it("shows pending ones with the inviter's name, queue and whether I can join", () => {
    const h = new Handles();
    const list = deriveInvitations(raw, new Map([[7, "DuoPartner"]]), new Map([[440, "Ranked Flex"]]), h);
    expect(list.map(({ from, queueName, canAccept }) => ({ from, queueName, canAccept }))).toEqual([
      { from: "DuoPartner", queueName: "Ranked Flex", canAccept: true },
      { from: "OldName", queueName: null, canAccept: false },
      { from: "A friend", queueName: null, canAccept: true },
    ]);
    expect(h.resolve("invite", list[0]!.handle)).toBe("a1");
    expect(JSON.stringify(list)).not.toMatch(/a1|fromSummonerId|"7"/);
  });
});

const FRIENDS: RawFriend[] = [
  { summonerId: 2002, gameName: "MidOrFeed", availability: "away", product: "league_of_legends", lol: { gameStatus: "outOfGame" } },
  { summonerId: 2001, gameName: "DuoPartner", availability: "chat", product: "league_of_legends", lol: { gameStatus: "outOfGame" } },
  { summonerId: 2003, gameName: "Grinder", availability: "dnd", product: "league_of_legends", lol: { gameStatus: "inGame" } },
  { summonerId: 2004, gameName: "Valo", availability: "chat", product: "valorant" },
  { summonerId: 2005, gameName: "Sleepy", availability: "offline", product: "league_of_legends" },
  { summonerId: 2006, gameName: "Bus", availability: "mobile", product: "league_of_legends" },
  { summonerId: 2007, gameName: "AlreadyHere", availability: "chat", product: "league_of_legends", lol: { gameStatus: "hosting_NORMAL" } },
  { summonerId: 2008, gameName: "Asked", availability: "chat", product: "league_of_legends" },
];

describe("friends to invite", () => {
  it("lists online League friends, free ones first, and marks who's already here or invited", () => {
    const h = new Handles();
    const list = deriveFriends(FRIENDS, { members: [{ summonerId: 1002 }, { summonerId: 2007 }] }, [{ toSummonerId: 2008, state: "Pending" }], h);
    expect(list.map((f) => [f.name, f.status, f.canInvite])).toEqual([
      ["DuoPartner", "Online", true],
      ["MidOrFeed", "Away", true],
      ["Grinder", "In game", true],
      ["AlreadyHere", "In your lobby", false],
      ["Asked", "Invited", false],
    ]);
    expect(h.resolve("friend", list[0]!.handle)).toBe(2001);
    expect(JSON.stringify(list)).not.toMatch(/2001|summonerId|puuid/);
  });
});

// ---------- actions ----------

const ctxFor = (http: LcuHttp, handles: Handles, extra: Partial<ActionContext> = {}): ActionContext => ({ http, handles, ...extra });
const act = (name: ActionName, body: unknown, ctx: ActionContext) => runAction(name, body, ctx);

describe("invitations", () => {
  const RAW = [{ invitationId: "inv-1", state: "Pending", canAcceptInvitation: true, fromSummonerId: 7 }];
  const setup = (phase = "None", list: unknown = RAW) => {
    const handles = new Handles();
    const lcu = fakeLcu({
      "GET /lol-gameflow/v1/gameflow-phase": ok(phase),
      "GET /lol-lobby/v2/received-invitations": ok(list),
      "POST /lol-lobby/v2/received-invitations/inv-1/accept": ok(),
      "POST /lol-lobby/v2/received-invitations/inv-1/decline": ok(),
    });
    const handle = deriveInvitations(RAW, new Map(), new Map(), handles)[0]!.handle;
    return { lcu, ctx: ctxFor(lcu.http, handles), handle };
  };

  it("accepts and declines the invitation the handle stands for", async () => {
    const s = setup();
    await act("invitations/accept", { invitation: s.handle }, s.ctx);
    await act("invitations/decline", { invitation: s.handle }, s.ctx);
    expect(s.lcu.writes().map((w) => w.path)).toEqual([
      "/lol-lobby/v2/received-invitations/inv-1/accept",
      "/lol-lobby/v2/received-invitations/inv-1/decline",
    ]);
  });

  it("refuses invitations that aren't pending anymore", async () => {
    const s = setup("None", [{ ...RAW[0], state: "Accepted" }]);
    await expectError(act("invitations/accept", { invitation: s.handle }, s.ctx), 409, /isn't open/);
    const gone = setup("None", []);
    await expectError(act("invitations/decline", { invitation: gone.handle }, gone.ctx), 409, /isn't open/);
  });

  it("won't accept during champ select or a game, but can still decline", async () => {
    for (const phase of ["ChampSelect", "InProgress"]) {
      const s = setup(phase);
      await expectError(act("invitations/accept", { invitation: s.handle }, s.ctx), 409, /Finish/);
      await act("invitations/decline", { invitation: s.handle }, s.ctx);
      expect(s.lcu.writes().map((w) => w.path)).toEqual(["/lol-lobby/v2/received-invitations/inv-1/decline"]);
    }
  });
});

describe("lobby/invite", () => {
  const setup = (phase = "Lobby", localMember: object = { isLeader: true, allowedInviteOthers: true }) => {
    const handles = new Handles();
    const lcu = fakeLcu({
      "GET /lol-gameflow/v1/gameflow-phase": ok(phase),
      "GET /lol-lobby/v2/lobby": ok({ localMember, members: [{ summonerId: 1002 }, { summonerId: 2007 }] }),
      "GET /lol-lobby/v2/lobby/invitations": ok([]),
      "GET /lol-chat/v1/friends": ok(FRIENDS),
      "POST /lol-lobby/v2/lobby/invitations": ok([]),
    });
    const handleOf = (id: number) => handles.handle("friend", id);
    return { lcu, ctx: ctxFor(lcu.http, handles), handleOf };
  };

  it("invites an online friend by their summoner id", async () => {
    const s = setup();
    await act("lobby/invite", { friend: s.handleOf(2001) }, s.ctx);
    expect(s.lcu.writes()).toEqual([{ method: "POST", path: "/lol-lobby/v2/lobby/invitations", body: [{ toSummonerId: 2001 }] }]);
  });

  it("keys friends by puuid and sends it, also for friends without a summoner id", async () => {
    const puuid = "p".repeat(36);
    const s = setup();
    FRIENDS.push({ puuid, gameName: "NoSummonerId", availability: "chat", product: "league_of_legends" });
    try {
      const h = new Handles();
      const listed = deriveFriends(FRIENDS, null, null, h).find((f) => f.name === "NoSummonerId")!;
      expect(h.resolve("friend", listed.handle)).toBe(puuid);
      expect(JSON.stringify(listed)).not.toContain(puuid);
      await act("lobby/invite", { friend: s.ctx.handles!.handle("friend", puuid) }, s.ctx);
      expect(s.lcu.writes()[0]!.body).toEqual([{ toPuuid: puuid }]);
    } finally {
      FRIENDS.pop();
    }
  });

  it("refuses offline friends, people already in the lobby and unknown handles", async () => {
    const s = setup();
    await expectError(act("lobby/invite", { friend: s.handleOf(2005) }, s.ctx), 409, /offline/);
    await expectError(act("lobby/invite", { friend: s.handleOf(2007) }, s.ctx), 409, /in your lobby/);
    await expectError(act("lobby/invite", { friend: "AAAAAAAAAAAA" }, s.ctx), 409);
    await expectError(act("lobby/invite", { friend: 2001 }, s.ctx), 400);
    expect(s.lcu.writes()).toHaveLength(0);
  });

  it("needs a lobby where I'm allowed to invite", async () => {
    const noLobby = setup("None");
    await expectError(act("lobby/invite", { friend: noLobby.handleOf(2001) }, noLobby.ctx), 409, /lobby first/);
    const notLeader = setup("Lobby", { isLeader: false, allowedInviteOthers: false });
    await expectError(act("lobby/invite", { friend: notLeader.handleOf(2001) }, notLeader.ctx), 409, /leader/);
    const oldClient = setup("Lobby", { isLeader: true });
    await act("lobby/invite", { friend: oldClient.handleOf(2001) }, oldClient.ctx);
    expect(oldClient.lcu.writes()).toHaveLength(1);
  });
});

describe("store: invitations", () => {
  afterEach(() => vi.useRealTimers());

  it("re-reads invitations every 5 s in case League sends no event for them", async () => {
    vi.useFakeTimers();
    const answers: Record<string, unknown> = { [URI.phase]: "None", [URI.invitations]: [] };
    const http = { getOrNull: async (p: string) => answers[p] ?? null } as unknown as LcuHttp;
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(http);
    await vi.advanceTimersByTimeAsync(10);
    expect(store.state.invitations).toEqual([]);
    answers[URI.invitations] = [{ invitationId: "x", state: "Pending" }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.state.invitations).toHaveLength(1);
    store.detach();
  });

  it("pushes invitations and looks up who invited me", async () => {
    const answers: Record<string, unknown> = {
      [URI.phase]: "Lobby",
      "/lol-summoner/v1/summoners/7": { gameName: "DuoPartner" },
      "/lol-game-queues/v1/queues/440": { description: "Ranked Flex" },
    };
    const http = { getOrNull: async (p: string) => answers[p] ?? null } as unknown as LcuHttp;
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(http);
    for (let i = 0; i < 4; i++) await tick();
    expect(store.state.invitations).toEqual([]);

    store.handleEvent({ uri: URI.invitations, eventType: "Update", data: [{ invitationId: "x", state: "Pending", fromSummonerId: 7, gameConfig: { queueId: 440 } }] });
    expect(store.state.invitations[0]?.from).toBe("A friend");
    for (let i = 0; i < 4; i++) await tick();
    expect(store.state.invitations[0]).toMatchObject({ from: "DuoPartner", queueName: "Ranked Flex", canAccept: true });

    store.handleEvent({ uri: URI.invitations, eventType: "Delete", data: null });
    expect(store.state.invitations).toEqual([]);
  });
});
