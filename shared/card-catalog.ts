export type CardKind =
  | "cat"
  | "attack"
  | "support"
  | "structure"
  | "action"
  | "object"
  | "global_event"
  | "response"
  | "consumable";

export type CardEffect =
  | "fat"
  | "underfed"
  | "neighborhood"
  | "territorial"
  | "nosy"
  | "curious"
  | "foresight"
  | "hoarder"
  | "envious"
  | "mama"
  | "baby"
  | "diurnal"
  | "nocturnal"
  | "triplet"
  | "loner"
  | "hyperactive"
  | "raccoon"
  | "victim"
  | "attack"
  | "support"
  | "box"
  | "fortress"
  | "feeder"
  | "scratcher"
  | "bed"
  | "litter"
  | "skip_turn"
  | "prestige_action"
  | "extra_actions"
  | "purr"
  | "spy"
  | "random_discard"
  | "steal_random"
  | "swap_cats"
  | "steal_living_room_cat"
  | "move_cat"
  | "search_cat"
  | "sabotage"
  | "retrieve_discard"
  | "redirect_attack"
  | "nap"
  | "neighbor_dog"
  | "toy_exchange"
  | "vet"
  | "strike"
  | "cancel"
  | "draw_one_action"
  | "draw_two"
  | "draw_three"
  | "group_draw";

export interface CardDefinition {
  id: string;
  name: string;
  kind: CardKind;
  effect: CardEffect;
  image: string;
  description: string;
  sofa?: number;
  salon?: number;
  sofaSpaces?: number;
  damage?: number | "own-cat-count" | "opponent-cat-count";
  bonus?: number;
  cancelable?: boolean;
}

const card = (
  id: string,
  name: string,
  kind: CardKind,
  effect: CardEffect,
  image: string,
  description: string,
  extra: Partial<Pick<CardDefinition, "sofa" | "salon" | "sofaSpaces" | "damage" | "bonus" | "cancelable">> = {},
): CardDefinition => ({ id, name, kind, effect, image, description, ...extra });

