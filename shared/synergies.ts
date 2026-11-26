export interface SynergyDefinition {
  id: string;
  name: string;
  cats: string[];
  description: string;
}

export const SYNERGIES: readonly SynergyDefinition[] = [
  { id: "squashed", name: "¡Que me aplastas!", cats: ["cat-fat", "cat-underfed"], description: "El Desnutrido se coloca bajo el Gordo y no ocupa una plaza adicional." },
  { id: "neighborhood-veterans", name: "Veteranos del barrio", cats: ["cat-neighborhood", "cat-territorial"], description: "Se anulan sus bonificaciones de daño y la pareja suma 2 puntos de prestigio adicionales." },
  { id: "information-partners", name: "Socios de información", cats: ["cat-nosy", "cat-curious"], description: "Cotilla revela sin descartar; Curioso mira 4 cartas y conserva su coste." },
  { id: "inventory-control", name: "Control de inventario", cats: ["cat-foresight", "cat-hoarder"], description: "Si tienes menos de 3 cartas tras el robo inicial, repón hasta 5." },
  { id: "envious-raiders", name: "Saqueadores envidiosos", cats: ["cat-envious", "cat-raccoon"], description: "Al destruir una estructura rival con un ataque, puedes descartar 1 carta para recuperarla del descarte." },
  { id: "yin-yang", name: "Pareja yin-yang", cats: ["cat-diurnal", "cat-nocturnal"], description: "La pareja suma 1 punto de prestigio adicional." },
  { id: "why-me", name: "¿Por qué yo?", cats: ["cat-victim", "cat-hyperactive"], description: "Si ambos empiezan el turno en el Sofá y Victimista baja al Salón, roba 1 carta; no puede volver ese turno." },
  { id: "triplets", name: "Los Trillizos", cats: ["cat-triplet-1", "cat-triplet-2", "cat-triplet-3"], description: "Con los tres en el Sofá, obtienes 2 puntos de prestigio adicionales." },
  { id: "favorite-child", name: "El ojito derecho", cats: ["cat-mama", "cat-baby"], description: "Mamá Gata da +3 al Bebé en vez de +1; los demás gatos siguen recibiendo +1." },
];
