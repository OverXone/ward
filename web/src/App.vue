<script setup lang="ts">
import { computed } from "vue";
import ChampSelectScreen from "./screens/ChampSelectScreen.vue";
import LobbyScreen from "./screens/LobbyScreen.vue";
import PairScreen from "./screens/PairScreen.vue";
import QueueScreen from "./screens/QueueScreen.vue";
import ReadyCheckScreen from "./screens/ReadyCheckScreen.vue";
import StatusScreen from "./screens/StatusScreen.vue";
import { app } from "./store";

type View =
  | { kind: "pair" }
  | { kind: "status"; title: string; sub?: string; spinner?: boolean; emoji?: string }
  | { kind: "lobby" }
  | { kind: "queue" }
  | { kind: "ready" }
  | { kind: "champ" };

const view = computed<View>(() => {
  if (!app.paired) return { kind: "pair" };
  const s = app.state;
  if (!s) return { kind: "status", title: "Connecting to your PC…", sub: "Make sure Ward is running and you're on the same Wi-Fi.", spinner: true };
  if (s.lcu !== "connected")
    return { kind: "status", title: "Waiting for League", sub: "Start the League of Legends client on your PC.", spinner: true };
  if (s.readyCheck?.state === "InProgress") return { kind: "ready" };
  switch (s.phase) {
    case "ChampSelect":
      return s.champSelect ? { kind: "champ" } : { kind: "status", title: "Champion select", spinner: true };
    case "Lobby":
      return { kind: "lobby" };
    case "Matchmaking":
      return { kind: "queue" };
    case "ReadyCheck":
      return { kind: "status", title: "Match found", spinner: true };
    case "GameStart":
    case "InProgress":
    case "Reconnect":
      return { kind: "status", title: "Game in progress", sub: "Good luck, have fun!", emoji: "⚔️" };
    case "WaitingForStats":
    case "PreEndOfGame":
    case "EndOfGame":
      return { kind: "status", title: "Game over", sub: "Head back to the lobby on your PC to play again.", emoji: "🏁" };
    case null:
      return { kind: "status", title: "League is starting…", spinner: true };
    case "None":
      return { kind: "status", title: "Not in a lobby", sub: "Open a lobby on your PC, then control the queue from here.", emoji: "🎮" };
    default:
      return { kind: "status", title: String(s.phase), emoji: "⏳" };
  }
});

const reconnecting = computed(() => app.paired && app.state && app.socket !== "open");
</script>

<template>
  <div v-if="reconnecting" class="banner" role="status">Reconnecting to your PC…</div>
  <PairScreen v-if="view.kind === 'pair'" />
  <StatusScreen v-else-if="view.kind === 'status'" :title="view.title" :sub="view.sub" :spinner="view.spinner" :emoji="view.emoji" />
  <LobbyScreen v-else-if="view.kind === 'lobby'" :lobby="app.state!.lobby" />
  <QueueScreen v-else-if="view.kind === 'queue'" :queue="app.state!.queue" :queue-name="app.state!.lobby?.queueName ?? null" />
  <ReadyCheckScreen v-else-if="view.kind === 'ready'" :ready-check="app.state!.readyCheck!" />
  <ChampSelectScreen v-else-if="view.kind === 'champ'" :cs="app.state!.champSelect!" />
  <Transition name="toast">
    <div v-if="app.toast" class="toast" :class="app.toast.kind" role="alert">{{ app.toast.text }}</div>
  </Transition>
</template>

<style>
.banner {
  position: sticky;
  top: 0;
  z-index: 10;
  padding: calc(6px + var(--safe-top)) 12px 6px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  background: #3a2f12;
  color: var(--gold);
}
.toast {
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: calc(96px + var(--safe-bottom));
  z-index: 20;
  margin: 0 auto;
  max-width: 520px;
  padding: 12px 14px;
  border-radius: 12px;
  font-size: 15px;
  background: #3b1416;
  border: 1px solid var(--danger);
}
.toast.info {
  background: var(--surface-2);
  border-color: var(--border);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