export const CARD_CATALOG: readonly CardDefinition[] = [
  card("cat-fat", "Gato Gordo", "cat", "fat", "/cartas/gatos/gato_gordo.png", "Si omites toda tu Fase de Acción, mira en secreto la primera carta del mazo y déjala arriba o ponla en el fondo. Ocupa 2 plazas del Sofá.", { sofa: 6, salon: 2, sofaSpaces: 2 }),
  card("cat-underfed", "Gato Desnutrido", "cat", "underfed", "/cartas/gatos/gato_desnutrido.png", "Si tienes la mano vacía, obtiene +2 de prestigio.", { sofa: 1, salon: 1 }),
  card("cat-neighborhood", "Gato de Barrio", "cat", "neighborhood", "/cartas/gatos/gato_de_barrio.png", "Obtienes +1 de daño al atacar.", { sofa: 2, salon: 1 }),
  card("cat-territorial", "Gato Territorial", "cat", "territorial", "/cartas/gatos/gato_territorial.png", "Obtienes +1 de daño al defenderte.", { sofa: 2, salon: 1 }),
  card("cat-nosy", "Gato Cotilla", "cat", "nosy", "/cartas/gatos/gato_cotilla.png", "Antes de elegir tu defensa, puedes descartar 1 carta para revelar el Ataque y sus Apoyos.", { sofa: 3, salon: 1 }),
  card("cat-curious", "Gato Curioso", "cat", "curious", "/cartas/gatos/gato_curioso.png", "Antes de la Fase de Acción, puedes descartar 1 carta para mirar las 3 primeras del mazo y quedarte con 1.", { sofa: 3, salon: 1 }),
  card("cat-foresight", "Gato Previsor", "cat", "foresight", "/cartas/gatos/gato_previsor.png", "Si tienes menos de 3 cartas al reponer tu mano, roba hasta tener 4.", { sofa: 3, salon: 1 }),
  card("cat-hoarder", "Gata Acaparadora", "cat", "hoarder", "/cartas/gatos/gata_acaparadora.png", "Aumenta tu límite de mano de 7 a 9 cartas.", { sofa: 3, salon: 1 }),
  card("cat-envious", "Gata Envidiosa", "cat", "envious", "/cartas/gatos/gata_envidiosa.png", "Tus ataques contra estructuras reciben +1 de daño.", { sofa: 4, salon: 2 }),
  card("cat-mama", "Mamá Gata", "cat", "mama", "/cartas/gatos/mama_gata.png", "Cada otro gato de tu Sofá obtiene +1 de prestigio.", { sofa: 2, salon: 1 }),
  card("cat-baby", "Gato Bebé", "cat", "baby", "/cartas/gatos/gato_bebe.png", "Si está solo en tu Sofá, añade 1 carta a tu robo inicial.", { sofa: 1, salon: 1 }),
  card("cat-diurnal", "Gato Diurno", "cat", "diurnal", "/cartas/gatos/gato_diurno.png", "Si un rival ataca con éxito a un gato de tu Sofá, ese rival descarta 1 carta.", { sofa: 3, salon: 1 }),
  card("cat-nocturnal", "Gato Nocturno", "cat", "nocturnal", "/cartas/gatos/gato_nocturno.png", "Si un rival falla al atacar a un gato de tu Sofá, ese rival descarta 1 carta.", { sofa: 3, salon: 1 }),
  card("cat-triplet-1", "Gato Trillizo", "cat", "triplet", "/cartas/gatos/gato_trillizo-14.png", "Una vez por turno, descarta tantas cartas como Trillizos tengas en el Sofá y roba esa misma cantidad.", { sofa: 2, salon: 1 }),
  card("cat-triplet-2", "Gato Trillizo", "cat", "triplet", "/cartas/gatos/gato_trillizo-15.png", "Una vez por turno, descarta tantas cartas como Trillizos tengas en el Sofá y roba esa misma cantidad.", { sofa: 2, salon: 1 }),
  card("cat-triplet-3", "Gato Trillizo", "cat", "triplet", "/cartas/gatos/gato_trillizo-16.png", "Una vez por turno, descarta tantas cartas como Trillizos tengas en el Sofá y roba esa misma cantidad.", { sofa: 2, salon: 1 }),
  card("cat-loner", "Gato Solitario", "cat", "loner", "/cartas/gatos/gato_solitario.png", "Solo en el Sofá vale 7; acompañado vale 0. En el Salón vale 2. Solo cancela Eventos individuales que lo elijan directamente.", { sofa: 0, salon: 2 }),
  card("cat-hyperactive", "Gato Hiperactivo", "cat", "hyperactive", "/cartas/gatos/gato_hiperactivo.png", "Una vez por turno, antes de usar tus acciones, puedes realizar un movimiento gatuno adicional.", { sofa: 3, salon: 1 }),
  card("cat-raccoon", "Gato Mapache", "cat", "raccoon", "/cartas/gatos/gato_mapache.png", "Puedes recuperar la carta superior del descarte en lugar del robo inicial y sus bonificaciones.", { sofa: 2, salon: 1 }),
  card("cat-victim", "Gato Victimista", "cat", "victim", "/cartas/gatos/gato_victimista.png", "Si un rival cancela un Evento tuyo con Flús-Flús, ese rival descarta 1 carta adicional.", { sofa: 3, salon: 1 }),

  card("attack-hairball", "Bola de Pelo", "attack", "attack", "/cartas/ataques/bola_de_pelo.png", "Ataque de potencia 0.", { damage: 0 }),
  card("attack-hiss", "Bufido", "attack", "attack", "/cartas/ataques/bufido.png", "Ataque de potencia 1.", { damage: 1 }),
  card("attack-ambush", "Emboscada", "attack", "attack", "/cartas/ataques/emboscada.png", "Ataque de potencia 2.", { damage: 2 }),
  card("attack-swipe", "Zarpazo", "attack", "attack", "/cartas/ataques/zarpazo.png", "Ataque de potencia 3.", { damage: 3 }),
  card("attack-bite", "Mordisco", "attack", "attack", "/cartas/ataques/mordisco.png", "Ataque de potencia 4.", { damage: 4 }),
  card("attack-kick", "Agarre con patada", "attack", "attack", "/cartas/ataques/agarre_con_patada.png", "Ataque de potencia 5.", { damage: 5 }),
  card("attack-pack", "Ataque en manada", "attack", "attack", "/cartas/ataques/ataque_en_manada.png", "Su daño equivale al número de gatos de tu casa.", { damage: "own-cat-count" }),
  card("support-claws", "Afilado de uñas", "support", "support", "/cartas/ataques/afilado_de_unas.png", "Apoyo: suma +2 a tu potencia en este combate.", { bonus: 2 }),
  card("support-bristle", "Erizarse", "support", "support", "/cartas/ataques/erizarse.png", "Apoyo: suma +1 a tu potencia en este combate.", { bonus: 1 }),
  card("attack-vacuum", "Terror del aspirador", "attack", "attack", "/cartas/ataques/terror_del_aspirador.png", "Ataque de potencia 1.", { damage: 1 }),
  card("attack-broom", "Escobazo contundente", "attack", "attack", "/cartas/ataques/escobazo_contundente.png", "Ataque de potencia 2.", { damage: 2 }),
  card("attack-slipper", "Zapatilla voladora", "attack", "attack", "/cartas/ataques/zapatilla_voladora.png", "Ataque de potencia 3.", { damage: 3 }),
  card("attack-whiskers", "Caza de Bigotes", "attack", "attack", "/cartas/ataques/caza_de_bigotes.png", "Ataque de potencia 4.", { damage: 4 }),
  card("attack-bath", "Baño forzado", "attack", "attack", "/cartas/ataques/bano_forzado.png", "Ataque de potencia 5.", { damage: 5 }),
  card("attack-hose", "Manguerazo frío", "attack", "attack", "/cartas/ataques/manguerazo_frio.png", "Su daño equivale al número de gatos del rival participante en el combate, después de los desvíos.", { damage: "opponent-cat-count" }),
  card("support-cucumber", "¡Susto de Pepino!", "support", "support", "/cartas/ataques/susto_de_pepino.png", "Apoyo: suma +1 a tu potencia en este combate.", { bonus: 1 }),
  card("attack-pact", "¡Pacto de Bigotes y Escobazos!", "attack", "attack", "/cartas/ataques/pacto_de_bigotes_y_escobazos.png", "Ataque de potencia 6.", { damage: 6 }),

  card("structure-box", "Caja de Cartón", "structure", "box", "/cartas/estructuras/caja_de_carton.png", "Protege a tus gatos de ataques directos. Se destruye con un ataque exitoso contra ella."),
  card("structure-fortress", "Fortaleza Gatuna", "structure", "fortress", "/cartas/estructuras/fortaleza_gatuna.png", "Protege a tus gatos de ataques directos y bloquea Eventos individuales rivales que los afecten."),
  card("structure-feeder", "Comedero Automático", "structure", "feeder", "/cartas/estructuras/comedero_automatico.png", "Roba 1 carta adicional durante el robo inicial."),
  card("structure-scratcher", "Rascador de Sisal", "structure", "scratcher", "/cartas/estructuras/rascador_de_sisal.png", "Desde el turno siguiente al que lo juegas, antes de tu primera acción puedes descartar 1 carta: tu primer ataque posterior recibe +1 de potencia."),
  card("structure-bed", "Cama de Peluche", "structure", "bed", "/cartas/estructuras/cama_de_peluche.png", "Elige un gato del Sofá al jugarla. Queda protegido de ataques y movimientos hasta que la Cama salga de juego."),
  card("structure-litter", "Arenero", "structure", "litter", "/cartas/estructuras/arenero.png", "Guarda costes y descartes impuestos de la mano. Antes del cierre, con 3 o más cartas puedes recuperar 1 y descartar las demás."),

  card("action-skip", "No te muevas, estoy cómodo", "action", "skip_turn", "/cartas/acciones/no_te_muevas_estoy_comodo.png", "Un rival pierde su próximo turno completo, incluido inicio y cierre.", { cancelable: true }),
  card("action-sofa", "Destrucción de Sofá", "action", "prestige_action", "/cartas/acciones/destruccion_de_sofa.png", "Obtienes +1 de prestigio hasta el final del turno y 1 acción adicional.", { cancelable: true }),
  card("action-catnip", "Sobredosis de Catnip", "action", "extra_actions", "/cartas/acciones/sobredosis_de_catnip.png", "Obtienes 2 acciones extra.", { cancelable: true }),
  card("action-purr", "Ronroneo", "action", "purr", "/cartas/acciones/ronroneo.png", "Elige 2 gatos del Sofá. Si ambos siguen allí al inicio de tu próximo turno, obtienen +1 de prestigio ese turno.", { cancelable: true }),
  card("action-spy", "Espía de Ventana", "action", "spy", "/cartas/acciones/espia_de_ventana.png", "Al defenderte, revela el Ataque y sus Apoyos después de elegir defensa.", { cancelable: true }),
  card("action-pillow", "Sorpresa en la Almohada", "action", "random_discard", "/cartas/acciones/sorpresa_en_la_almohada.png", "Elige un rival; descarta al azar la mitad de su mano, redondeando hacia abajo y con mínimo 1.", { cancelable: true }),
  card("action-table", "Tirar Cosas de la Mesa", "action", "steal_random", "/cartas/acciones/tirar_cosas_de_la_mesa.png", "Elige un rival con 6 o más cartas en mano y róbale 2 al azar.", { cancelable: true }),
  card("action-keyboard", "Sentarse en el Teclado", "action", "steal_random", "/cartas/acciones/sentarse_en_el_teclado.png", "Elige un rival con 4 o más cartas en mano y róbale 1 al azar.", { cancelable: true }),
  card("action-cat-door", "Puerta Gatera", "action", "swap_cats", "/cartas/acciones/puerta_gatera.png", "Intercambia un gato tuyo por uno rival. Cada gato ocupa el puesto que deja el otro.", { cancelable: true }),
  card("action-cat-burglar", "Robo Felino", "action", "steal_living_room_cat", "/cartas/acciones/robo_felino.png", "Roba un gato del Salón rival y llévalo a tu casa.", { cancelable: true }),
  card("action-laser", "Láser Infrarrojo", "action", "move_cat", "/cartas/acciones/laser_infrarrojo.png", "Mueve o intercambia un gato entre el Sofá y el Salón de una casa.", { cancelable: true }),
  card("action-pspsps", "¡Pspspsps!", "action", "search_cat", "/cartas/acciones/pspspsps.png", "Busca el primer gato del mazo y colócalo en tu casa. Si no hay gatos, baraja y roba 1 carta.", { cancelable: true }),
  card("action-sabotage", "Sabotaje Vecinal", "action", "sabotage", "/cartas/acciones/sabotaje_vecinal.png", "Destruye una estructura rival, incluida la Fortaleza y la Cama. No se puede cancelar.", { cancelable: false }),
  card("object-yarn", "Ovillo de Lana", "object", "retrieve_discard", "/cartas/acciones/ovillo_de_lana.png", "Recupera una carta del descarte común. Los gatos recuperados entran directamente en tu casa.", { cancelable: true }),
  card("object-mouse", "Ratón con Hierba Gatuna", "object", "redirect_attack", "/cartas/acciones/raton_con_hierba_gatuna.png", "Cuando te ataquen, puedes desviar el ataque a otro objetivo válido fuera de la casa del atacante.", { cancelable: true }),
  card("event-nap", "Hora de la Siesta", "global_event", "nap", "/cartas/acciones/hora_de_la_siesta.png", "Hasta el inicio de tu próximo turno, se anulan las habilidades y sinergias de todos los gatos."),
  card("event-dog", "Perro del Vecino", "global_event", "neighbor_dog", "/cartas/acciones/perro_del_vecino.png", "Cada jugador intenta mover un gato del Sofá al Salón."),
  card("event-toys", "Reparto de Juguetes", "global_event", "toy_exchange", "/cartas/acciones/reparto_de_juguetes.png", "Todos pasan simultáneamente una carta de su mano al jugador de su izquierda."),
  card("event-vet", "Visita al Veterinario", "global_event", "vet", "/cartas/acciones/visita_al_veterinario.png", "Cada jugador con 1–3 gatos descarta 1 carta; con 4 o más, descarta 2."),
  card("event-strike", "Huelga de Gatos", "global_event", "strike", "/cartas/acciones/huelga_de_gatos.png", "Hasta tu próximo turno, no se permite mover gatos entre Sofá y Salón. Los gatos recién obtenidos sí pueden colocarse."),
  card("response-flush-1", "Flús-Flús de Agua", "response", "cancel", "/cartas/acciones/flus-flus_de_agua-1.png", "Cancela una carta marcada con el símbolo de Flús-Flús.", { cancelable: true }),
  card("response-flush-2", "Flús-Flús de Agua", "response", "cancel", "/cartas/acciones/flus-flus_de_agua-2.png", "Cancela una carta marcada con el símbolo de Flús-Flús.", { cancelable: true }),
  card("response-flush-3", "Flús-Flús de Agua", "response", "cancel", "/cartas/acciones/flus-flus_de_agua-3.png", "Cancela una carta marcada con el símbolo de Flús-Flús.", { cancelable: true }),
  card("response-flush-4", "Flús-Flús de Agua", "response", "cancel", "/cartas/acciones/flus-flus_de_agua-4.png", "Cancela una carta marcada con el símbolo de Flús-Flús.", { cancelable: true }),

  card("consumable-food", "Pienso", "consumable", "draw_one_action", "/cartas/consumibles/pienso.png", "Roba 1 carta y obtén 1 acción extra este turno."),
  card("consumable-tuna", "Lata de Atún", "consumable", "draw_two", "/cartas/consumibles/lata_de_atun.png", "Roba 2 cartas."),
  card("consumable-churu", "Churu", "consumable", "draw_three", "/cartas/consumibles/churu.png", "Roba 3 cartas."),
  card("consumable-catnip", "Bolsa de Catnip", "consumable", "group_draw", "/cartas/consumibles/bolsa_de_catnip.png", "Todos roban 1 carta empezando por ti; después tú robas 1 más."),
];

export const CARD_BY_ID = new Map(CARD_CATALOG.map((definition) => [definition.id, definition]));
