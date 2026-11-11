<script setup lang="ts">
import type { ChampSelectPlayer } from "@shared/phone-api";
import ChampIcon from "./ChampIcon.vue";

defineProps<{ players: ChampSelectPlayer[]; side: "ally" | "enemy" }>();

const POSITIONS: Record<string, string> = {
  top: "Top",
  jungle: "Jungle",
  middle: "Mid",
  bottom: "Bot",
  utility: "Support",
};
</script>

<template>
  <ul class="team" :class="side">
    <li
      v-for="p in players"
      :key="p.cellId"
      class="player"
      :class="{ me: p.isMe, active: !!p.activeAction, banning: p.activeAction === 'ban' }"
    >
      <ChampIcon :id="p.championId || p.pickIntentId" :size="40" :faded="!p.championId && !!p.pickIntentId" />
      <div class="info">
        <span class="name">{{ p.name }}</span>
        <span class="meta">
          <template v-if="p.activeAction">{{ p.activeAction === "ban" ? "Banning…" : "Picking…" }}</template>
          <template v-else>{{ POSITIONS[p.position] ?? "" }}</template>
        </span>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.team {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.player {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid transparent;
  min-width: 0;
}
.enemy .player {
  flex-direction: row-reverse;
  text-align: right;
}
.info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  font-size: 12px;
  color: var(--muted);
}
.me {
  border-color: var(--gold);
  background: rgba(214, 180, 106, 0.08);
}
.active {
  background: var(--surface-2);
}
.ally .active {
  border-color: var(--ally);
}
.enemy .active {
  border-color: var(--enemy);
}
.active .meta {
  color: var(--text);
  font-weight: 600;
}
.banning .meta {
  color: var(--danger);
}
</style>
