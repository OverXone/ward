<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { app, unreadChat } from "../store";
import ChatSheet from "./ChatSheet.vue";

/**
 * Opens the chat. Full size shows the latest message; compact (champ select header) is just an
 * icon. Both show how many messages from others are unread. Hidden when there's no chat.
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const chat = computed(() => app.state?.chat ?? null);
const unread = computed(() => unreadChat());
const last = computed(() => chat.value?.messages.filter((m) => m.kind === "message").at(-1) ?? null);
const open = ref(false);
watch(open, (v) => (app.chatOpen = v));
watch(chat, (c) => {
  if (!c) open.value = false;
});
onBeforeUnmount(() => (app.chatOpen = false));

const label = computed(() => (unread.value ? `Chat, ${unread.value} unread` : "Chat"));
</script>

<template>
  <template v-if="chat">
    <button class="chat-btn" :class="{ compact }" type="button" :aria-label="label" @click="open = true">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.4c-.5.4-1.3 0-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linejoin="round"
        />
      </svg>
      <span v-if="!compact" class="text">
        <span class="name">{{ chat.kind === "champSelect" ? "Team chat" : "Lobby chat" }}</span>
        <span class="preview">
          <template v-if="last">{{ last.from }}: {{ last.text }}</template>
          <template v-else>No messages yet</template>
        </span>
      </span>
      <span v-if="unread" class="badge">{{ unread > 9 ? "9+" : unread }}</span>
    </button>
    <ChatSheet v-if="open" @close="open = false" />
  </template>
</template>

<style scoped>
.chat-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 56px;
  padding: 8px 14px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  text-align: left;
}
.chat-btn:active {
  background: var(--surface-2);
}
.chat-btn.compact {
  width: 48px;
  min-height: 48px;
  padding: 0;
  justify-content: center;
  flex: none;
}
.icon {
  width: 24px;
  height: 24px;
  flex: none;
  color: var(--gold);
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.name {
  font-weight: 700;
}
.preview {
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 11px;
  background: var(--danger);
  color: #fff;
  font-size: 12px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.compact .badge {
  position: absolute;
  top: -6px;
  right: -6px;
}
</style>
