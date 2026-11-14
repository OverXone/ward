<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { app, markChatSeen, run } from "../store";
import BottomSheet from "./BottomSheet.vue";
import ChampIcon from "./ChampIcon.vue";

/** The lobby's or champ select's chat: messages (newest at the bottom) and a box to write. */
const emit = defineEmits<{ close: [] }>();

const MAX = 200; // the connector's limit (MAX_CHAT_TEXT)
const chat = computed(() => app.state?.chat ?? null);
const title = computed(() => (chat.value?.kind === "champSelect" ? "Team chat" : "Lobby chat"));
const text = ref("");
const sending = ref(false);
const list = ref<HTMLElement | null>(null);
const left = computed(() => MAX - [...text.value.trim()].length);
const canSend = computed(() => !!chat.value?.ready && !sending.value && text.value.trim() !== "" && left.value >= 0);

// Everything shown while the sheet is open counts as read; keep the newest message in view.
watch(
  () => chat.value?.messages.at(-1)?.id,
  () => {
    markChatSeen();
    void nextTick(() => {
      if (list.value) list.value.scrollTop = list.value.scrollHeight;
    });
  },
  { immediate: true },
);

async function send() {
  if (!canSend.value) return;
  sending.value = true;
  if (await run("chat/send", { text: text.value.trim() })) text.value = "";
  sending.value = false;
}

const time = (ms: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
</script>

<template>
  <BottomSheet :title="title" done-label="Close" @close="emit('close')">
    <div ref="list" class="messages" aria-live="polite">
      <p v-if="!chat" class="note">This chat has closed.</p>
      <p v-else-if="!chat.messages.length" class="note">{{ chat.ready ? "No messages yet." : "Joining the chat…" }}</p>
      <template v-for="m in chat?.messages ?? []" :key="m.id">
        <p v-if="m.kind !== 'message'" class="event">{{ m.from }} {{ m.kind === "joined" ? "joined the lobby" : "left the lobby" }}</p>
        <div v-else class="msg" :class="{ mine: m.isMe }">
          <ChampIcon v-if="m.championId" :id="m.championId" :size="28" class="who" />
          <div class="bubble">
            <span v-if="!m.isMe" class="from">{{ m.from }}</span>
            <span class="text">{{ m.text }}</span>
            <span v-if="m.time" class="time">{{ time(m.time) }}</span>
          </div>
        </div>
      </template>
    </div>
    <form class="compose" @submit.prevent="send">
      <input
        v-model="text"
        type="text"
        enterkeyhint="send"
        autocomplete="off"
        autocapitalize="sentences"
        placeholder="Write a message"
        aria-label="Message"
        :disabled="!chat?.ready"
      />
      <button class="btn btn-accept send" type="submit" :disabled="!canSend">{{ sending ? "…" : "Send" }}</button>
    </form>
    <p v-if="left < 30" class="count" :class="{ over: left < 0 }">{{ left < 0 ? `${-left} characters too long` : `${left} characters left` }}</p>
  </BottomSheet>
</template>

<style scoped>
.messages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 120px;
  max-height: 50vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 2px;
}
.note,
.event {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.note {
  margin: auto 0;
  font-size: 14px;
}
.msg {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  max-width: 88%;
}
.msg.mine {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.who {
  flex: none;
}
.bubble {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 7px 11px;
  border-radius: 14px 14px 14px 4px;
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.mine .bubble {
  border-radius: 14px 14px 4px 14px;
  background: rgba(76, 141, 255, 0.18);
  border-color: rgba(76, 141, 255, 0.45);
}
.from {
  font-size: 12px;
  font-weight: 700;
  color: var(--gold);
}
.text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.time {
  align-self: flex-end;
  font-size: 11px;
  color: var(--muted);
}
.compose {
  display: flex;
  gap: 8px;
  flex: none;
}
.compose input {
  flex: 1;
  min-width: 0;
  min-height: 48px;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 16px; /* 16px stops iOS zooming in on focus */
}
.compose input:disabled {
  opacity: 0.5;
}
.send {
  width: auto;
  flex: none;
  min-height: 48px;
  padding: 0 18px;
  font-size: 16px;
}
.count {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--muted);
  text-align: right;
}
.count.over {
  color: var(--danger);
}
</style>
