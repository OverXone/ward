<script setup lang="ts">
import type { ChampSelectPlayer } from "@shared/phone-api";
import { POSITION_NAMES } from "../swaps";
import ChampIcon from "./ChampIcon.vue";

defineProps<{ players: ChampSelectPlayer[]; side: "ally" | "enemy" }>();
const emit = defineEmits<{ select: [player: ChampSelectPlayer] }>();

/** A teammate I can offer a swap to: tapping them opens the swap sheet. */
const canOffer = (p: ChampSelectPlayer) => Object.values(p.swaps).includes("available");
</script>

<template>
  <ul class="team" :class="side">
    <li v-for="p in players" :key="p.cellId">
      <component
        :is="canOffer(p) ? 'button' : 'div'"
        class="player"
        :class="{ me: p.isMe, active: !!p.activeAction, banning: p.activeAction === 'ban', swappable: canOffer(p) }"
        :aria-label="canOffer(p) ? `Swap with ${p.name}` : undefined"
        @click="canOffer(p) && emit('select', p)"
      >
        <ChampIcon :id="p.championId || p.pickIntentId" :size="40" :faded="!p.championId && !!p.pickIntentId" />
        <div class="info">
          <span class="name">{{ p.name }}</span>
          <span class="meta">
            <template v-if="POSITION_NAMES[p.position]">{{ POSITION_NAMES[p.position] }}</template>
            <template v-if="p.activeAction">
              <template v-if="POSITION_NAMES[p.position]"> · </template>
              <span class="doing">{{ p.activeAction === "ban" ? "Banning…" : "Picking…" }}</span>
            </template>
          </span>
        </div>
        <span v-if="canOffer(p)" class="swap-badge" aria-hidden="true">⇄</span>
      </component>
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
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid transparent;
  min-width: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
button.player {
  cursor: pointer;
}
.enemy .player {
  flex-direction: row-reverse;
  text-align: right;
}
.info {
  flex: 1;
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
.swap-badge {
  flex: none;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 14px;
  color: var(--ally);
  background: rgba(76, 141, 255, 0.14);
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
.active .doing {
  color: var(--text);
  font-weight: 600;
}
.banning .doing {
  color: var(--danger);
}
</style>
