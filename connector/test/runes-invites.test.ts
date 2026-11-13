import { describe, expect, it } from "vitest";
import { runAction, type ActionContext, type ActionName } from "../src/actions";
import { deriveFriends, type RawFriend } from "../src/friends";
import { Handles } from "../src/handles";
import type { LcuHttp } from "../src/lcu/http";
import type { RuneRecommendation } from "../src/loadout";
import { deriveInvitations, deriveRunes, Store, URI } from "../src/state/store";
import { expectError, fakeLcu, ok, type Route } from "./fake-lcu";
import { draftSession } from "./fixtures/sessions";

const tick = () => new Promise((r) => setTimeout(r, 0));

const PAGES = [
  { id: 1, name: "Precision", isEditable: false, current: false, primaryStyleId: 8000, subStyleId: 8400 },
  { id: 101, name: "Mid mage", isEditable: true, current: false, primaryStyleId: 8200, subStyleId: 8300 },
  { id: 102, name: "Jungle", isEditable: true, current: true, primaryStyleId: 8100, subStyleId: 8000 },
  { id: 900, name: "Temp", isEditable: true, isTemporary: true },
];

describe("handles", () => {
  it("gives the same opaque handle for the same object and maps it back only for its kind", () => {
    const h = new Handles();
    const a = h.handle("page", 101);
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(h.handle("page", 101)).toBe(a);
    expect(h.handle("page", 102)).not.toBe(a);
    expect(h.handle("invite", "101")).not.toBe(a);
    expect(h.resolve("page", a)).toBe(101);
    expect(h.resolve("friend", a)).toBeNull();
    for (const bad of [101, "101", "", "x".repeat(12), null, { a }]) expect(h.resolve("page", bad)).toBeNull();
    h.clear();
    expect(h.resolve("page", a)).toBeNull();
  });
});

