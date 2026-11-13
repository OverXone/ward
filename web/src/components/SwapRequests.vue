<script setup lang="ts">
import type { ChampSelectPlayer, SwapKind } from "@shared/phone-api";
import { ref } from "vue";
import { run } from "../store";
import { SWAP_TITLES, swapOutcome } from "../swaps";

export interface SwapRequest {
  player: ChampSelectPlayer;
  kind: SwapKind;
  state: "sent" | "received";
}

defineProps<{ requests: SwapRequest[]; me: ChampSelectPlayer | null }>();

const busy = ref<string | null>(null);
const key = (r: SwapRequest) => `${r.kind}:${r.player.cellId}`;

async function respond(r: SwapRequest, verb: "accept" | "decline" | "cancel") {
  if (busy.value) return;
  busy.value = key(r);
  await run(`champ-select/swap/${verb}`, { kind: r.kind, cellId: r.player.cellId });
  busy.value = null;
}
</script>

<template>
  <section class="swaps" aria-live="polite">
    <article v-for="r in requests" :key="key(r)" class="swap card" :class="r.state">
      <p class="what">
        <template v-if="r.state === 'received'">
          <strong>{{ r.player.name }}</strong> asks for a {{ SWAP_TITLES[r.kind].toLowerCase() }}
        </template>
        <template v-else>Waiting for <strong>{{ r.player.name }}</strong> to answer your {{ SWAP_TITLES[r.kind].toLowerCase() }}</template>
      </p>
      <p class="outcome">{{ swapOutcome(r.kind, me, r.player) }}</p>
      <div class="buttons">
        <template v-if="r.state === 'received'">
          <button class="btn btn-accept" :disabled="!!busy" @click="respond(r, 'accept')">Accept</button>
          <button class="btn btn-ghost" :disabled="!!busy" @click="respond(r, 'decline')">Decline</button>
        </template>
        <button v-else class="btn btn-ghost" :disabled="!!busy" @click="respond(r, 'cancel')">Cancel request</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.swaps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.swap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
}
.swap.received {
  border-color: var(--ally);
  background: rgba(76, 141, 255, 0.12);
}
.what,
.outcome {
  margin: 0;
}
.what {
  font-size: 15px;
}
.outcome {
  font-size: 13px;
  color: var(--muted);
}
.buttons {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.buttons .btn {
  flex: 1;
  min-height: 48px;
}
</style>
