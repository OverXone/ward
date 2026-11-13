<script setup lang="ts">
import type { RunesView, SkinOption, SpellOption } from "@shared/phone-api";
import { computed, ref, watch } from "vue";
import * as api from "../api";
import { run, showToast } from "../store";
import AssetImage from "./AssetImage.vue";
import RunesButton from "./RunesButton.vue";

/** My summoner spells and rune page (always) and skin (once I've locked in), each opening a picker. */
const props = defineProps<{
  spells: [number, number];
  skinId: number;
  championId: number;
  /** Champion I've locked or hovered: League's rune recommendations are for this one. */
  runesChampionId: number;
  canPickSkin: boolean;
  runes: RunesView | null;
}>();

// The spell list rarely changes within a champ select: load once, keep names for the labels.
const spellList = ref<SpellOption[] | null>(null);
const spellName = (id: number) => spellList.value?.find((s) => s.id === id)?.name ?? "";
async function loadSpells(): Promise<boolean> {
  if (spellList.value) return true;
  try {
    spellList.value = await api.fetchSpells();
    return true;
  } catch (e) {
    showToast((e as Error).message);
    return false;
  }
}
void loadSpells();

// Skins depend on the champion: reload whenever it changes.
const skins = ref<SkinOption[] | null>(null);
watch(
  () => [props.championId, props.canPickSkin] as const,
  async ([champ, can]) => {
    skins.value = null;
    if (!can || !(champ > 0)) return;
    try {
      const list = await api.fetchSkins();
      if (champ === props.championId) skins.value = list;
    } catch {
      // shown as "no skins" until the next change
    }
  },
  { immediate: true },
);
const allSkins = computed(() => (skins.value ?? []).flatMap((s) => [{ id: s.id, name: s.name }, ...s.chromas.map((c) => ({ id: c.id, name: `${s.name} (${c.name})` }))]));
const skinName = computed(() => allSkins.value.find((s) => s.id === props.skinId)?.name ?? (props.skinId ? "Skin" : "Default"));
/** The skin whose chromas are shown: the selected skin, or the parent of the selected chroma. */
const parentSkin = computed(() => skins.value?.find((s) => s.id === props.skinId || s.chromas.some((c) => c.id === props.skinId)) ?? null);

const sheet = ref<null | { kind: "spell"; slot: 0 | 1 } | { kind: "skin" }>(null);
const busy = ref(false);

async function openSpell(slot: 0 | 1) {
  if (await loadSpells()) sheet.value = { kind: "spell", slot };
}

async function chooseSpell(id: number) {
  if (sheet.value?.kind !== "spell" || busy.value) return;
  const slot = sheet.value.slot;
  const next: [number, number] = [...props.spells];
  // Choosing the spell that's already in the other slot swaps them, like League does.
  if (next[1 - slot] === id) next[1 - slot] = next[slot];
  next[slot] = id;
  busy.value = true;
  const ok = await run("champ-select/spells", { spell1Id: next[0], spell2Id: next[1] });
  busy.value = false;
  if (ok) sheet.value = null;
}

async function chooseSkin(id: number) {
  if (busy.value) return;
  busy.value = true;
  const ok = await run("champ-select/skin", { skinId: id });
  busy.value = false;
  if (ok && !skins.value?.find((s) => s.id === id)?.chromas.length) sheet.value = null;
}
</script>

