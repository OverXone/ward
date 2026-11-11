/**
 * Champion list + icons, served from the League client itself so the phone
 * needs no internet access. Cached per LCU connection.
 */

import type { LcuHttp } from "./lcu/http";
import type { ChampionSummary } from "./shared/phone-api";

const SUMMARY_PATH = "/lol-game-data/assets/v1/champion-summary.json";
const MAX_ICON_CACHE = 400;

export class Champions {
  private summary: ChampionSummary[] | null = null;
  private ids = new Set<number>();
  private icons = new Map<number, Buffer>();
  private loading: Promise<ChampionSummary[] | null> | null = null;
  private http: LcuHttp | null = null;

  attach(http: LcuHttp | null): void {
    this.http = http;
    this.summary = null;
    this.ids.clear();
    this.icons.clear();
    this.loading = null;
  }

  detach(): void {
    this.attach(null);
  }

  async list(): Promise<ChampionSummary[] | null> {
    if (this.summary) return this.summary;
    const http = this.http;
    if (!http) return null;
    this.loading ??= (async () => {
      const raw = await http.getOrNull<{ id?: unknown; name?: unknown; alias?: unknown }[]>(SUMMARY_PATH);
      if (!Array.isArray(raw)) return null;
      const list = raw
        .filter((c) => Number.isInteger(c.id) && (c.id as number) > 0 && typeof c.name === "string")
        .map((c) => ({ id: c.id as number, name: String(c.name).slice(0, 40), alias: String(c.alias ?? "").slice(0, 40) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (http !== this.http) return null;
      this.summary = list;
      this.ids = new Set(list.map((c) => c.id));
      return list;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** PNG bytes, or null if the id is not a real champion or the client has no icon. */
  async icon(id: number): Promise<Buffer | null> {
    if (!Number.isInteger(id) || id <= 0) return null;
    const cached = this.icons.get(id);
    if (cached) return cached;
    await this.list();
    if (!this.ids.has(id) || !this.http) return null;
    const http = this.http;
    try {
      const res = await http.request("GET", `/lol-game-data/assets/v1/champion-icons/${id}.png`);
      if (res.status !== 200 || !res.contentType.includes("image")) return null;
      if (http !== this.http) return null;
      if (this.icons.size >= MAX_ICON_CACHE) this.icons.clear();
      this.icons.set(id, res.body);
      return res.body;
    } catch {
      return null;
    }
  }
}
