<script setup lang="ts">
import type { ChampSelectView } from "@shared/phone-api";
import { computed, ref, watch } from "vue";
import { myTurnAlert } from "../alerts";
import ChampGrid from "../components/ChampGrid.vue";
import ChampIcon from "../components/ChampIcon.vue";
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

const canLock = computed(() => !!props.cs.myTurn && serverSelected.value > 0 && !busy.value);

const headline = computed(() => {
  const cs = props.cs;
  if (cs.myTurn) return cs.myTurn.type === "ban" ? "Your turn to ban" : "Your turn to pick";
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
  if (cs.canHoverIntent && cs.phase === "PLANNING") return "Bans start when the timer ends. This only shows your team your plan.";
  if (cs.canHoverIntent) return "Tap to show your team what you'll play.";
  if (cs.phase === "FINALIZATION") return cs.hasLockedPick ? "Pick runes, spells and skin on your PC." : "";
  if (cs.hasLockedPick) return "You're locked in.";
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

    <section class="teams">
      <TeamColumn :players="cs.myTeam" side="ally" />
      <TeamColumn :players="cs.theirTeam" side="enemy" />
    </section>

    <ChampGrid
      v-if="canChoose"
      :key="cs.myTurn?.type ?? 'intent'"
      :champions="champions"
      :enabled="enabled"
      :selected="selected"
      :mode="mode"
      @choose="choose"
    />

    <div v-if="cs.myTurn" class="action-bar">
      <ChampIcon :id="serverSelected" :size="52" />
      <button class="btn btn-huge lock" :class="cs.myTurn.type === 'ban' ? 'btn-danger' : 'btn-accept'" :disabled="!canLock" @click="lock">
        <template v-if="!serverSelected">{{ cs.myTurn.type === "ban" ? "Choose a ban" : "Choose a champion" }}</template>
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
