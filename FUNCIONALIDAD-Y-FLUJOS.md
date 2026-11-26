# Funcionalidad y flujos de ¡Ese gato es mío! Online

Este documento describe el comportamiento actual del juego web, las decisiones de interfaz y las responsabilidades de sus componentes. La aplicación está en `ThatCatIsMineOnline`; `ThatCatIsMine` se conserva como referencia de arte y reglas y no se modifica.

## 1. Alcance y arquitectura

- Partidas locales para entre 2 y 5 perfiles, cada uno conectado desde su propio navegador.
- El cliente presenta el tablero y envía comandos; el servidor valida las reglas y conserva el estado autoritativo de cada partida.
- Colyseus mantiene las salas y comunica estados públicos y privados.
- SQLite guarda cuentas de prueba, ELO, historial y preferencia de tema por cuenta.
- Las cartas y sinergias se definen en `shared/card-catalog.ts` y `shared/synergies.ts`. El reglamento de referencia sigue siendo provisional donde la implementación lo indica.
- El inventario debe sumar 96 cartas. `npm run check:inventory` valida cantidades e identificadores.

## 2. Acceso y creación de una partida

1. Inicia los procesos localmente con `npm run dev`, o genera y ejecuta la compilación con `npm run build` y `npm start`.
2. Entra con uno de los perfiles `gato1`–`gato5` (contraseña de desarrollo: `gato123`).
3. El primer perfil de la sala es el anfitrión; puede iniciar la partida cuando haya al menos dos jugadores.
4. No se puede usar la misma cuenta dos veces en una misma sala.
5. El cliente conserva una sesión temporal en memoria. Las cuentas de prueba y sus contraseñas no son credenciales para un despliegue público.

## 3. Reparto inicial y comienzo del turno

- El reparto inicial aparta los gatos para que sus propietarios elijan dónde empieza cada uno: Sofá o Salón. La selección se hace en una ventana modal y se confirma antes de empezar.
- El diálogo inicial también permite revisar la mano recibida: muestra las ilustraciones y nombres de las cartas que no son gatos.
- La partida no inicia su primer turno hasta que todos hayan colocado sus gatos iniciales.
- Al inicio del turno, el jugador roba las cartas que correspondan a las reglas y bonificaciones activas. Si tiene que decidir entre el mazo y el Gato Mapache, esa decisión también aparece en un diálogo.
- El turno comienza con la Fase de Acción. Se puede saltar antes de ejecutar la primera acción; después de gastar la última acción, se pasa automáticamente a Movimiento.
- Las habilidades de preparación permitidas se ofrecen antes de la primera acción. El Rascador de Sisal se puede armar desde el turno posterior al que se juega.

## 4. Robo de cartas y colocación de gatos

- Cada robo mediante el motor común se registra para el propietario en una notificación privada. La información de las cartas no se incluye en el estado público.
- La notificación muestra cuántas cartas se robaron, sus imágenes y sus nombres. El propietario confirma con **Aceptar** antes de continuar.
- Esa confirmación es una barrera del servidor, no solo un aviso visual: una acción que agotó las acciones disponibles no pasa a Movimiento hasta que el jugador confirme.
- Si el robo incluye uno o más gatos, las imágenes de todas las cartas y los selectores de destino aparecen juntos en el mismo diálogo. Al confirmar, se colocan los gatos y se reanuda el flujo de la acción.
- Lata de Atún, Churu, Pienso, Bolsa de Catnip, Trillizos, el robo inicial y los robos de reposición utilizan el mismo registro de cartas robadas.
- Las cartas consultadas para elegir (por ejemplo, con Gato Curioso) se presentan en sus propios diálogos y no se confunden con una carta ya añadida a la mano.
- Siempre que se recibe un gato por robo, efecto o captura, el propietario ve una ventana para elegir Sofá o Salón. El Sofá solo se ofrece si la capacidad actual lo permite. Si se reciben varios gatos, las opciones de Sofá tienen en cuenta las elecciones anteriores del mismo diálogo.
- El atacante que captura un gato después de vencer el combate también decide dónde colocarlo. Robo Felino usa la misma elección. Puerta Gatera conserva el intercambio de zonas, sin pedir un destino adicional.
- Un gato todavía pendiente de colocación no se revela a los demás en el estado público.

