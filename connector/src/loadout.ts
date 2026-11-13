/**
 * Summoner spells and skins for my champ-select loadout, read from the League client.
 *
 * Endpoints (from the client's own API list, 2026-11-12):
 * - /lol-game-data/assets/v1/summoner-spells.json   every spell: id, name, gameModes, iconPath
 * - /lol-summoner/v1/current-summoner + /lol-collections/v1/inventories/{summonerId}/spells   spells I own
 * - /lol-gameflow/v1/session   the current game mode (only `gameData.queue.gameMode` is read)
 * - /lol-champ-select/v1/skin-carousel-skins   skins (with chromas) for my champion, with `unlocked`
 *
 * Images are only ever fetched from paths the client itself listed for an id we validated, and only
 * under /lol-game-data/assets/, so this can't be used to read anything else from the client.
 */

import type { LcuHttp } from "./lcu/http";
import type { SkinOption, SpellOption } from "./shared/phone-api";

const SPELLS_PATH = "/lol-game-data/assets/v1/summoner-spells.json";
const CAROUSEL_PATH = "/lol-champ-select/v1/skin-carousel-skins";
const ASSET_PATH = /^\/lol-game-data\/assets\/[A-Za-z0-9_\-/.]+\.(png|jpg|jpeg)$/i;
const MAX_IMAGES = 200;

interface RawSpell {
  id?: unknown;
  name?: unknown;
  gameModes?: unknown;
  iconPath?: unknown;
}

interface RawSkin {
  id?: unknown;
  championId?: unknown;
  name?: unknown;
  isBase?: unknown;
  unlocked?: unknown;
  disabled?: unknown;
  tilePath?: unknown;
  chromaPreviewPath?: unknown;
  colors?: unknown;
  childSkins?: unknown;
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const text = (v: unknown, max = 60) => (typeof v === "string" ? v.slice(0, max) : "");
const assetPath = (v: unknown) => (typeof v === "string" && ASSET_PATH.test(v) && !v.includes("..") ? v : null);
const color = (v: unknown) => (Array.isArray(v) && typeof v[0] === "string" && /^#[0-9a-f]{6}$/i.test(v[0]) ? v[0] : null);

export class Loadout {
  private http: LcuHttp | null = null;
  private spells: { id: number; name: string; modes: string[]; icon: string | null }[] | null = null;
  /** id -> image path, filled from lists we fetched (spells and skins). */
  private imagePaths = new Map<string, string>();
  private images = new Map<string, Buffer>();

  attach(http: LcuHttp | null): void {
    this.http = http;
    this.spells = null;
    this.imagePaths.clear();
    this.images.clear();
  }

  private async allSpells() {
    if (this.spells) return this.spells;
    const http = this.http;
    const raw = http ? await http.getOrNull<RawSpell[]>(SPELLS_PATH) : null;
    if (!Array.isArray(raw) || http !== this.http) return null;
    this.spells = raw
      .filter((s) => isId(s.id) && typeof s.name === "string")
      .map((s) => ({
        id: s.id as number,
        name: text(s.name, 40),
        modes: Array.isArray(s.gameModes) ? s.gameModes.filter((m): m is string => typeof m === "string") : [],
        icon: assetPath(s.iconPath),
      }));
    return this.spells;
  }

  /**
   * Spells I can take into this game: in the current game mode and owned. If the client doesn't say
   * (no mode, no inventory), that filter is skipped and League still refuses anything not allowed.
   */
  async availableSpells(): Promise<SpellOption[] | null> {
    const http = this.http;
    const all = await this.allSpells();
    if (!http || !all) return null;
    const [flow, me] = await Promise.all([
      http.getOrNull<{ gameData?: { queue?: { gameMode?: unknown } } }>("/lol-gameflow/v1/session"),
      http.getOrNull<{ summonerId?: unknown }>("/lol-summoner/v1/current-summoner"),
    ]);
    const mode = typeof flow?.gameData?.queue?.gameMode === "string" ? flow.gameData.queue.gameMode : null;
    let owned: Set<number> | null = null;
    if (isId(me?.summonerId)) {
      const inv = await http.getOrNull<{ spells?: unknown }>(`/lol-collections/v1/inventories/${me.summonerId}/spells`);
      if (Array.isArray(inv?.spells)) owned = new Set(inv.spells.filter(isId));
    }
    const list = all.filter((s) => (!mode || s.modes.includes(mode)) && (!owned || owned.has(s.id)));
    for (const s of list) if (s.icon) this.imagePaths.set(`spell:${s.id}`, s.icon);
    return list.map(({ id, name }) => ({ id, name }));
  }

  /** Skins (and their chromas) I can use on my current champion; empty before I've picked. */
  async availableSkins(): Promise<SkinOption[] | null> {
    const http = this.http;
    if (!http) return null;
    const raw = await http.getOrNull<RawSkin[]>(CAROUSEL_PATH);
    if (!Array.isArray(raw) || http !== this.http) return null;
    const usable = (s: RawSkin) => isId(s.id) && s.unlocked === true && s.disabled !== true;
    const out: SkinOption[] = [];
    for (const s of raw.filter(usable)) {
      const id = s.id as number;
      const tile = assetPath(s.tilePath);
      if (tile) this.imagePaths.set(`skin:${id}`, tile);
      const chromas = (Array.isArray(s.childSkins) ? (s.childSkins as RawSkin[]) : []).filter(usable).map((c) => {
        const preview = assetPath(c.chromaPreviewPath);
        if (preview) this.imagePaths.set(`skin:${c.id as number}`, preview);
        return { id: c.id as number, name: text(c.name), color: color(c.colors) };
      });
      out.push({ id, name: s.isBase === true ? "Default" : text(s.name), isBase: s.isBase === true, chromas });
    }
    return out;
  }

  /** Every skin or chroma id the client currently lets me select. */
  async selectableSkinIds(): Promise<Set<number> | null> {
    const skins = await this.availableSkins();
    if (!skins) return null;
    return new Set(skins.flatMap((s) => [s.id, ...s.chromas.map((c) => c.id)]));
  }

  /** Image bytes for a spell or skin id we listed before, or null. */
  async image(kind: "spell" | "skin", id: number): Promise<{ type: string; body: Buffer } | null> {
    if (!isId(id)) return null;
    const key = `${kind}:${id}`;
    let path = this.imagePaths.get(key);
    if (!path) {
      // Not listed yet (e.g. the phone asked for an icon before opening the list): list now.
      if (kind === "spell") await this.availableSpells();
      else await this.availableSkins();
      path = this.imagePaths.get(key);
    }
    const http = this.http;
    if (!path || !http) return null;
    const cached = this.images.get(key);
    if (cached) return { type: path.endsWith(".png") ? "image/png" : "image/jpeg", body: cached };
    try {
      const res = await http.request("GET", path);
      if (res.status !== 200 || !res.contentType.includes("image") || http !== this.http) return null;
      if (this.images.size >= MAX_IMAGES) this.images.clear();
      this.images.set(key, res.body);
      return { type: res.contentType.split(";")[0]!, body: res.body };
    } catch {
      return null;
    }
  }
}
