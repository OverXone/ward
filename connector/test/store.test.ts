import { describe, expect, it } from "vitest";
import type { LcuHttp } from "../src/lcu/http";
import { Store, URI } from "../src/state/store";
import { advanceTo, draftSession } from "./fixtures/sessions";

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
});
