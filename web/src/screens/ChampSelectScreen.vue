<script setup lang="ts">
import { SWAP_KINDS, type ChampSelectView } from "@shared/phone-api";
import { computed, ref, watch } from "vue";
import { myTurnAlert, swapRequestAlert } from "../alerts";
import BenchPanel from "../components/BenchPanel.vue";
import ChampGrid from "../components/ChampGrid.vue";
import ChampIcon from "../components/ChampIcon.vue";
import LoadoutBar from "../components/LoadoutBar.vue";
import SwapRequests, { type SwapRequest } from "../components/SwapRequests.vue";
import SwapSheet from "../components/SwapSheet.vue";
import TeamColumn from "../components/TeamColumn.vue";
import { app, champSelectSecondsLeft, championName, run } from "../store";

const props = defineProps<{ cs: ChampSelectView }>();

const me = computed(() => props.cs.myTeam.find((p) => p.isMe) ?? null);
const mode = computed<"pick" | "ban">(() => props.cs.myTurn?.type ?? "pick");
const canChoose = computed(() => !!props.cs.myTurn || props.cs.canHoverIntent);

// What the client says is hovered for me right now.
const serverSelected = computed(() =>
  props.cs.myTurn ? props.cs.myTurn.championId : props.cs.canHoverIntent ? (me.value?.pickIntentId ?? 0) : 0,
);
// Optimistic selection between tap and the client confirming it.
const pending = ref(0);
watch(serverSelected, () => (pending.value = 0));
watch(
  () => props.cs.myTurn?.type,
  (type, prev) => {
    pending.value = 0;
    if (type && type !== prev) myTurnAlert();
  },
  { immediate: true },
);
const selected = computed(() => pending.value || serverSelected.value);

const listsKnown = computed(() => props.cs.pickableChampionIds.length > 0 && props.cs.bannableChampionIds.length > 0);
// The client's champion list also contains special-mode copies (e.g. id 60051 "Caitlyn"),
// so only show ids the client lists as pickable or bannable in this champ select.
const playable = computed(() => new Set([...props.cs.pickableChampionIds, ...props.cs.bannableChampionIds]));
const champions = computed(() =>
  [...app.champions.values()]
    .filter((c) => (listsKnown.value ? playable.value.has(c.id) : c.id < 10000))
    .sort((a, b) => a.name.localeCompare(b.name)),
);
// If the list for this turn hasn't arrived, don't grey everything out: the connector re-checks
// every choice against League's live list and answers with a clear error.
const enabled = computed(() => {
  const list = mode.value === "ban" ? props.cs.bannableChampionIds : props.cs.pickableChampionIds;
  return new Set(list.length ? list : champions.value.map((c) => c.id));
});

// League refuses to ban a champion a teammate is hovering or plans to play
// (BAN_LOCK_FAILED_TEAMMATE_HOVERING_CHAMPION on a live client, 2026-11-12).
const teammateWants = computed(() => {
  const ids = new Set<number>();
  for (const p of props.cs.myTeam) {
    if (p.isMe) continue;
    if (p.championId > 0) ids.add(p.championId);
    if (p.pickIntentId > 0) ids.add(p.pickIntentId);
  }
  return ids;
});
// League's pickable list keeps banned champions, so mark them (and locked-in ones) ourselves.
const reasons = computed(() => {
  if (mode.value === "ban") return new Map([...teammateWants.value].map((id) => [id, "Teammate's pick"]));
  const why = new Map<number, string>();
  for (const id of props.cs.lockedChampionIds) why.set(id, "Picked");
  for (const id of [...props.cs.bans.myTeam, ...props.cs.bans.theirTeam]) why.set(id, "Banned");
  return why;
});
// Modes that offer each player only a few champions show just those, as big tiles.
const choices = computed(() => props.cs.choices);
const hasBench = computed(() => props.cs.bench !== null || !!props.cs.rerollsLeft);

// Why the hovered champion can't be locked in (teammate's pick when banning; banned or taken when picking).
const blocked = computed(() => (props.cs.myTurn ? (reasons.value.get(serverSelected.value) ?? null) : null));

