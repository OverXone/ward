<script setup lang="ts">
import { computed, ref } from "vue";
import { championName, run, showToast } from "../store";
import ChampIcon from "./ChampIcon.vue";

/**
 * ARAM-style bench and rerolls. bench null = this mode has no bench; rerollsLeft null = no rerolls.
 * locked = bench champions I don't own: shown with a lock like on the PC, and not swappable.
 */
const props = defineProps<{ bench: number[] | null; locked: number[]; rerollsLeft: number | null }>();

const busy = ref<number | "reroll" | null>(null);
const lockedSet = computed(() => new Set(props.locked));
const anyFree = computed(() => (props.bench ?? []).some((id) => !lockedSet.value.has(id)));

async function swap(id: number) {
  if (busy.value !== null) return;
  if (lockedSet.value.has(id)) {
    showToast(`You don't own ${championName(id)}, so you can't swap for it.`, "info");
    return;
  }
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
        <!-- Locked slots stay tappable (aria-disabled, not disabled) so a tap can say why. -->
        <button
          v-for="id in bench"
          :key="id"
          class="slot"
          :class="{ busy: busy === id, locked: lockedSet.has(id) }"
          :disabled="busy !== null"
          :aria-disabled="lockedSet.has(id) || undefined"
          :aria-label="lockedSet.has(id) ? `${championName(id)}, not owned` : `Swap for ${championName(id)}`"
          @click="swap(id)"
        >
          <span class="icon">
            <ChampIcon :id="id" :size="56" />
            <svg v-if="lockedSet.has(id)" class="lock" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z" />
            </svg>
          </span>
          <span class="name">{{ championName(id) }}</span>
        </button>
      </div>
      <p v-else class="hint">No champions on the bench yet.</p>
      <p v-if="bench.length" class="hint">
        <template v-if="anyFree">Tap one to swap your champion for it.</template>
        <template v-else>You don't own any of these champions.</template>
      </p>
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
.slot:disabled,
.slot.locked {
  cursor: default;
}
.slot.busy,
.slot:active:not(:disabled):not(.locked) {
  opacity: 0.6;
}
.icon {
  position: relative;
  display: block;
  line-height: 0;
}
.locked .icon :deep(img) {
  filter: grayscale(1) brightness(0.55);
}
.lock {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 22px;
  height: 22px;
  fill: #fff;
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.7));
}
.locked .name {
  color: var(--muted);
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
