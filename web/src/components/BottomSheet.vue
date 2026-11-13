<script setup lang="ts">
/** A sheet that slides up from the bottom, with a backdrop that closes it and a Done button. */
defineProps<{ title: string; doneLabel?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <section class="sheet" role="dialog" aria-modal="true" :aria-label="title">
      <h2 class="sheet-title">{{ title }}</h2>
      <slot />
      <button class="btn btn-ghost close" @click="emit('close')">{{ doneLabel ?? "Done" }}</button>
    </section>
  </div>
</template>

<style scoped>
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
.sheet-title {
  margin: 0;
  font-size: 18px;
}
.close {
  min-height: 48px;
  flex: none;
}
</style>
