<script setup lang="ts">
import type { FriendOption } from "@shared/phone-api";
import { onBeforeUnmount, ref } from "vue";
import * as api from "../api";
import { run } from "../store";
import BottomSheet from "./BottomSheet.vue";

/** Online League friends, each with an Invite button. Refreshes while open so "Invited" / "In your lobby" stay current. */
const emit = defineEmits<{ close: [] }>();

const friends = ref<FriendOption[] | null>(null);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);

async function load() {
  try {
    friends.value = await api.fetchFriends();
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
void load();
const timer = window.setInterval(() => void load(), 4000);
onBeforeUnmount(() => clearInterval(timer));

async function invite(f: FriendOption) {
  if (busy.value) return;
  busy.value = f.handle;
  await run("lobby/invite", { friend: f.handle });
  await load();
  busy.value = null;
}
</script>

<template>
  <BottomSheet title="Invite friends" @close="emit('close')">
    <p v-if="error" class="note">{{ error }}</p>
    <p v-else-if="!friends" class="note">Loading your friends…</p>
    <p v-else-if="!friends.length" class="note">None of your friends are online in League right now.</p>
    <div v-for="f in friends ?? []" :key="f.handle" class="friend">
      <span class="text">
        <span class="name">{{ f.name }}</span>
        <span class="status" :class="{ busy: f.status !== 'Online' }">{{ f.status }}</span>
      </span>
      <button v-if="f.canInvite" class="btn btn-accept invite" :disabled="!!busy" @click="invite(f)">
        {{ busy === f.handle ? "Inviting…" : "Invite" }}
      </button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.friend {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 6px 4px 6px 12px;
  border-radius: 12px;
  background: var(--surface-2);
  flex: none;
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status {
  font-size: 12px;
  color: var(--accept);
}
.status.busy {
  color: var(--muted);
}
.invite {
  min-height: 44px;
  padding: 0 18px;
}
.note {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
}
</style>
