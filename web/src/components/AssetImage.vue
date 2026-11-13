<script setup lang="ts">
import { ref, watch } from "vue";
import { iconUrl, type ImageKind } from "../api";

/** A spell icon or skin tile from the League client (fetched with the pairing token). */
const props = withDefaults(defineProps<{ kind: ImageKind; id: number; width: number; height?: number; label?: string }>(), {
  height: 0,
  label: "",
});

const src = ref<string | null>(null);
watch(
  () => [props.kind, props.id] as const,
  ([kind, id]) => {
    src.value = null;
    if (id > 0) void iconUrl(id, kind).then((url) => id === props.id && kind === props.kind && (src.value = url));
  },
  { immediate: true },
);
</script>

<template>
  <div class="asset" :style="{ width: width + 'px', height: (height || width) + 'px' }" :title="label">
    <img v-if="src" :src="src" alt="" draggable="false" />
    <span v-else-if="label" class="fallback">{{ label.slice(0, 2) }}</span>
  </div>
</template>

<style scoped>
.asset {
  position: relative;
  flex: none;
  overflow: hidden;
  border-radius: 10px;
  background: var(--surface-2);
  display: grid;
  place-items: center;
}
img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.fallback {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
}
</style>
