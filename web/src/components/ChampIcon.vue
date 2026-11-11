<script setup lang="ts">
import { ref, watch } from "vue";
import { iconUrl } from "../api";
import { championName } from "../store";

const props = withDefaults(defineProps<{ id: number; size?: number; faded?: boolean; banned?: boolean }>(), {
  size: 48,
  faded: false,
  banned: false,
});

const src = ref<string | null>(null);

watch(
  () => props.id,
  (id) => {
    src.value = null;
    if (id > 0) void iconUrl(id).then((url) => id === props.id && (src.value = url));
  },
  { immediate: true },
);
</script>

<template>
  <div
    class="champ-icon"
    :class="{ empty: !(id > 0), faded, banned }"
    :style="{ width: size + 'px', height: size + 'px' }"
    :title="championName(id)"
  >
    <img v-if="src" :src="src" alt="" draggable="false" />
    <span v-else-if="id > 0" class="initials">{{ championName(id).slice(0, 2) }}</span>
  </div>
</template>

<style scoped>
.champ-icon {
  position: relative;
  flex: none;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
}
.champ-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.initials {
  font-size: 13px;
  font-weight: 700;
  color: var(--muted);
}
.empty {
  border-style: dashed;
}
.faded img,
.faded .initials {
  opacity: 0.45;
}
.banned img {
  filter: grayscale(1);
  opacity: 0.7;
}
.banned::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(to top right, transparent calc(50% - 1.5px), var(--danger) calc(50% - 1.5px), var(--danger) calc(50% + 1.5px), transparent calc(50% + 1.5px));
}
</style>
