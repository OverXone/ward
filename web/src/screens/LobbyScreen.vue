<script setup lang="ts">
import type { LobbyView, RunesView } from "@shared/phone-api";
import { computed, ref } from "vue";
import FriendsSheet from "../components/FriendsSheet.vue";
import RunesButton from "../components/RunesButton.vue";
import { run } from "../store";

const props = defineProps<{ lobby: LobbyView | null; runes: RunesView | null }>();
const busy = ref(false);
const inviting = ref(false);

const blocker = computed(() => {
  if (!props.lobby) return "Loading lobby…";
  if (!props.lobby.isLeader) return "Only the party leader can start the queue.";
  if (!props.lobby.canStartActivity) return "Can't start yet. Pick your roles or check the lobby on your PC.";
  return null;
});

async function startQueue() {
  busy.value = true;
  await run("queue/start");
  busy.value = false;
}
</script>

<template>
  <main class="screen">
    <div class="center">
      <p class="eyebrow">Lobby</p>
      <h1 class="title">{{ lobby?.queueName ?? "Lobby" }}</h1>
      <p class="sub" v-if="lobby">{{ lobby.memberCount }} {{ lobby.memberCount === 1 ? "player" : "players" }} in party</p>
    </div>
    <div class="tools">
      <button v-if="lobby?.canInvite" class="btn btn-ghost invite" @click="inviting = true">Invite friends</button>
      <RunesButton v-if="runes" :runes="runes" />
    </div>
    <div class="actions">
      <p v-if="blocker" class="blocker">{{ blocker }}</p>
      <button class="btn btn-accept btn-huge" :disabled="!!blocker || busy" @click="startQueue">Find match</button>
    </div>
    <FriendsSheet v-if="inviting" @close="inviting = false" />
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
.tools {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.invite {
  flex: 1;
  min-height: 48px;
}
.actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: var(--safe-bottom);
}
.blocker {
  margin: 0;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
}
</style>
