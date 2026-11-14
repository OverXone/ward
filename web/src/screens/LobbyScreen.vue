<script setup lang="ts">
import type { LobbyView } from "@shared/phone-api";
import { computed, ref } from "vue";
import ChatButton from "../components/ChatButton.vue";
import FriendsSheet from "../components/FriendsSheet.vue";
import ModeSheet from "../components/ModeSheet.vue";
import RolePicker from "../components/RolePicker.vue";
import { run } from "../store";

const props = defineProps<{ lobby: LobbyView | null }>();
const busy = ref(false);
const inviting = ref(false);
const choosingMode = ref(false);

const rolesMissing = computed(() => {
  const l = props.lobby;
  if (!l?.showRoles) return false;
  const [first, second] = l.roles;
  return first === "UNSELECTED" || (first !== "FILL" && second === "UNSELECTED");
});

const blocker = computed(() => {
  if (!props.lobby) return "Loading lobby…";
  if (!props.lobby.isLeader) return rolesMissing.value ? "Pick your two roles. The party leader starts the queue." : "Only the party leader can start the queue.";
  if (props.lobby.canStartActivity) return null;
  if (rolesMissing.value) return "Pick your two roles first.";
  if (props.lobby.needsSlots) return "This mode needs your champion picks. Set them on your PC.";
  return "Can't start yet. Check the lobby on your PC.";
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
      <button v-if="lobby?.canChangeMode" class="mode" aria-label="Change game mode" @click="choosingMode = true">
        <span class="title">{{ lobby.queueName ?? "Lobby" }}</span>
        <span class="change">Change mode</span>
      </button>
      <h1 v-else class="title">{{ lobby?.queueName ?? "Lobby" }}</h1>
      <p class="sub" v-if="lobby">{{ lobby.memberCount }} {{ lobby.memberCount === 1 ? "player" : "players" }} in party</p>
    </div>
    <RolePicker v-if="lobby?.showRoles" :roles="lobby.roles" />
    <ChatButton />
    <div class="tools">
      <button v-if="lobby?.canInvite" class="btn btn-ghost invite" @click="inviting = true">Invite friends</button>
    </div>
    <div class="actions">
      <p v-if="blocker" class="blocker">{{ blocker }}</p>
      <button class="btn btn-accept btn-huge" :disabled="!!blocker || busy" @click="startQueue">Find match</button>
    </div>
    <FriendsSheet v-if="inviting" @close="inviting = false" />
    <ModeSheet v-if="choosingMode" :current-id="lobby?.queueId ?? null" :party-size="lobby?.memberCount ?? 1" @close="choosingMode = false" />
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
.mode {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  max-width: 100%;
}
.mode .title {
  overflow-wrap: anywhere;
}
.change {
  font-size: 13px;
  font-weight: 600;
  color: var(--gold);
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
