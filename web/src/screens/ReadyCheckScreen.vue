<script setup lang="ts">
import type { ReadyCheckView } from "@shared/phone-api";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { readyCheckAlert, stopVibration } from "../alerts";
import { run } from "../store";

const props = defineProps<{ readyCheck: ReadyCheckView }>();
const busy = ref(false);

// The client counts the ready check up from 0 to ~12 seconds.
const READY_CHECK_SECONDS = 12;
const progress = computed(() => Math.min(100, (props.readyCheck.timer / READY_CHECK_SECONDS) * 100));
const response = computed(() => props.readyCheck.playerResponse);

onMounted(() => {
  if (response.value === "None") readyCheckAlert();
});
onUnmounted(stopVibration);

async function respond(accept: boolean) {
  busy.value = true;
  stopVibration();
  await run(accept ? "ready-check/accept" : "ready-check/decline");
  busy.value = false;
}
</script>

<template>
  <main class="screen ready">
    <div class="center">
      <p class="eyebrow">Match found</p>
      <h1 class="title big">
        {{ response === "Accepted" ? "Accepted" : response === "Declined" ? "Declined" : "Ready?" }}
      </h1>
      <p class="sub" v-if="response === 'Accepted'">Waiting for the other players…</p>
      <div class="bar" role="progressbar" :aria-valuenow="readyCheck.timer" aria-valuemin="0" :aria-valuemax="READY_CHECK_SECONDS">
        <div class="fill" :style="{ width: progress + '%' }"></div>
      </div>
    </div>
    <div class="actions" v-if="response === 'None'">
      <button class="btn btn-accept btn-huge accept" :disabled="busy" @click="respond(true)">Accept</button>
      <button class="btn btn-danger decline" :disabled="busy" @click="respond(false)">Decline</button>
    </div>
  </main>
</template>

<style scoped>
.eyebrow {
  margin: 0;
  color: var(--gold);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.big {
  font-size: 44px;
}
.bar {
  width: 100%;
  max-width: 320px;
  height: 8px;
  border-radius: 4px;
  background: var(--surface-2);
  overflow: hidden;
  margin-top: 8px;
}
.fill {
  height: 100%;
  background: var(--gold);
  transition: width 1s linear;
}
.actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: var(--safe-bottom);
}
.accept {
  min-height: 140px;
  font-size: 32px;
}
.decline {
  min-height: 64px;
}
</style>