// Swap requests (role, pick order, champion trade) in both directions.
const swapRequests = computed<SwapRequest[]>(() =>
  props.cs.myTeam.flatMap((player) =>
    SWAP_KINDS.flatMap((kind) => {
      const state = player.swaps[kind];
      return state === "sent" || state === "received" ? [{ player, kind, state }] : [];
    }),
  ),
);
const receivedKeys = computed(() =>
  swapRequests.value.filter((r) => r.state === "received").map((r) => `${r.kind}:${r.player.cellId}`),
);
watch(receivedKeys, (now, before) => {
  if (now.some((k) => !before?.includes(k))) swapRequestAlert();
});

// Tapping a teammate opens the offers you can send them. Follow the live player data while open.
const sheetCell = ref<number | null>(null);
const sheetPlayer = computed(() => props.cs.myTeam.find((p) => p.cellId === sheetCell.value && !p.isMe) ?? null);

const busy = ref(false);

async function choose(id: number) {
  if (!canChoose.value || busy.value) return;
  pending.value = id;
  const ok = await run("champ-select/hover", { championId: id });
  if (!ok) pending.value = 0;
}

async function lock() {
  busy.value = true;
  await run("champ-select/lock");
  busy.value = false;
}

const canLock = computed(() => !!props.cs.myTurn && serverSelected.value > 0 && !busy.value && !blocked.value);

const headline = computed(() => {
  const cs = props.cs;
  if (cs.myTurn) return cs.myTurn.type === "ban" ? "Your turn to ban" : "Your turn to pick";
  if (choices.value.length && !cs.hasLockedPick) return "Choose your champion";
  if (hasBench.value && cs.phase !== "GAME_STARTING") {
    return me.value?.championId ? `You're playing ${championName(me.value.championId)}` : "Champion select";
  }
  switch (cs.phase) {
    case "PLANNING":
      return "Planning: pick what you'll play";
    case "FINALIZATION":
      return "Finalizing";
    case "GAME_STARTING":
      return "Game starting";
  }
  const allyActive = cs.myTeam.filter((p) => p.activeAction);
  const enemyActive = cs.theirTeam.filter((p) => p.activeAction);
  const action = (allyActive[0] ?? enemyActive[0])?.activeAction;
  const verb = action === "ban" ? "banning" : "picking";
  if (allyActive.length && enemyActive.length) return `Everyone is ${verb}`;
  if (allyActive.length === 1) return `${allyActive[0]!.name} is ${verb}`;
  if (allyActive.length) return `Your team is ${verb}`;
  if (enemyActive.length) return `Enemy team is ${verb}`;
  return "Champion select";
});

const subline = computed(() => {
  const cs = props.cs;
  if (cs.myTurn) return cs.myTurn.type === "ban" ? "Tap a champion, then confirm the ban." : "Tap a champion, then lock in.";
  if (choices.value.length && !cs.hasLockedPick && !canChoose.value) return "League offers you these. Choose on your PC.";
  if (hasBench.value && cs.phase !== "GAME_STARTING") {
    if (cs.bench?.length) return cs.rerollsLeft ? "Swap with the bench or reroll below." : "Tap a bench champion below to swap.";
    if (cs.rerollsLeft) return "Reroll below for a different champion.";
  }
  if (cs.canHoverIntent && cs.phase === "PLANNING") return "Bans start when the timer ends. This only shows your team your plan.";
  if (cs.canHoverIntent) return "Tap to show your team what you'll play.";
  if (cs.phase === "FINALIZATION") return cs.hasLockedPick ? "Set your spells and skin below; runes on your PC." : "";
  if (cs.hasLockedPick) return "You're locked in. Set your spells and skin below.";
  return "";
});

const tone = computed(() => (props.cs.myTurn ? props.cs.myTurn.type : "idle"));
const seconds = computed(() => champSelectSecondsLeft());
</script>

