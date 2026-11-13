<script setup lang="ts">
import type { RecommendedRunes, RunePageView, RunesView, RuneStyleOption } from "@shared/phone-api";
import { computed, ref } from "vue";
import * as api from "../api";
import { championName, run } from "../store";
import AssetImage from "./AssetImage.vue";
import BottomSheet from "./BottomSheet.vue";

/** Choose the active rune page, or apply one League recommends for my champion (champ select only). */
const props = defineProps<{ runes: RunesView; championId: number }>();
const emit = defineEmits<{ close: [] }>();

const styles = ref<RuneStyleOption[]>([]);
void api.fetchRuneStyles().then((s) => (styles.value = s), () => {});
const styleName = (id: number) => styles.value.find((s) => s.id === id)?.name ?? "";

const recommended = ref<RecommendedRunes[]>([]);
if (props.championId > 0) {
  void api.fetchRecommendedRunes().then(
    (list) => (recommended.value = list.filter((r) => r.championId === props.championId)),
    () => {},
  );
}

const ROLES: Record<string, string> = { top: "Top", jungle: "Jungle", middle: "Mid", bottom: "Bot", utility: "Support" };

const mine = computed(() => props.runes.pages.filter((p) => p.isEditable));
const presets = computed(() => props.runes.pages.filter((p) => !p.isEditable));
const busy = ref<string | null>(null);

async function choose(page: RunePageView) {
  if (busy.value) return;
  if (page.isCurrent) return emit("close");
  busy.value = page.handle;
  const ok = await run("runes/select", { page: page.handle });
  busy.value = null;
  if (ok) emit("close");
}

async function apply(r: RecommendedRunes) {
  if (busy.value) return;
  busy.value = `rec:${r.index}`;
  const ok = await run("runes/recommended", { championId: r.championId, index: r.index });
  busy.value = null;
  if (ok) emit("close");
}
</script>

<template>
  <BottomSheet title="Runes" @close="emit('close')">
    <template v-if="recommended.length">
      <h3 class="group">Recommended for {{ championName(championId) }}</h3>
      <button v-for="r in recommended" :key="r.index" class="row" :disabled="!!busy" @click="apply(r)">
        <AssetImage kind="perk" :id="r.keystoneId" :width="36" :label="r.keystoneName" class="round" />
        <span class="text">
          <span class="name">{{ r.keystoneName || styleName(r.primaryStyleId) }}</span>
          <span class="meta">{{ [ROLES[r.position], `${styleName(r.primaryStyleId)} + ${styleName(r.subStyleId)}`].filter(Boolean).join(" · ") }}</span>
        </span>
        <span v-if="busy === `rec:${r.index}`" class="state">Saving…</span>
      </button>
      <p class="note">Saved to a page named "Phone: {{ championName(championId) }}". Your own pages aren't changed.</p>
    </template>

    <h3 v-if="mine.length" class="group">Your pages</h3>
    <button v-for="p in mine" :key="p.handle" class="row" :class="{ current: p.isCurrent }" :disabled="!!busy" @click="choose(p)">
      <span class="styles">
        <AssetImage kind="style" :id="p.primaryStyleId" :width="30" :label="styleName(p.primaryStyleId)" class="round" />
        <AssetImage kind="style" :id="p.subStyleId" :width="18" :label="styleName(p.subStyleId)" class="round sub" />
      </span>
      <span class="text">
        <span class="name">{{ p.name }}</span>
        <span v-if="!p.isValid" class="meta warn">Incomplete</span>
        <span v-else-if="styles.length" class="meta">{{ styleName(p.primaryStyleId) }} + {{ styleName(p.subStyleId) }}</span>
      </span>
      <span v-if="p.isCurrent" class="state on" aria-label="Current page">✓</span>
    </button>

    <h3 v-if="presets.length" class="group">League presets</h3>
    <button v-for="p in presets" :key="p.handle" class="row" :class="{ current: p.isCurrent }" :disabled="!!busy" @click="choose(p)">
      <span class="styles">
        <AssetImage kind="style" :id="p.primaryStyleId" :width="30" :label="styleName(p.primaryStyleId)" class="round" />
      </span>
      <span class="text">
        <span class="name">{{ p.name }}</span>
      </span>
      <span v-if="p.isCurrent" class="state on" aria-label="Current page">✓</span>
    </button>

    <p v-if="!runes.pages.length" class="note">League didn't list any rune pages.</p>
  </BottomSheet>
</template>

<style scoped>
.group {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px 12px;
  border-radius: 12px;
  border: 2px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  text-align: left;
  flex: none;
}
.row.current {
  border-color: var(--accept);
  background: rgba(34, 195, 120, 0.12);
}
.row:disabled {
  opacity: 0.7;
}
.styles {
  position: relative;
  width: 38px;
  height: 34px;
  flex: none;
}
.styles .sub {
  position: absolute;
  right: 0;
  bottom: 0;
}
.row .round {
  border-radius: 50%;
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
.meta {
  font-size: 12px;
  color: var(--muted);
}
.meta.warn {
  color: var(--gold);
}
.state {
  font-size: 13px;
  color: var(--muted);
}
.state.on {
  color: var(--accept);
  font-size: 20px;
  font-weight: 800;
}
.note {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
