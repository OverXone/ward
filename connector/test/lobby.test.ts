import { describe, expect, it } from "vitest";
import { runAction, type ActionName } from "../src/actions";
import type { LcuHttp } from "../src/lcu/http";
import { deriveQueues, QUEUES, type RawQueue } from "../src/queues";
import { deriveLobby } from "../src/state/store";
import { expectError, fakeLcu, ok, type Route } from "./fake-lcu";

const run = (name: ActionName, body: unknown, http: LcuHttp | null) => runAction(name, body, { http });

const q = (id: number, name: string, extra: Partial<RawQueue> = {}): RawQueue => ({
  id,
  name,
  description: name,
  gameMode: "CLASSIC",
  category: "PvP",
  queueAvailability: "Available",
  isEnabled: true,
  isVisible: true,
  isCustom: false,
  ...extra,
});

const QUEUE_LIST: RawQueue[] = [
  q(450, "ARAM", { gameMode: "ARAM" }),
  q(420, "Ranked Solo/Duo", { allowablePremadeSizes: [1, 2] }),
  q(400, "Normal Draft"),
  q(890, "Co-op vs. AI Intermediate", { category: "VersusAi" }),
  q(1090, "Teamfight Tactics", { gameMode: "TFT" }),
  q(1900, "URF", { queueAvailability: "PlatformDisabled" }),
  q(1300, "Nexus Blitz", { isEnabled: false }),
  q(2000, "Tutorial 1", { gameMode: "TUTORIAL_MODULE_1", category: "VersusAi" }),
  q(3100, "Practice Tool", { category: "Custom", isCustom: true }),
  q(3200, "Hidden", { isVisible: false }),
  q(1700, "Arena", { gameMode: "CHERRY", queueAvailability: "DoesntMeetRequirements" }),
];

describe("deriveQueues", () => {
  it("offers what the play menu offers, grouped and in the usual order", () => {
    const list = deriveQueues(QUEUE_LIST, null, 1);
    expect(list.map((x) => `${x.group}: ${x.name}`)).toEqual([
      "PvP: Normal Draft",
      "PvP: Ranked Solo/Duo",
      "PvP: ARAM",
      "PvP: Arena",
      "Co-op vs AI: Co-op vs. AI Intermediate",
      "Teamfight Tactics: Teamfight Tactics",
    ]);
    expect(list.find((x) => x.id === 1700)).toMatchObject({ canPick: false, reason: "Requirements not met" });
  });

  it("greys out what the party may not play, with the reason", () => {
    const eligibility = [
      { queueId: 420, eligible: false, restrictions: [{ restrictionCode: "TeamDivisionRestriction" }] },
      { queueId: 400, eligible: false, restrictions: [{ restrictionCode: "SomethingNew" }] },
      // Warnings and Quickplay's slot checks don't stop a switch.
      { queueId: 450, eligible: false, restrictions: [{ restrictionCode: "PlayerLeaverTaintedWarningRestriction" }, { restrictionCode: "QPPlayerPositionCoverageRestriction" }] },
    ];
    const list = deriveQueues(QUEUE_LIST, eligibility, 2);
    expect(list.find((x) => x.id === 420)).toMatchObject({ canPick: false, reason: "Party ranks too far apart" });
    expect(list.find((x) => x.id === 400)).toMatchObject({ canPick: false, reason: "Not available right now" });
    expect(list.find((x) => x.id === 450)).toMatchObject({ canPick: true, reason: null });
  });

  it("checks the party size against the mode's premade sizes", () => {
    const list = deriveQueues(QUEUE_LIST, null, 3);
    expect(list.find((x) => x.id === 420)).toMatchObject({ canPick: false, reason: "Party too big for this mode" });
    expect(list.find((x) => x.id === 450)?.canPick).toBe(true);
  });

  it("doesn't hide everything when a client marks nothing visible", () => {
    expect(deriveQueues([q(450, "ARAM", { isVisible: false })], null, 1).map((x) => x.name)).toEqual(["ARAM"]);
    expect(deriveQueues(null, null, 1)).toEqual([]);
  });
});

describe("deriveLobby roles and mode", () => {
  it("reads roles, the position selector and who may switch", () => {
    const view = deriveLobby(
      {
        localMember: { isLeader: false, allowedChangeActivity: true, firstPositionPreference: "TOP", secondPositionPreference: "nonsense" },
        gameConfig: { queueId: 420, showPositionSelector: true },
      },
      "Ranked Solo/Duo",
    );
    expect(view).toMatchObject({ canChangeMode: true, showRoles: true, roles: ["TOP", "UNSELECTED"], needsSlots: false });
    expect(deriveLobby({ localMember: { isLeader: true }, gameConfig: { queueId: 490, showQuickPlaySlotSelection: true } }, null)).toMatchObject({
      canChangeMode: true,
      showRoles: false,
      roles: ["UNSELECTED", "UNSELECTED"],
      needsSlots: true,
    });
  });
});

