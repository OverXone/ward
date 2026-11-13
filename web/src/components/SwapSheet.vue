<script setup lang="ts">
import { SWAP_KINDS, type ChampSelectPlayer, type SwapKind } from "@shared/phone-api";
import { computed, ref } from "vue";
import { run } from "../store";
import { SWAP_TITLES, swapOutcome } from "../swaps";

const props = defineProps<{ player: ChampSelectPlayer; me: ChampSelectPlayer | null }>();
const emit = defineEmits<{ close: [] }>();

const offers = computed(() => SWAP_KINDS.filter((k) => props.player.swaps[k] === "available"));
const busy = ref(false);

async function request(kind: SwapKind) {
  busy.value = true;
  const ok = await run("champ-select/swap/request", { kind, cellId: props.player.cellId });
  busy.value = false;
  if (ok) emit("close");
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <section class="sheet" role="dialog" aria-modal="true" :aria-label="`Swap with ${player.name}`">
      <h2 class="title">Swap with {{ player.name }}</h2>
      <p v-if="!offers.length" class="none">No swaps with {{ player.name }} right now.</p>
      <button v-for="k in offers" :key="k" class="offer" :disabled="busy" @click="request(k)">
        <span class="offer-title">{{ SWAP_TITLES[k] }}</span>
        <span class="offer-sub">{{ swapOutcome(k, me, player) }}</span>
      </button>
      <button class="btn btn-ghost close" @click="emit('close')">Close</button>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.sheet {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 16px calc(16px + var(--safe-bottom));
  border-radius: 18px 18px 0 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom: none;
}
.title {
  margin: 0 0 4px;
  font-size: 18px;
}
.none {
  margin: 0;
  color: var(--muted);
}
.offer {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 12px 14px;
  min-height: 56px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  text-align: left;
  font: inherit;
}
.offer:disabled {
  opacity: 0.5;
}
.offer-title {
  font-weight: 700;
}
.offer-sub {
  font-size: 13px;
  color: var(--muted);
}
.close {
  margin-top: 4px;
  min-height: 48px;
}
</style>
