import { describe, expect, it } from "vitest";
import type { LcuHttp } from "../src/lcu/http";
import { Store, URI } from "../src/state/store";
import { GRID_PATH, OWNED_PATH } from "../src/ownership";
import { advanceTo, aramSession, draftSession } from "./fixtures/sessions";

const BANNABLE = [51, 99, 103, 157];
const PICKABLE = [51, 103];
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Fake LCU whose GET answers can be held back to simulate a slow snapshot. */
function fakeHttp(answers: Record<string, unknown>) {
  const gets: string[] = [];
  let hold: Promise<void> | null = null;
  const http = {
    async getOrNull(path: string) {
      gets.push(path);
      if (hold) await hold;
      return path in answers ? answers[path] : null;
    },
  } as unknown as LcuHttp;
  return {
    http,
    gets,
    answers,
    holdGets() {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

const event = (uri: string, data: unknown) => ({ uri, eventType: "Update", data });

describe("store champion lists", () => {
  it("doesn't let a slow snapshot overwrite a newer event (bans showed 'Can't ban' for everything)", async () => {
    const session = advanceTo(draftSession(), 0);
    const lcu = fakeHttp({ [URI.phase]: "ChampSelect", [URI.session]: session, [URI.pickable]: PICKABLE, [URI.bannable]: [] });
    const store = new Store();
    store.setLcuStatus("connected");
    const release = lcu.holdGets();
    store.attach(lcu.http); // snapshot in flight; the client will answer bannable = []
    await tick();
    store.handleEvent(event(URI.bannable, BANNABLE)); // newer data arrives meanwhile
    release();
    await tick();
    await tick();
    expect(store.state.champSelect?.bannableChampionIds).toEqual(BANNABLE);
  });

  it("keeps the pushed ban list when GET answers [] afterwards (live client, 2026-11-12)", async () => {
    const lcu = fakeHttp({ [URI.phase]: "ReadyCheck", [URI.pickable]: PICKABLE, [URI.bannable]: [] });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick();
    store.handleEvent(event(URI.bannable, BANNABLE)); // Create event with every id
    lcu.answers[URI.session] = advanceTo(draftSession(), 0);
    lcu.answers[URI.phase] = "ChampSelect";
    store.handleEvent(event(URI.phase, "ChampSelect")); // phase change -> full snapshot, GET bannable = []
    for (let i = 0; i < 4; i++) await tick();
    expect(store.state.champSelect?.bannableChampionIds).toEqual(BANNABLE);
    expect(store.championLists().bannable).toEqual(BANNABLE);
  });

  it("re-fetches a missing list during champ select", async () => {
    const lcu = fakeHttp({ [URI.phase]: "ChampSelect", [URI.pickable]: PICKABLE, [URI.bannable]: null });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick();
    expect(store.state.champSelect).toBeNull();

    lcu.answers[URI.bannable] = BANNABLE; // client now answers properly
    store.handleEvent(event(URI.session, advanceTo(draftSession(), 0)));
    await tick();
    await tick();
    expect(store.state.champSelect?.bannableChampionIds).toEqual(BANNABLE);
  });

  it("re-fetches the lists when champ select moves from planning to bans", async () => {
    const lcu = fakeHttp({ [URI.phase]: "ChampSelect", [URI.pickable]: PICKABLE, [URI.bannable]: BANNABLE });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick();
    store.handleEvent(event(URI.session, draftSession({ phase: "PLANNING" })));
    await tick();
    const before = lcu.gets.filter((g) => g === URI.bannable).length;
    store.handleEvent(event(URI.session, draftSession({ phase: "PLANNING" }))); // same phase: no refetch
    await tick();
    expect(lcu.gets.filter((g) => g === URI.bannable).length).toBe(before);
    store.handleEvent(event(URI.session, advanceTo(draftSession(), 0))); // BAN_PICK
    await tick();
    expect(lcu.gets.filter((g) => g === URI.bannable).length).toBe(before + 1);
  });

  // On the live client the pushed list was still wiped, so the HTTP answer was neither [] nor 404.
  it.each([
    ["an object", {}],
    ["a list of objects", [{ championId: 51 }]],
    ["a string", "nope"],
    ["nothing, before the session exists", null],
  ])("keeps the pushed ban list when GET answers %s", async (_label, answer) => {
    const lcu = fakeHttp({ [URI.phase]: "ReadyCheck", [URI.pickable]: null, [URI.bannable]: null });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick();
    // Real order (2026-11-12): the lists are created before the session, then the phase changes.
    store.handleEvent({ uri: URI.pickable, eventType: "Create", data: PICKABLE });
    store.handleEvent({ uri: URI.bannable, eventType: "Create", data: BANNABLE });
    lcu.answers[URI.bannable] = answer;
    void store.refreshAll(); // a snapshot answering before the session exists
    await tick();
    lcu.answers[URI.session] = advanceTo(draftSession(), 0);
    store.handleEvent({ uri: URI.session, eventType: "Create", data: lcu.answers[URI.session] });
    lcu.answers[URI.phase] = "ChampSelect";
    store.handleEvent(event(URI.phase, "ChampSelect"));
    for (let i = 0; i < 4; i++) await tick();
    expect(store.championLists().bannable).toEqual(BANNABLE);
    expect(store.state.champSelect?.bannableChampionIds).toEqual(BANNABLE);
  });

  it("a Delete event still clears the lists, and old lists are never used outside champ select", async () => {
    const lcu = fakeHttp({ [URI.phase]: "ChampSelect", [URI.session]: advanceTo(draftSession(), 0), [URI.pickable]: PICKABLE, [URI.bannable]: BANNABLE });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    for (let i = 0; i < 3; i++) await tick();
    expect(store.championLists().bannable).toEqual(BANNABLE);
    store.handleEvent({ uri: URI.session, eventType: "Delete", data: null });
    expect(store.championLists().bannable).toEqual([]);
    store.handleEvent({ uri: URI.bannable, eventType: "Delete", data: [] });
    store.handleEvent({ uri: URI.session, eventType: "Create", data: advanceTo(draftSession(), 0) });
    expect(store.championLists().bannable).toEqual([]);
  });
});

describe("store bench ownership", () => {
  const grid = [
    { id: 22, owned: true },
    { id: 51, owned: false, freeToPlay: false },
    { id: 202, owned: false, freeToPlay: true },
  ];

  it("locks bench champions the grid says I can't play, and forgets it when champ select ends", async () => {
    const lcu = fakeHttp({ [URI.phase]: "ChampSelect", [GRID_PATH]: grid });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick();
    store.handleEvent(event(URI.session, aramSession()));
    for (let i = 0; i < 4; i++) await tick();
    expect(store.state.champSelect?.benchLocked).toEqual([51]);
    expect([...(store.playableChampions() ?? [])].sort()).toEqual([202, 22]);

    store.handleEvent({ uri: URI.session, eventType: "Delete", data: null });
    expect(store.playableChampions()).toBeNull();
  });

  it("falls back to the owned-champions list, and locks nothing when neither answers", async () => {
    const owned = [{ id: 22, ownership: { owned: true } }, { id: 51, ownership: { owned: false, rental: { rented: false } } }];
    const lcu = fakeHttp({ [URI.phase]: "ChampSelect", [OWNED_PATH]: owned });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick();
    store.handleEvent(event(URI.session, aramSession()));
    for (let i = 0; i < 4; i++) await tick();
    expect(store.state.champSelect?.benchLocked).toEqual([51]);

    const none = new Store();
    none.setLcuStatus("connected");
    none.attach(fakeHttp({ [URI.phase]: "ChampSelect" }).http);
    await tick();
    none.handleEvent(event(URI.session, aramSession()));
    for (let i = 0; i < 4; i++) await tick();
    expect(none.state.champSelect?.benchLocked).toEqual([]);
  });

  it("doesn't ask about ownership in modes without a bench", async () => {
    const lcu = fakeHttp({ [URI.phase]: "ChampSelect", [GRID_PATH]: grid });
    const store = new Store();
    store.setLcuStatus("connected");
    store.attach(lcu.http);
    await tick();
    store.handleEvent(event(URI.session, advanceTo(draftSession(), 0)));
    await tick();
    expect(lcu.gets).not.toContain(GRID_PATH);
  });
});
