<script setup lang="ts">
import type { ChampionSummary } from "@shared/phone-api";
import { computed, onBeforeUnmount, ref } from "vue";
import { favorites, toggleFavorite } from "../favorites";
import { showToast } from "../store";
import ChampIcon from "./ChampIcon.vue";

const props = defineProps<{
  champions: ChampionSummary[];
  /** Ids that can be chosen right now (pickable or bannable). */
  enabled: Set<number>;
  selected: number;
  mode: "pick" | "ban";
  /** Ids that can't be chosen for a specific reason (shown greyed with that reason when searching). */
  reasons?: Map<number, string>;
}>();
const emit = defineEmits<{ choose: [id: number] }>();

const search = ref("");
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const filtered = computed(() => {
  const q = fold(search.value);
  const matches = props.champions.filter((c) => !q || fold(c.name).includes(q) || fold(c.alias).includes(q));
  // When picking, favorites come first (each group stays alphabetical). Not when banning:
  // the champions you like to play are the last ones you want at the top of a ban list.
  const available = matches.filter((c) => props.enabled.has(c.id) && !props.reasons?.has(c.id));
  if (props.mode === "pick") available.sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)));
  // Unavailable champions only appear when searching, greyed out, so you can see why they're missing.
  const unavailable = q ? matches.filter((c) => !props.enabled.has(c.id) || props.reasons?.has(c.id)) : [];
  return { available, unavailable };
});

// Long-press a champion to add it to (or remove it from) favorites. A normal tap still chooses it.
const LONG_PRESS_MS = 500;
let pressTimer: number | undefined;
let longPressed = false;

function pressStart(id: number, name: string) {
  longPressed = false;
  window.clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    longPressed = true;
    const on = toggleFavorite(id);
    try {
      navigator.vibrate?.(30);
    } catch {
      // unsupported
    }
    showToast(on ? `${name} added to favorites` : `${name} removed from favorites`, "info");
  }, LONG_PRESS_MS);
}

function pressEnd() {
  window.clearTimeout(pressTimer);
}

function tap(id: number) {
  if (longPressed) {
    longPressed = false;
    return;
  }
  emit("choose", id);
}

onBeforeUnmount(pressEnd);
</script>

<template>
  <section class="picker">
    <div class="search">
      <input
        v-model="search"
        type="search"
        :placeholder="mode === 'ban' ? 'Search a champion to ban' : 'Search champions'"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="search"
      />
    </div>
    <p v-if="mode === 'pick' && !favorites.size && filtered.available.length" class="hint">Tip: long-press a champion to pin it to the top.</p>
    <div class="grid">
      <button
        v-for="c in filtered.available"
        :key="c.id"
        class="cell"
        :class="{ selected: c.id === selected, ban: mode === 'ban' }"
        :aria-pressed="c.id === selected"
        @click="tap(c.id)"
        @pointerdown="pressStart(c.id, c.name)"
        @pointerup="pressEnd"
        @pointerleave="pressEnd"
        @pointercancel="pressEnd"
        @contextmenu.prevent
      >
        <ChampIcon :id="c.id" :size="64" />
        <span v-if="favorites.has(c.id)" class="fav" aria-label="Favorite">★</span>
        <span class="cname">{{ c.name }}</span>
      </button>
      <button v-for="c in filtered.unavailable" :key="'u' + c.id" class="cell unavailable" disabled>
        <ChampIcon :id="c.id" :size="64" banned />
        <span class="cname">{{ c.name }}</span>
        <span class="why">{{ reasons?.get(c.id) ?? (mode === "ban" ? "Can't ban" : "Not owned or taken") }}</span>
      </button>
    </div>
    <p v-if="!filtered.available.length && !filtered.unavailable.length" class="none">
      {{ !champions.length ? "Loading champions…" : search ? "No champion matches." : "No champions available." }}
    </p>
  </section>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.search {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 8px 0;
  background: var(--bg);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 8px;
}
.cell {
  position: relative;
  -webkit-touch-callout: none;
  user-select: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  border-radius: 12px;
  background: transparent;
  border: 2px solid transparent;
  min-width: 0;
}
.cell.selected {
  border-color: var(--accept);
  background: rgba(34, 195, 120, 0.12);
}
.cell.selected.ban {
  border-color: var(--danger);
  background: rgba(229, 72, 77, 0.12);
}
.cname {
  font-size: 12px;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 2px;
}
.unavailable {
  opacity: 0.55;
}
.why {
  font-size: 10px;
  color: var(--muted);
  line-height: 1.1;
  text-align: center;
}
.fav {
  position: absolute;
  top: 0;
  right: 4px;
  font-size: 14px;
  color: var(--gold);
  text-shadow: 0 0 3px #000;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}
.none {
  color: var(--muted);
  text-align: center;
}
</style>
