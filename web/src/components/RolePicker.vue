<script setup lang="ts">
import { PICKABLE_ROLES, type Role } from "@shared/phone-api";
import { ref } from "vue";
import { run } from "../store";
import BottomSheet from "./BottomSheet.vue";

/** My first and second role in the lobby, each opening a sheet with the six choices. */
const props = defineProps<{ roles: [Role, Role] }>();

const LABELS: Record<Role, string> = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "Bot",
  UTILITY: "Support",
  FILL: "Fill",
  UNSELECTED: "Choose",
};
const SLOTS = ["First role", "Second role"] as const;

const slot = ref<0 | 1 | null>(null);
const busy = ref(false);

/** Fill as first role needs no second one; and there's no second role before there's a first. */
const secondOpen = () => props.roles[0] !== "FILL" && props.roles[0] !== "UNSELECTED";

/** The roles after choosing `role` for `at`. Choosing the other slot's role swaps them, like League does. */
function next(at: 0 | 1, role: Exclude<Role, "UNSELECTED">): [Role, Role] {
  const [first, second] = props.roles;
  if (at === 0) {
    if (role === "FILL") return ["FILL", "UNSELECTED"];
    if (role === second) return [role, first === "FILL" ? "UNSELECTED" : first];
    return [role, first === "FILL" ? "UNSELECTED" : second];
  }
  if (role === first) return second === "UNSELECTED" ? [first, second] : [second, first];
  return [first, role];
}

async function choose(role: Exclude<Role, "UNSELECTED">) {
  if (slot.value === null || busy.value) return;
  const [first, second] = next(slot.value, role);
  if (first === props.roles[0] && second === props.roles[1]) return void (slot.value = null);
  busy.value = true;
  const ok = await run("lobby/roles", { first, second });
  busy.value = false;
  if (ok) slot.value = null;
}
</script>

<template>
  <section class="roles" aria-label="Your roles">
    <button v-for="at in [0, 1] as const" :key="at" class="role" :class="{ empty: roles[at] === 'UNSELECTED' }" :disabled="at === 1 && !secondOpen()" @click="slot = at">
      <span class="label">{{ SLOTS[at] }}</span>
      <span class="value">{{ at === 1 && roles[0] === "FILL" ? "Not needed" : LABELS[roles[at]] }}</span>
    </button>
  </section>
  <BottomSheet v-if="slot !== null" :title="SLOTS[slot]" doneLabel="Cancel" @close="slot = null">
    <div class="grid">
      <button
        v-for="r in PICKABLE_ROLES"
        :key="r"
        class="option"
        :class="{ current: roles[slot] === r, other: roles[1 - slot] === r }"
        :disabled="busy || (slot === 1 && r === roles[0] && roles[1] === 'UNSELECTED')"
        @click="choose(r)"
      >
        {{ LABELS[r] }}
        <span v-if="roles[1 - slot] === r" class="hint">{{ slot === 0 ? "your second" : "your first" }}</span>
      </button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.roles {
  display: flex;
  gap: 8px;
}
.role {
  flex: 1;
  min-width: 0;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 6px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  text-align: left;
}
.role.empty {
  border-color: var(--gold);
}
.role:disabled {
  opacity: 0.45;
}
.label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.value {
  font-size: 17px;
  font-weight: 700;
}
.role.empty .value {
  color: var(--gold);
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  flex: none;
}
.option {
  min-height: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid transparent;
  font-weight: 700;
  font-size: 16px;
}
.option.current {
  border-color: var(--gold);
}
.option:disabled {
  opacity: 0.45;
}
.hint {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
}
</style>