<template>
  <section class="loadout" aria-label="Your spells, runes and skin">
    <button v-for="slot in [0, 1] as const" :key="slot" class="spell" :aria-label="`Spell ${slot === 0 ? 'D' : 'F'}: ${spellName(spells[slot]) || 'none'}`" @click="openSpell(slot)">
      <AssetImage kind="spell" :id="spells[slot]" :width="40" :label="spellName(spells[slot]) || '?'" />
      <span class="key">{{ slot === 0 ? "D" : "F" }}</span>
    </button>
    <RunesButton v-if="runes" :runes="runes" :champion-id="runesChampionId" />
    <button v-if="canPickSkin && skins?.length" class="skin" @click="sheet = { kind: 'skin' }">
      <span class="skin-label">Skin</span>
      <span class="skin-name">{{ skinName }}</span>
    </button>
  </section>

  <div v-if="sheet" class="backdrop" @click.self="sheet = null">
    <section class="sheet" role="dialog" aria-modal="true">
      <template v-if="sheet.kind === 'spell'">
        <h2 class="title">Spell {{ sheet.slot === 0 ? "D" : "F" }}</h2>
        <div class="spell-grid">
          <button
            v-for="s in spellList ?? []"
            :key="s.id"
            class="spell-option"
            :class="{ current: s.id === spells[sheet.slot], other: s.id === spells[1 - sheet.slot] }"
            :disabled="busy"
            @click="chooseSpell(s.id)"
          >
            <AssetImage kind="spell" :id="s.id" :width="48" :label="s.name" />
            <span class="opt-name">{{ s.name }}</span>
          </button>
        </div>
      </template>
      <template v-else>
        <h2 class="title">Skin</h2>
        <div class="skin-grid">
          <button
            v-for="s in skins ?? []"
            :key="s.id"
            class="skin-option"
            :class="{ current: s.id === skinId || s.chromas.some((c) => c.id === skinId) }"
            :disabled="busy"
            @click="chooseSkin(s.id)"
          >
            <AssetImage kind="skin" :id="s.id" :width="96" :height="96" :label="s.name" />
            <span class="opt-name">{{ s.name }}</span>
          </button>
        </div>
        <div v-if="parentSkin?.chromas.length" class="chromas">
          <span class="chroma-label">Chromas for {{ parentSkin.name }}</span>
          <div class="chroma-row">
            <button class="chroma" :class="{ current: skinId === parentSkin.id }" :disabled="busy" aria-label="No chroma" @click="chooseSkin(parentSkin.id)">
              <span class="dot none"></span>
            </button>
            <button
              v-for="c in parentSkin.chromas"
              :key="c.id"
              class="chroma"
              :class="{ current: skinId === c.id }"
              :disabled="busy"
              :aria-label="c.name"
              @click="chooseSkin(c.id)"
            >
              <span class="dot" :style="{ background: c.color ?? 'var(--muted)' }"></span>
            </button>
          </div>
        </div>
      </template>
      <button class="btn btn-ghost close" @click="sheet = null">Done</button>
    </section>
  </div>
</template>

<style scoped>
.loadout {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spell {
  position: relative;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: transparent;
}
.key {
  position: absolute;
  right: -4px;
  bottom: -4px;
  min-width: 16px;
  padding: 0 3px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 800;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
}
.skin {
  flex: 1;
  min-width: 0;
  min-height: 42px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 4px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  text-align: left;
}
.skin-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.skin-name {
  max-width: 100%;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.sheet {
  width: 100%;
  max-width: 520px;
  max-height: 85vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 16px calc(16px + var(--safe-bottom));
  border-radius: 18px 18px 0 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom: none;
}
.title {
  margin: 0;
  font-size: 18px;
}
.spell-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 8px;
}
.skin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 10px;
}
.spell-option,
.skin-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 2px;
  border-radius: 12px;
  border: 2px solid transparent;
  background: transparent;
  color: var(--text);
  font: inherit;
  min-width: 0;
}
.spell-option.current,
.skin-option.current {
  border-color: var(--accept);
  background: rgba(34, 195, 120, 0.12);
}
.spell-option.other {
  border-color: var(--border);
}
.opt-name {
  max-width: 100%;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chromas {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chroma-label {
  font-size: 12px;
  color: var(--muted);
}
.chroma-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chroma {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 2px solid transparent;
  background: transparent;
  padding: 0;
}
.chroma.current {
  border-color: var(--accept);
}
.dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.25);
}
.dot.none {
  background: linear-gradient(135deg, transparent 45%, var(--muted) 45%, var(--muted) 55%, transparent 55%);
}
.close {
  min-height: 48px;
}
</style>
