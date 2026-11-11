<script setup lang="ts">
import type { ChampionSummary } from "@shared/phone-api";
import { computed, ref } from "vue";
import ChampIcon from "./ChampIcon.vue";

const props = defineProps<{
  champions: ChampionSummary[];
  /** Ids that can be chosen right now (pickable or bannable). */
  enabled: Set<number>;
  selected: number;
  mode: "pick" | "ban";
}>();
const emit = defineEmits<{ choose: [id: number] }>();

const search = ref("");
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const filtered = computed(() => {
  const q = fold(search.value);
  const matches = props.champions.filter((c) => !q || fold(c.name).includes(q) || fold(c.alias).includes(q));
  const available = matches.filter((c) => props.enabled.has(c.id));
  // Unavailable champions only appear when searching, greyed out, so you can see why they're missing.
  const unavailable = q ? matches.filter((c) => !props.enabled.has(c.id)) : [];
  return { available, unavailable };
});
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
    <div class="grid">
      <button
        v-for="c in filtered.available"
        :key="c.id"
        class="cell"
        :class="{ selected: c.id === selected, ban: mode === 'ban' }"
        :aria-pressed="c.id === selected"
        @click="emit('choose', c.id)"
      >
        <ChampIcon :id="c.id" :size="64" />
        <span class="cname">{{ c.name }}</span>
      </button>
      <button v-for="c in filtered.unavailable" :key="'u' + c.id" class="cell unavailable" disabled>
        <ChampIcon :id="c.id" :size="64" banned />
        <span class="cname">{{ c.name }}</span>
      </button>
    </div>
    <p v-if="!filtered.available.length && !filtered.unavailable.length" class="none">
      {{ champions.length ? "No champion matches." : "Loading champions…" }}
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
  opacity: 0.5;
}
.none {
  color: var(--muted);
  text-align: center;
}
</style>