## 5. Cartas, acciones y decisiones

- Al elegir una carta jugable de la mano se abre un diálogo con la carta y los controles necesarios para esa acción. Se puede cancelar la selección sin gastar la carta.
- Los objetivos se limitan a jugadores, gatos, estructuras o cartas que sean válidos para el efecto elegido. El servidor repite la validación para evitar que un comando manipulado ejecute un objetivo ilegal.
- El Láser Infrarrojo solo permite elegir una casa con gatos, un gato existente y la otra zona como destino. La decisión corresponde a quien juega el Láser; el objetivo no la elige.
- Las elecciones requeridas por eventos, intercambios, descartes, Arenero, capturas y habilidades aparecen también como diálogos, para que no haya que buscar la decisión activa más abajo en la página.
- Las casillas de selección y los botones de opción se dibujan con controles personalizados de mayor tamaño, indicadores visibles de foco y un estado seleccionado claro.
- Las cartas conservan sus imágenes y descripciones. Al pulsar una ilustración se abre una vista ampliada de lectura; los contenedores de cartas no añaden un fondo independiente.

## 6. Ataques, defensa y Flús-Flús

### Ataques y defensa

- El atacante selecciona un rival y un gato o estructura que pueda ser objetivo; sus apoyos son opcionales.
- El defensor recibe un diálogo de tono rojizo. Si tiene cartas de Ataque, solo esas cartas aparecen como defensas. Los Apoyos, Espía y Cotilla se presentan aparte cuando son aplicables.
- Si el defensor no tiene una carta de Ataque, el diálogo explica que no puede defenderse y ofrece **Aceptar ataque**. Si sí tiene, también puede aceptar sin gastar una carta.
- El ataque espera hasta 30 segundos. Si no hay una respuesta antes del vencimiento, el servidor confirma el ataque sin defensa y registra que el defensor no respondió a tiempo. El mensaje público no revela si tenía una carta de defensa.
- Ratón con Hierba Gatuna solo aparece si el defensor lo tiene y el ataque puede desviarse a otro objetivo válido. La ventana de su efecto se resuelve antes de que el nuevo objetivo defienda.
- El atacante también ve un diálogo de espera mientras su ataque no se ha resuelto.
- Si el atacante vence y captura un gato, la captura queda pendiente hasta elegir su zona. Si otra habilidad exige descartar o recuperar una estructura, esa decisión se completa antes de cerrar el combate.

### Flús-Flús de Agua

- Las cartas cancelables abren una ventana de respuesta pública de 15 segundos para cada jugador con prioridad.
- Solo aparecen como opciones las cartas Flús-Flús que el jugador tiene en la mano. Pasar, carecer de la carta o dejar que venza el temporizador no consume ninguna.
- El servidor avanza al siguiente jugador cuando alguien pasa o vence su tiempo. Cada nueva respuesta reinicia su propio plazo.
- Quien jugó la carta ve una ventana modal mientras los demás responden. El defensor de un ataque también recibe el diálogo de Flús-Flús cuando es su turno de responder.
- El registro de cancelación identifica la carta original y a ambos participantes: quién la jugó y quién la canceló finalmente. Si la cadena tiene varias respuestas, la cancelación final se atribuye al jugador que puso la última carta que deja la cadena impar.

## 7. Actividad e inactividad

- El servidor publica qué jugador tiene que tomar la siguiente decisión y desde cuándo está esperando.
- Después de 60 segundos sin comandos válidos, el tablero de ese jugador muestra **AFK** y un cronómetro que continúa avanzando. El indicador solo aparece en el tablero del jugador al que le toca decidir; esperar el turno de otra persona no cuenta como inactividad propia.
- La marca AFK no salta ni termina turnos normales automáticamente, para evitar perder acciones válidas por una pausa o una desconexión breve.
- Las decisiones de combate sí tienen la regla independiente de 30 segundos: al vencer, se acepta el ataque sin defensa. Las ventanas de Flús-Flús conservan su propio límite de 15 segundos.

## 8. Sinergias

- Cada tablero indica el número de sinergias activas y ofrece un botón para consultar sus reglas.
- El diálogo muestra nombre, descripción e ilustraciones de los gatos que forman cada sinergia.
- La lista se calcula en el servidor a partir de los gatos públicos del Sofá y de las reglas compartidas. Hora de la Siesta suspende las sinergias mientras está activa.
- Las manos privadas no se usan para inferir ni publicar sinergias.

