import inventory from "../server/data/card-quantities.json" with { type: "json" };
import { CARD_CATALOG } from "../shared/card-catalog.js";

const definitions = new Map(CARD_CATALOG.map((card) => [card.id, card]));
const counts = inventory.copies as Record<string, number>;
const errors: string[] = [];

for (const id of definitions.keys()) {
  if (!Number.isInteger(counts[id]) || counts[id] < 0) {
    errors.push(`Missing or invalid copy count for ${id}`);
  }
}

for (const id of Object.keys(counts)) {
  if (!definitions.has(id)) errors.push(`Unknown card id in inventory: ${id}`);
}

const total = Object.values(counts).reduce((sum, copies) => sum + copies, 0);
const cats = CARD_CATALOG
  .filter((card) => card.kind === "cat")
  .reduce((sum, card) => sum + (counts[card.id] ?? 0), 0);

if (total !== inventory.expectedDeckSize) {
  errors.push(`Expected deck size ${inventory.expectedDeckSize}, got ${total}`);
}

if (cats !== 20) errors.push(`Expected 20 cats, got ${cats}`);

if (errors.length > 0) {
  throw new Error(errors.join("\n"));
}

console.log(`Inventory OK: ${total} cards, including ${cats} cats.`);
