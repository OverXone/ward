<script setup lang="ts">
import type { InvitationView } from "@shared/phone-api";
import { computed, ref, watch } from "vue";
import { invitationAlert } from "../alerts";
import { run } from "../store";

/** Lobby invitations someone sent me, with Join / Decline. Shown on every screen. */
const props = defineProps<{ invitations: InvitationView[]; phase: string | null }>();

// Joining another lobby from champ select would dodge, and League refuses it in game.
const blocked = computed(() => ["ChampSelect", "GameStart", "InProgress", "Reconnect"].includes(props.phase ?? ""));
const busy = ref<string | null>(null);

watch(
  () => props.invitations.map((i) => i.handle),
  (now, before) => {
    if (now.some((h) => !before?.includes(h))) invitationAlert();
  },
);

async function respond(inv: InvitationView, verb: "accept" | "decline") {
  if (busy.value) return;
  busy.value = inv.handle;
  await run(`invitations/${verb}`, { invitation: inv.handle });
  busy.value = null;
}
</script>

<template>
  <section class="invites" aria-live="polite">
    <article v-for="inv in invitations" :key="inv.handle" class="invite card">
      <p class="what">
        <strong>{{ inv.from }}</strong> invited you{{ inv.queueName ? ` to ${inv.queueName}` : "" }}
      </p>
      <p v-if="blocked" class="why">You can join after this game.</p>
      <p v-else-if="!inv.canAccept" class="why">League won't let you join this lobby right now.</p>
      <div class="buttons">
        <button class="btn btn-accept" :disabled="!!busy || blocked || !inv.canAccept" @click="respond(inv, 'accept')">Join</button>
        <button class="btn btn-ghost" :disabled="!!busy" @click="respond(inv, 'decline')">Decline</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.invites {
  position: sticky;
  top: 0;
  z-index: 9;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: calc(8px + var(--safe-top)) 12px 8px;
  background: linear-gradient(to bottom, var(--bg) 80%, transparent);
}
.invite {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-color: var(--gold);
  background: rgba(214, 180, 106, 0.12);
}
.what,
.why {
  margin: 0;
}
.what {
  font-size: 15px;
}
.why {
  font-size: 13px;
  color: var(--muted);
}
.buttons {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.buttons .btn {
  flex: 1;
  min-height: 48px;
}
</style>
