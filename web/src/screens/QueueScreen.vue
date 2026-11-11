<script setup lang="ts">
import type { QueueView } from "@shared/phone-api";
import { computed, ref } from "vue";
import { queueSeconds, run } from "../store";

const props = defineProps<{ queue: QueueView | null; queueName: string | null }>();
const busy = ref(false);

const fmt = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
const elapsed = computed(() => fmt(queueSeconds()));
const estimate = computed(() => (props.queue?.estimatedQueueTime ? fmt(props.queue.estimatedQueueTime) : null));

async function cancel() {
  busy.value = true;
  await run("queue/cancel");
  busy.value = false;
}
</script>

<template>
  <main class="screen">
    <div class="center">
      <div class="pulse" aria-hidden="true"></div>
      <p class="eyebrow">In queue{{ queueName ? ` · ${queueName}` : "" }}</p>
      <div class="timer mono" aria-live="off">{{ elapsed }}</div>
      <p class="sub" v-if="estimate">Estimated {{ estimate }}</p>
      <p class="penalty" v-if="queue && queue.penaltySeconds > 0">
        Queue delay: {{ fmt(queue.penaltySeconds) }} remaining
      </p>
      <p class="penalty" v-for="err in queue?.errors ?? []" :key="err">{{ err }}</p>
      <p class="sub small">Keep this open. Your phone will buzz when a match is found.</p>
    </div>
    <div class="actions">
      <button class="btn btn-ghost" :disabled="busy" @click="cancel">Cancel queue</button>
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
  font-size: 13px;
}
.timer {
  font-size: 72px;
  font-weight: 800;
  line-height: 1;
}
.pulse {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--gold);
  animation: pulse 1.6s ease-out infinite;
}
@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(214, 180, 106, 0.6);
  }
  100% {
    box-shadow: 0 0 0 28px rgba(214, 180, 106, 0);
  }
}
.penalty {
  margin: 0;
  color: var(--danger);
  font-weight: 600;
}
.small {
  font-size: 13px;
}
.actions {
  padding-bottom: var(--safe-bottom);
}
</style>
