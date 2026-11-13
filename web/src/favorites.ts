/** Favorite champions, kept on this phone only. Shown first in the champion grid. */

import { reactive } from "vue";

const KEY = "lolc.favorites";

function load(): number[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 200) : [];
  } catch {
    return [];
  }
}

export const favorites = reactive(new Set<number>(load()));

export function toggleFavorite(id: number): boolean {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...favorites]));
  } catch {
    // storage blocked: favorites last until the page reloads
  }
  return favorites.has(id);
}