describe("lobby/mode", () => {
  const lobby = (extra: object = {}) => ({ localMember: { isLeader: true }, gameConfig: { queueId: 420 }, members: [{}, {}], ...extra });
  function modeLcu(phase: string, lobbyJson: object | null, extra: Record<string, Route> = {}) {
    return fakeLcu({
      "GET /lol-gameflow/v1/gameflow-phase": ok(phase),
      "GET /lol-lobby/v2/lobby": lobbyJson ? ok(lobbyJson) : () => ({ status: 404 }),
      [`GET ${QUEUES}`]: ok(QUEUE_LIST),
      "POST /lol-lobby/v2/eligibility/party": ok([]),
      "POST /lol-lobby/v2/eligibility/self": ok([]),
      "POST /lol-lobby/v2/lobby": ok(lobby()),
      ...extra,
    });
  }
  const switches = (lcu: ReturnType<typeof fakeLcu>) => lcu.writes().filter((c) => c.path === "/lol-lobby/v2/lobby");

  it("switches the lobby to an offered mode", async () => {
    const lcu = modeLcu("Lobby", lobby());
    await run("lobby/mode", { queueId: 450 }, lcu.http);
    expect(switches(lcu)).toEqual([{ method: "POST", path: "/lol-lobby/v2/lobby", body: { queueId: 450 } }]);
  });

  it("opens a lobby when there's none", async () => {
    const lcu = modeLcu("None", null);
    await run("lobby/mode", { queueId: 450 }, lcu.http);
    expect(switches(lcu)).toHaveLength(1);
    expect(lcu.calls.some((c) => c.path === "/lol-lobby/v2/eligibility/self")).toBe(true);
  });

  it("does nothing when the lobby already plays that mode", async () => {
    const lcu = modeLcu("Lobby", lobby());
    await run("lobby/mode", { queueId: 420 }, lcu.http);
    expect(switches(lcu)).toHaveLength(0);
  });

  it("refuses when not the leader, queued, mid-game, or the mode isn't offered", async () => {
    const notLeader = modeLcu("Lobby", lobby({ localMember: { isLeader: false } }));
    await expectError(run("lobby/mode", { queueId: 450 }, notLeader.http), 409, /leader/);
    await expectError(run("lobby/mode", { queueId: 450 }, modeLcu("Matchmaking", lobby()).http), 409, /queue first/);
    await expectError(run("lobby/mode", { queueId: 450 }, modeLcu("InProgress", null).http), 409);
    const lcu = modeLcu("Lobby", lobby());
    for (const queueId of [3100, 2000, 1900, 1300, 99999, 1700]) await expectError(run("lobby/mode", { queueId }, lcu.http), 409);
    expect(switches(lcu)).toHaveLength(0);
    expect(switches(notLeader)).toHaveLength(0);
  });

  it("refuses a mode the party may not play, and validates input", async () => {
    const lcu = modeLcu("Lobby", lobby({ gameConfig: { queueId: 450 }, members: [{}, {}, {}] }));
    await expectError(run("lobby/mode", { queueId: 420 }, lcu.http), 409, /party too big/);
    expect(switches(lcu)).toHaveLength(0);
    await expectError(run("lobby/mode", { queueId: "450" }, lcu.http), 400);
    await expectError(run("lobby/mode", { queueId: 450, extra: 1 }, lcu.http), 400);
  });

  it("shows League's refusal", async () => {
    const lcu = modeLcu("Lobby", lobby(), { "POST /lol-lobby/v2/lobby": () => ({ status: 400, json: { message: "Error response for POST /lol-lobby/v2/lobby: INVALID_PARTY_SIZE" } }) });
    await expectError(run("lobby/mode", { queueId: 450 }, lcu.http), 502, /invalid party size/);
  });
});

describe("lobby/roles", () => {
  const PATH = "/lol-lobby/v2/lobby/members/localMember/position-preferences";
  const rolesLcu = (showPositionSelector = true, phase = "Lobby") =>
    fakeLcu({
      "GET /lol-gameflow/v1/gameflow-phase": ok(phase),
      "GET /lol-lobby/v2/lobby": ok({ localMember: { isLeader: false }, gameConfig: { queueId: 420, showPositionSelector } }),
      [`PUT ${PATH}`]: ok({}),
    });

  it("sets my first and second role", async () => {
    const lcu = rolesLcu();
    await run("lobby/roles", { first: "TOP", second: "JUNGLE" }, lcu.http);
    await run("lobby/roles", { first: "UTILITY", second: "FILL" }, lcu.http);
    await run("lobby/roles", { first: "FILL" }, lcu.http);
    expect(lcu.writes().map((c) => c.body)).toEqual([
      { firstPreference: "TOP", secondPreference: "JUNGLE" },
      { firstPreference: "UTILITY", secondPreference: "FILL" },
      { firstPreference: "FILL", secondPreference: "UNSELECTED" },
    ]);
  });

  it("rejects bad combinations before touching League", async () => {
    const lcu = rolesLcu();
    for (const body of [
      { first: "TOP", second: "TOP" },
      { first: "UNSELECTED", second: "TOP" },
      { first: "FILL", second: "TOP" },
      { first: "top", second: "JUNGLE" },
      { first: "TOP" },
      { first: "TOP", second: "JUNGLE", third: "MIDDLE" },
    ]) {
      await expectError(run("lobby/roles", body, lcu.http), 400);
    }
    expect(lcu.writes()).toHaveLength(0);
  });

  it("refuses outside a lobby or in a mode without roles", async () => {
    await expectError(run("lobby/roles", { first: "TOP", second: "JUNGLE" }, rolesLcu(false).http), 409, /doesn't use roles/);
    await expectError(run("lobby/roles", { first: "TOP", second: "JUNGLE" }, rolesLcu(true, "Matchmaking").http), 409);
  });
});
