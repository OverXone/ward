<script setup lang="ts">
import { computed, ref } from "vue";
import { pairWithCode } from "../store";

const code = ref("");
const error = ref<string | null>(null);
const busy = ref(false);

// Crockford base32, shown as XXXX-XXXX while typing.
const clean = computed(() => code.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8));

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  code.value = v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}

async function submit() {
  if (clean.value.length !== 8 || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await pairWithCode(clean.value);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="screen">
    <div class="center">
      <div class="logo" aria-hidden="true"></div>
      <h1 class="title">Connect to your PC</h1>
      <p class="sub">Scan the QR code in the Ward window with your camera, or type the code it shows.</p>

      <form class="pair card" @submit.prevent="submit">
        <label for="code">Pairing code</label>
        <input
          id="code"
          :value="code"
          inputmode="text"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="XXXX-XXXX"
          maxlength="9"
          class="code-input mono"
          @input="onInput"
        />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="btn btn-accept" type="submit" :disabled="clean.length !== 8 || busy">
          {{ busy ? "Connecting…" : "Connect" }}
        </button>
      </form>

      <p class="hint">Phone and PC must be on the same Wi-Fi. The code works once; press Enter in the connector window for a new one.</p>
    </div>
  </main>
</template>

<style scoped>
.logo {
  width: 72px;
  height: 72px;
  border-radius: 20px;
  background: url("/icon-192.png") center / cover;
}
.pair {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: left;
  margin-top: 8px;
}
label {
  font-size: 14px;
  color: var(--muted);
}
.code-input {
  font-size: 30px;
  text-align: center;
  letter-spacing: 0.12em;
  padding: 14px;
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 14px;
}
.hint {
  color: var(--muted);
  font-size: 13px;
  max-width: 36ch;
}
</style>
