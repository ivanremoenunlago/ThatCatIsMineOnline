import { randomUUID } from "node:crypto";
import inventory from "../data/card-quantities.json" with { type: "json" };
import { CARD_BY_ID, CARD_CATALOG } from "../../shared/card-catalog.js";
import type { CardInstance } from "../../shared/cards.js";
import type { GameState, PlayerState } from "../../shared/game-types.js";

const copiesByCardId: Readonly<Record<string, number>> = inventory.copies;

export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

export function createDeck(random: () => number = Math.random): CardInstance[] {
  const cards: CardInstance[] = [];
  for (const definition of CARD_CATALOG) {
    const copies = copiesByCardId[definition.id];
    if (!Number.isInteger(copies) || copies < 0) {
      throw new Error(`Invalid inventory count for ${definition.id}`);
    }
    for (let copyIndex = 0; copyIndex < copies; copyIndex += 1) {
      cards.push({ instanceId: randomUUID(), cardId: definition.id });
    }
  }
  if (cards.length !== inventory.expectedDeckSize) {
    throw new Error(`Inventory defines ${cards.length} cards; expected ${inventory.expectedDeckSize}.`);
  }
  return shuffle(cards, random);
}

export function takeTopCard(state: GameState, random: () => number = Math.random): CardInstance | null {
  if (state.deck.length === 0 && state.discard.length > 1) {
    const topDiscard = state.discard.pop();
    state.deck = shuffle(state.discard.splice(0), random);
    if (topDiscard) state.discard.push(topDiscard);
  }
  return state.deck.pop() ?? null;
}

export function queueCatPlacement(state: GameState, player: PlayerState, card: CardInstance): void {
  const pending = state.pendingCatPlacements[player.id] ?? [];
  pending.push(card);
  state.pendingCatPlacements[player.id] = pending;
}

export function queueDrawNotice(
  state: GameState,
  player: PlayerState,
  card: CardInstance,
  reason: string,
): void {
  const pending = state.pendingDrawNotices[player.id] ?? [];
  pending.push({ card, reason });
  state.pendingDrawNotices[player.id] = pending;
}

export function drawCards(
  state: GameState,
  player: PlayerState,
  amount: number,
  reason = "robo del mazo",
): number {
  let drawn = 0;
  for (let index = 0; index < amount; index += 1) {
    const instance = takeTopCard(state);
    if (!instance) break;
    drawn += 1;
    const definition = CARD_BY_ID.get(instance.cardId);
    if (!definition) throw new Error(`Card definition missing for ${instance.cardId}`);
    queueDrawNotice(state, player, instance, reason);
    if (definition.kind === "cat") {
      queueCatPlacement(state, player, instance);
    } else {
      player.hand.push(instance);
    }
  }
  return drawn;
}