describe("rune pages view", () => {
  it("lists custom pages first, skips temporary ones and never shows page ids", () => {
    const h = new Handles();
    const view = deriveRunes(PAGES, null, h)!;
    expect(view.pages.map((p) => p.name)).toEqual(["Mid mage", "Jungle", "Precision"]);
    expect(view.pages.map((p) => p.isCurrent)).toEqual([false, true, false]);
    expect(view.pages[2]!.isEditable).toBe(false);
    expect(h.resolve("page", view.pages[0]!.handle)).toBe(101);
    expect(JSON.stringify(view)).not.toMatch(/"id"|101|102/);
  });

  it("trusts /currentpage over the page flags", () => {
    const view = deriveRunes(PAGES, { id: 101 }, new Handles())!;
    expect(view.pages.find((p) => p.isCurrent)?.name).toBe("Mid mage");
  });

  it("is null when the client gave no list", () => {
    expect(deriveRunes(null, null, new Handles())).toBeNull();
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

describe("runes/select", () => {
  const setup = (phase = "ChampSelect", pages: unknown = PAGES) => {
    const handles = new Handles();
    const lcu = fakeLcu({ "GET /lol-gameflow/v1/gameflow-phase": ok(phase), "GET /lol-perks/v1/pages": ok(pages), "PUT /lol-perks/v1/currentpage": ok() });
    const view = deriveRunes(PAGES, null, handles)!;
    const handleOf = (name: string) => view.pages.find((p) => p.name === name)!.handle;
    return { lcu, ctx: ctxFor(lcu.http, handles), handleOf };
  };

  it("makes the page current, sending League its own page id", async () => {
    const s = setup();
    await act("runes/select", { page: s.handleOf("Mid mage") }, s.ctx);
    expect(s.lcu.writes()).toEqual([{ method: "PUT", path: "/lol-perks/v1/currentpage", body: 101 }]);
  });

  it("refuses malformed or unknown handles and raw ids", async () => {
    const s = setup();
    await expectError(act("runes/select", { page: 101 }, s.ctx), 400, /handle/);
    await expectError(act("runes/select", { page: "../../x" }, s.ctx), 400);
    await expectError(act("runes/select", { page: "AAAAAAAAAAAA" }, s.ctx), 409, /isn't there/);
    await expectError(act("runes/select", { page: s.handleOf("Jungle"), id: 5 }, s.ctx), 400, /unexpected/);
    expect(s.lcu.writes()).toHaveLength(0);
  });

  it("re-checks the page against the client's current list, and not during a game", async () => {
    const gone = setup("Lobby", PAGES.filter((p) => p.id !== 101));
    await expectError(act("runes/select", { page: gone.handleOf("Mid mage") }, gone.ctx), 409, /isn't there/);
    const inGame = setup("InProgress");
    await expectError(act("runes/select", { page: inGame.handleOf("Mid mage") }, inGame.ctx), 409, /during a game/);
    expect([...gone.lcu.writes(), ...inGame.lcu.writes()]).toHaveLength(0);
  });
});

describe("runes/recommended", () => {
  const REC: RuneRecommendation = { primaryStyleId: 8200, subStyleId: 8300, perkIds: [8214, 8226, 8210, 8237, 8304, 8345, 5008, 5002, 5001], keystoneId: 8214, keystoneName: "Summon Aery" };
  const champs = async () => [{ id: 103, name: "Ahri" }];
  const setup = (pages: unknown[], extra: Record<string, Route> = {}, championId = 103) => {
    const lcu = fakeLcu({
      "GET /lol-champ-select/v1/session": ok(draftSession()),
      "GET /lol-perks/v1/pages": ok(pages),
      "GET /lol-perks/v1/inventory": ok({ ownedPageCount: 3 }),
      "POST /lol-perks/v1/pages": () => ({ status: 200, json: { id: 555 } }),
      "PUT /lol-perks/v1/currentpage": ok(),
      ...extra,
    });
    const loadout = { availableSpells: async () => null, selectableSkinIds: async () => null, recommendations: async () => ({ championId, list: [REC] }) };
    return { lcu, ctx: ctxFor(lcu.http, new Handles(), { loadout, knownChampions: champs }) };
  };
  const body = { championId: 103, index: 0 };

  it("creates a new page named for the champion when there's a free slot", async () => {
    const s = setup(PAGES);
    await act("runes/recommended", body, s.ctx);
    expect(s.lcu.writes()).toEqual([
      { method: "POST", path: "/lol-perks/v1/pages", body: { name: "Phone: Ahri", primaryStyleId: 8200, subStyleId: 8300, selectedPerkIds: REC.perkIds, current: true } },
      { method: "PUT", path: "/lol-perks/v1/currentpage", body: 555 },
    ]);
  });

  it("reuses the connector's own page instead of touching yours", async () => {
    const own = { id: 103, name: "Phone: Lux", isEditable: true, primaryStyleId: 8000, subStyleId: 8100, order: 2 };
    const s = setup([...PAGES, own], { "PUT /lol-perks/v1/pages/103": ok({}) });
    await act("runes/recommended", body, s.ctx);
    expect(s.lcu.writes()).toEqual([
      { method: "PUT", path: "/lol-perks/v1/pages/103", body: { ...own, name: "Phone: Ahri", primaryStyleId: 8200, subStyleId: 8300, selectedPerkIds: REC.perkIds, current: true } },
      { method: "PUT", path: "/lol-perks/v1/currentpage", body: 103 },
    ]);
  });

  it("never overwrites a page when every slot is yours", async () => {
    const full = [...PAGES, { id: 103, name: "Top", isEditable: true }];
    const s = setup(full);
    await expectError(act("runes/recommended", body, s.ctx), 409, /rename one to "Phone"/);
    expect(s.lcu.writes()).toHaveLength(0);
  });

  it("refuses a stale champion or index and bad input", async () => {
    const s = setup(PAGES, {}, 99);
    await expectError(act("runes/recommended", body, s.ctx), 409, /champion changed/);
    const t = setup(PAGES);
    await expectError(act("runes/recommended", { championId: 103, index: 1 }, t.ctx), 409, /anymore/);
    await expectError(act("runes/recommended", { championId: 103, index: 9 }, t.ctx), 400, /index/);
    await expectError(act("runes/recommended", { championId: 103, index: 0, perks: [1] }, t.ctx), 400, /unexpected/);
    expect([...s.lcu.writes(), ...t.lcu.writes()]).toHaveLength(0);
  });
});

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

describe("store: runes and invitations", () => {
  it("pushes rune pages and invitations, and looks up who invited me", async () => {
    const answers: Record<string, unknown> = {
      [URI.phase]: "Lobby",
      [URI.runePages]: PAGES,
      [URI.currentRunePage]: PAGES[2],
      "/lol-summoner/v1/summoners/7": { gameName: "DuoPartner" },
      "/lol-game-queues/v1/queues/440": { description: "Ranked Flex" },
    };
    const http = { getOrNull: async (p: string) => answers[p] ?? null } as unknown as LcuHttp;
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(http);
    for (let i = 0; i < 4; i++) await tick();
    expect(store.state.runes?.pages.find((p) => p.isCurrent)?.name).toBe("Jungle");
    expect(store.state.invitations).toEqual([]);

    store.handleEvent({ uri: URI.invitations, eventType: "Update", data: [{ invitationId: "x", state: "Pending", fromSummonerId: 7, gameConfig: { queueId: 440 } }] });
    expect(store.state.invitations[0]?.from).toBe("A friend");
    for (let i = 0; i < 4; i++) await tick();
    expect(store.state.invitations[0]).toMatchObject({ from: "DuoPartner", queueName: "Ranked Flex", canAccept: true });

    store.handleEvent({ uri: URI.currentRunePage, eventType: "Update", data: PAGES[1] });
    expect(store.state.runes?.pages.find((p) => p.isCurrent)?.name).toBe("Mid mage");
    store.handleEvent({ uri: URI.invitations, eventType: "Delete", data: null });
    expect(store.state.invitations).toEqual([]);
  });
});
