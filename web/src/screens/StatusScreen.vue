<script setup lang="ts">
defineProps<{ title: string; sub?: string; spinner?: boolean; emoji?: string }>();
</script>

<template>
  <main class="screen">
    <div class="center">
      <div v-if="spinner" class="spinner" aria-hidden="true"></div>
      <div v-else-if="emoji" class="emoji" aria-hidden="true">{{ emoji }}</div>
      <h1 class="title">{{ title }}</h1>
      <p v-if="sub" class="sub">{{ sub }}</p>
      <slot />
    </div>
  </main>
</template>

<style scoped>
.emoji {
  font-size: 52px;
  line-height: 1;
}
</style>
