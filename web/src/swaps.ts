/** Wording for role swaps, pick-order swaps and champion trades. */

import type { ChampSelectPlayer, SwapKind } from "@shared/phone-api";
import { championName } from "./store";

export const POSITION_NAMES: Record<string, string> = {
  top: "Top",
  jungle: "Jungle",
  middle: "Mid",
  bottom: "Bot",
  utility: "Support",
};

export const SWAP_TITLES: Record<SwapKind, string> = {
  position: "Role swap",
  pickOrder: "Pick order swap",
  champion: "Champion trade",
};

const position = (p: ChampSelectPlayer) => POSITION_NAMES[p.position] ?? "their role";

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** What the swap means for me, e.g. "You'd play Jungle, they'd play Support." */
export function swapOutcome(kind: SwapKind, me: ChampSelectPlayer | null, them: ChampSelectPlayer): string {
  if (kind === "position") {
    return me?.position ? `You'd play ${position(them)}, they'd play ${position(me)}.` : `You'd play ${position(them)}.`;
  }
  if (kind === "pickOrder") {
    if (them.pickTurn > 0 && me && me.pickTurn > 0) return `You'd pick ${ordinal(them.pickTurn)}, they'd pick ${ordinal(me.pickTurn)}.`;
    return "You'd swap places in the pick order.";
  }
  const theirs = championName(them.championId) || "their champion";
  const mine = me ? championName(me.championId) : "";
  return mine ? `You'd get ${theirs} for your ${mine}.` : `You'd get ${theirs}.`;
}
