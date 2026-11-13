import { describe, expect, it } from "vitest";
import type { LcuHttp, LcuResponse } from "../src/lcu/http";
import { Loadout } from "../src/loadout";

/** Fake client answering GETs from a table; records every request path. */
function fakeLcu(answers: Record<string, unknown>) {
  const paths: string[] = [];
  const http = {
    async getOrNull(path: string) {
      paths.push(path);
      return path in answers ? answers[path] : null;
    },
    async request(_m: string, path: string): Promise<LcuResponse> {
      paths.push(path);
      return { status: 200, contentType: "image/png", body: Buffer.from("png:" + path) };
    },
  } as unknown as LcuHttp;
  return { http, paths };
}

const SPELLS = [
  { id: 4, name: "Flash", gameModes: ["CLASSIC", "ARAM"], iconPath: "/lol-game-data/assets/DATA/Spells/Icons2D/SummonerFlash.png" },
  { id: 32, name: "Mark", gameModes: ["ARAM"], iconPath: "/lol-game-data/assets/DATA/Spells/Icons2D/Mark.png" },
  { id: 13, name: "Clarity", gameModes: ["CLASSIC", "ARAM"], iconPath: "/lol-game-data/assets/DATA/Spells/Icons2D/Clarity.png" },
  { id: 99, name: "Odd", gameModes: ["CLASSIC"], iconPath: "/lol-maps/assets/../../secret.png" },
];

const base = {
  "/lol-game-data/assets/v1/summoner-spells.json": SPELLS,
  "/lol-gameflow/v1/session": { gameData: { queue: { gameMode: "CLASSIC" } }, password: "never-read" },
  "/lol-summoner/v1/current-summoner": { summonerId: 77 },
  "/lol-collections/v1/inventories/77/spells": { spells: [4, 32, 99] },
};

describe("summoner spells", () => {
  it("offers spells in this game mode that I own", async () => {
    const l = new Loadout();
    l.attach(fakeLcu(base).http);
    expect(await l.availableSpells()).toEqual([
      { id: 4, name: "Flash" },
      { id: 99, name: "Odd" },
    ]);
  });

  it("skips a filter the client can't answer", async () => {
    const l = new Loadout();
    l.attach(fakeLcu({ ...base, "/lol-gameflow/v1/session": null, "/lol-summoner/v1/current-summoner": null }).http);
    expect((await l.availableSpells())?.map((s) => s.id)).toEqual([4, 32, 13, 99]);
  });

  it("serves icons only from client-listed asset paths", async () => {
    const lcu = fakeLcu(base);
    const l = new Loadout();
    l.attach(lcu.http);
    expect((await l.image("spell", 4))?.body.toString()).toBe("png:/lol-game-data/assets/DATA/Spells/Icons2D/SummonerFlash.png");
    expect(await l.image("spell", 99)).toBeNull(); // path outside /lol-game-data/assets/ (and with ..)
    expect(await l.image("spell", 5)).toBeNull(); // not a listed spell
    expect(lcu.paths.filter((p) => p.includes("secret"))).toHaveLength(0);
  });
});

describe("skins", () => {
  const carousel = [
    { id: 103000, isBase: true, name: "Ahri", unlocked: true, tilePath: "/lol-game-data/assets/v1/champion-tiles/103/103000.jpg", childSkins: [] },
    {
      id: 103001,
      name: "Dynasty Ahri",
      unlocked: true,
      tilePath: "/lol-game-data/assets/v1/champion-tiles/103/103001.jpg",
      childSkins: [
        { id: 103021, name: "Ruby", unlocked: true, colors: ["#D33A3A", "#000000"], chromaPreviewPath: "/lol-game-data/assets/v1/champion-chroma-images/103/103021.png" },
        { id: 103022, name: "Pearl", unlocked: false, colors: ["#ffffff"] },
      ],
    },
    { id: 103002, name: "Locked Ahri", unlocked: false, tilePath: "/lol-game-data/assets/v1/champion-tiles/103/103002.jpg" },
    { id: 103003, name: "Disabled Ahri", unlocked: true, disabled: true },
  ];

  it("lists usable skins and chromas only", async () => {
    const l = new Loadout();
    l.attach(fakeLcu({ "/lol-champ-select/v1/skin-carousel-skins": carousel }).http);
    expect(await l.availableSkins()).toEqual([
      { id: 103000, name: "Default", isBase: true, chromas: [] },
      { id: 103001, name: "Dynasty Ahri", isBase: false, chromas: [{ id: 103021, name: "Ruby", color: "#D33A3A" }] },
    ]);
    expect([...(await l.selectableSkinIds())!]).toEqual([103000, 103001, 103021]);
    expect(await l.image("skin", 103002)).toBeNull(); // locked: never listed
    expect(await l.image("skin", 103021)).not.toBeNull();
  });

  it("forgets everything when the client reconnects", async () => {
    const l = new Loadout();
    l.attach(fakeLcu({ "/lol-champ-select/v1/skin-carousel-skins": carousel }).http);
    await l.availableSkins();
    l.attach(fakeLcu({}).http);
    expect(await l.image("skin", 103001)).toBeNull();
  });
});
