<script setup lang="ts">
import { ref } from "vue";
import { championName, run } from "../store";
import ChampIcon from "./ChampIcon.vue";

/** ARAM-style bench and rerolls. bench null = this mode has no bench; rerollsLeft null = no rerolls. */
const props = defineProps<{ bench: number[] | null; rerollsLeft: number | null }>();

const busy = ref<number | "reroll" | null>(null);

async function swap(id: number) {
  if (busy.value !== null) return;
  busy.value = id;
  await run("champ-select/bench", { championId: id });
  busy.value = null;
}

async function reroll() {
  if (busy.value !== null || !props.rerollsLeft) return;
  busy.value = "reroll";
  await run("champ-select/reroll");
  busy.value = null;
}
</script>

<template>
  <section class="bench card">
    <div class="top">
      <h2 class="title">Bench</h2>
      <!-- Hidden at 0: the 2026 ARAM (queue 450) has no rerolls at all. -->
      <button v-if="rerollsLeft" class="btn btn-ghost reroll" :disabled="busy !== null" @click="reroll">
        <template v-if="busy === 'reroll'">Rerolling…</template>
        <template v-else>Reroll ({{ rerollsLeft }} left)</template>
      </button>
    </div>
    <template v-if="bench">
      <div v-if="bench.length" class="row">
        <button
          v-for="id in bench"
          :key="id"
          class="slot"
          :class="{ busy: busy === id }"
          :disabled="busy !== null"
          :aria-label="`Swap for ${championName(id)}`"
          @click="swap(id)"
        >
          <ChampIcon :id="id" :size="56" />
          <span class="name">{{ championName(id) }}</span>
        </button>
      </div>
      <p v-else class="hint">No champions on the bench yet.</p>
      <p v-if="bench.length" class="hint">Tap one to swap your champion for it.</p>
    </template>
  </section>
</template>

<style scoped>
.bench {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.reroll {
  min-height: 40px;
  padding: 0 14px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 64px;
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.slot:disabled {
  cursor: default;
}
.slot.busy,
.slot:active:not(:disabled) {
  opacity: 0.6;
}
.name {
  width: 100%;
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hint {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
</style>