## 9. Tablero, consulta y preferencias

- En escritorio, el tablero propio se presenta debajo y más grande; los rivales aparecen arriba en una cuadrícula compacta. En móvil, las zonas se apilan para conservar el ancho legible.
- La casa se divide en Sofá, Estructura y Salón. Las tres zonas mantienen tamaños coordinados, con iconos tenues de zona.
- Las cartas se muestran sin paneles de fondo añadidos y con una ampliación para leer el texto.
- El Salón de cada jugador y el historial de descartes pueden desplazarse de forma independiente para no alargar toda la mesa.
- El descarte muestra su última carta y permite abrir la pila completa.
- Cuando el mazo se agota, se baraja el descarte dejando su carta superior en la pila; esa carta no vuelve al mazo durante ese robo.
- El tema claro u oscuro se cambia desde el perfil y se guarda en la base de datos por usuario.
- Los diálogos se adaptan al viewport, permiten desplazamiento interno cuando el contenido es largo y conservan controles utilizables con ratón, teclado y pantallas táctiles.
- Los iconos de Sofá, Salón, Estructura, ataque y huella son copias locales. Los originales del repositorio de referencia no se modifican.

## 10. Interpretaciones de reglas que deben cotejarse

La aplicación tiene pruebas para las reglas implementadas, pero las siguientes interpretaciones siguen siendo provisionales y deben contrastarse con el reglamento definitivo antes de publicar:

- Huelga bloquea los movimientos voluntarios entre Sofá y Salón, pero no la colocación de gatos recién recibidos.
- Cama protege al gato elegido de ataques y movimientos mientras la estructura siga en juego.
- Veteranos del barrio añade prestigio y anula bonificaciones de daño de la pareja.
- Curioso devuelve las cartas no elegidas a la parte superior del mazo, conservando el orden.
- Los gatos capturados por ataque o Robo Felino permiten elegir destino, salvo los intercambios de Puerta Gatera.
- La defensa detiene el ataque cuando su potencia iguala o supera la atacante.
- La inactividad normal se indica, pero no avanza turnos; solo ataque y Flús-Flús tienen vencimiento automático.

## 11. Estructura del código

| Ruta | Responsabilidad |
| --- | --- |
| `client/main.ts` | Renderizado, ventanas modales, formularios, selección de cartas y comunicación con la sala. |
| `client/style.css` | Tablero adaptable, controles, cartas, diálogos, temas y estados visuales. |
| `shared/card-catalog.ts` | Catálogo, descripciones, rutas de imágenes y efectos de las cartas. |
| `shared/synergies.ts` | Definiciones de sinergias visibles y aplicables por el motor. |
| `shared/game-types.ts` | Tipos de estado público/privado, combate, comandos y proyecciones. |
| `server/game/game-engine.ts` | Reglas de acciones, robos, combate, colocación, respuestas y turnos. |
| `server/game/deck.ts` | Construcción, barajado, robo, reposición desde el descarte y notificaciones de cartas robadas. |
| `server/game/projections.ts` | Separación de información pública y privada, sinergias y decisiones pendientes. |
| `server/game/game-room.ts` | Sala Colyseus, temporizadores autoritativos y avisos de actividad. |
| `server/game/game-engine.test.ts` | Pruebas de proyecciones, combate, capturas, robos, cancelaciones y vencimiento de defensa. |
| `server/game/deck.test.ts` | Pruebas de robos, reciclaje del descarte y avance de fases. |
| `server/data/` | Persistencia SQLite, cuentas, historial y preferencia de tema. |
| `imagenes/emojis/` | Recursos visuales locales usados en el tablero y los avisos. |

## 12. Validación

Desde la carpeta del proyecto:

```sh
npm run check:inventory
npm run typecheck
npm test
npm run build
npm run smoke
```

`npm run smoke` comprueba dos conexiones locales, privacidad y flujos básicos en puertos temporales. Las pruebas unitarias verifican, entre otros casos, que una acción de robo no termina antes de confirmar sus cartas, que los gatos robados se eligen en el mismo diálogo, que la mano no se filtra al estado público y que el registro nombra al jugador que canceló con Flús-Flús.
