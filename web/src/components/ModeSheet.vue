<script setup lang="ts">
import type { QueueOption } from "@shared/phone-api";
import { computed, ref } from "vue";
import * as api from "../api";
import { run } from "../store";
import BottomSheet from "./BottomSheet.vue";

/**
 * The game modes League offers right now, grouped like the PC's play menu. Tapping one switches the
 * lobby to it, or opens a lobby when there's none. Modes League won't allow are greyed with the reason.
 */
const props = defineProps<{ currentId: number | null; partySize: number }>();
const emit = defineEmits<{ close: [] }>();

const queues = ref<QueueOption[] | null>(null);
const error = ref<string | null>(null);
const busy = ref<number | null>(null);

void (async () => {
  try {
    queues.value = await api.fetchQueues();
  } catch (e) {
    error.value = (e as Error).message;
  }
})();

const groups = computed(() => {
  const out: { name: string; queues: QueueOption[] }[] = [];
  for (const q of queues.value ?? []) {
    const g = out.find((x) => x.name === q.group) ?? out[out.push({ name: q.group, queues: [] }) - 1]!;
    g.queues.push(q);
  }
  return out;
});

async function choose(q: QueueOption) {
  if (busy.value || !q.canPick) return;
  if (q.id === props.currentId) return emit("close");
  if (props.partySize > 1 && !window.confirm(`Switch your party to ${q.name}?`)) return;
  busy.value = q.id;
  const ok = await run("lobby/mode", { queueId: q.id });
  busy.value = null;
  if (ok) emit("close");
}
</script>

<template>
  <BottomSheet :title="currentId ? 'Change game mode' : 'Choose a game mode'" doneLabel="Cancel" @close="emit('close')">
    <p v-if="error" class="note">{{ error }}</p>
    <p v-else-if="!queues" class="note">Loading game modes…</p>
    <p v-else-if="!queues.length" class="note">League isn't offering any game modes right now.</p>
    <section v-for="g in groups" :key="g.name" class="group">
      <h3 class="group-name">{{ g.name }}</h3>
      <button
        v-for="q in g.queues"
        :key="q.id"
        class="mode"
        :class="{ current: q.id === currentId }"
        :disabled="!q.canPick || busy !== null"
        :aria-current="q.id === currentId ? 'true' : undefined"
        @click="choose(q)"
      >
        <span class="name">{{ q.name }}</span>
        <span v-if="q.id === currentId" class="tag">Current</span>
        <span v-else-if="busy === q.id" class="tag">Switching…</span>
        <span v-else-if="q.reason" class="reason">{{ q.reason }}</span>
      </button>
    </section>
  </BottomSheet>
</template>

<style scoped>
.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
}
.group-name {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.mode {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 8px 14px;
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid transparent;
  text-align: left;
}
.mode.current {
  border-color: var(--gold);
}
.mode:disabled:not(.current) {
  opacity: 0.45;
}
.name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}
.tag {
  font-size: 12px;
  font-weight: 700;
  color: var(--gold);
}
.reason {
  flex: none;
  max-width: 50%;
  font-size: 12px;
  color: var(--muted);
  text-align: right;
}
.note {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
}
</style>
