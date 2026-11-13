<script setup lang="ts">
import type { RunesView } from "@shared/phone-api";
import { computed, ref } from "vue";
import AssetImage from "./AssetImage.vue";
import RunesSheet from "./RunesSheet.vue";

/** Shows the current rune page; tapping opens the page picker. */
const props = withDefaults(defineProps<{ runes: RunesView; championId?: number }>(), { championId: 0 });
const open = ref(false);
const current = computed(() => props.runes.pages.find((p) => p.isCurrent) ?? null);
</script>

<template>
  <button class="runes" :aria-label="`Runes: ${current?.name ?? 'none'}`" @click="open = true">
    <AssetImage v-if="current?.primaryStyleId" kind="style" :id="current.primaryStyleId" :width="26" class="icon" />
    <span class="text">
      <span class="label">Runes</span>
      <span class="name">{{ current?.name ?? "Choose a page" }}</span>
    </span>
  </button>
  <RunesSheet v-if="open" :runes="runes" :champion-id="championId" @close="open = false" />
</template>

<style scoped>
.runes {
  flex: 1;
  min-width: 0;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  text-align: left;
}
.runes .icon {
  border-radius: 50%;
}
.text {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.name {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