<template>
  <main class="screen cs">
    <header class="head" :class="tone">
      <div class="head-text">
        <h1 class="headline">{{ headline }}</h1>
        <p v-if="subline" class="subline">{{ subline }}</p>
      </div>
      <div v-if="!cs.isInfinite" class="clock mono" :class="{ low: seconds <= 5 }">{{ seconds }}</div>
    </header>

    <div class="bans" v-if="cs.bans.myTeam.length || cs.bans.theirTeam.length">
      <div class="ban-row">
        <ChampIcon v-for="(id, i) in cs.bans.myTeam" :key="'a' + i" :id="id" :size="28" banned />
      </div>
      <span class="ban-label">Bans</span>
      <div class="ban-row right">
        <ChampIcon v-for="(id, i) in cs.bans.theirTeam" :key="'e' + i" :id="id" :size="28" banned />
      </div>
    </div>

    <SwapRequests v-if="swapRequests.length" :requests="swapRequests" :me="me" />

    <section class="teams">
      <TeamColumn :players="cs.myTeam" side="ally" @select="(p) => (sheetCell = p.cellId)" />
      <TeamColumn :players="cs.theirTeam" side="enemy" />
    </section>

    <LoadoutBar
      v-if="me"
      :spells="cs.mySpells"
      :skin-id="cs.mySkinId"
      :champion-id="me.championId"
      :can-pick-skin="cs.hasLockedPick"
    />

    <SwapSheet v-if="sheetPlayer" :player="sheetPlayer" :me="me" @close="sheetCell = null" />

    <BenchPanel v-if="hasBench" :bench="cs.bench" :rerolls-left="cs.rerollsLeft" />

    <section v-if="choices.length && !cs.hasLockedPick" class="choices">
      <button
        v-for="id in choices"
        :key="id"
        class="choice"
        :class="{ on: selected === id }"
        :disabled="!canChoose"
        @click="choose(id)"
      >
        <ChampIcon :id="id" :size="88" />
        <span class="choice-name">{{ championName(id) }}</span>
      </button>
    </section>

    <ChampGrid
      v-else-if="canChoose"
      :key="cs.myTurn?.type ?? 'intent'"
      :champions="champions"
      :enabled="enabled"
      :selected="selected"
      :mode="mode"
      :reasons="reasons"
      @choose="choose"
    />

    <div v-if="cs.myTurn" class="action-bar">
      <ChampIcon :id="serverSelected" :size="52" />
      <button class="btn btn-huge lock" :class="cs.myTurn.type === 'ban' ? 'btn-danger' : 'btn-accept'" :disabled="!canLock" @click="lock">
        <template v-if="busy">{{ cs.myTurn.type === "ban" ? "Banning" : "Locking in" }} {{ championName(serverSelected) }}…</template>
        <template v-else-if="!serverSelected">{{ cs.myTurn.type === "ban" ? "Choose a ban" : "Choose a champion" }}</template>
        <template v-else-if="blocked === 'Banned'">{{ championName(serverSelected) }} is banned</template>
        <template v-else-if="blocked === 'Picked'">{{ championName(serverSelected) }} is taken</template>
        <template v-else-if="blocked">A teammate wants {{ championName(serverSelected) }}</template>
        <template v-else>{{ cs.myTurn.type === "ban" ? "Ban" : "Lock in" }} {{ championName(serverSelected) }}</template>
      </button>
    </div>
  </main>
</template>

<style scoped>
.cs {
  gap: 12px;
  padding-bottom: calc(16px + var(--safe-bottom));
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
}
.head.pick {
  background: rgba(34, 195, 120, 0.14);
  border-color: var(--accept);
}
.head.ban {
  background: rgba(229, 72, 77, 0.14);
  border-color: var(--danger);
}
.head-text {
  flex: 1;
  min-width: 0;
}
.headline {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
}
.subline {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 13px;
}
.clock {
  font-size: 30px;
  font-weight: 800;
  min-width: 48px;
  text-align: right;
}
.clock.low {
  color: var(--danger);
}
.bans {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ban-row {
  flex: 1;
  display: flex;
  gap: 4px;
}
.ban-row.right {
  justify-content: flex-end;
}
.ban-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.choices {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
}
.choice {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px;
  min-width: 112px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 2px solid var(--border);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.choice.on {
  border-color: var(--accept);
  background: rgba(34, 195, 120, 0.14);
}
.choice:disabled {
  cursor: default;
  opacity: 0.8;
}
.choice-name {
  font-size: 15px;
  font-weight: 700;
}
.teams {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.action-bar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0 var(--safe-bottom);
  margin-top: auto;
  background: linear-gradient(to top, var(--bg) 75%, transparent);
}
.lock {
  flex: 1;
  min-height: 64px;
  font-size: 20px;
}
</style>
