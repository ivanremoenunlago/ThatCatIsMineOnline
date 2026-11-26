# ¡Ese gato es mío! Online

Aplicación local para jugar **¡Ese gato es mío!** con 2–5 perfiles de prueba en navegadores distintos. El servidor aplica las reglas; SQLite guarda las cuentas, el ELO y el historial de partidas. No hace falta instalar ni arrancar un servidor de base de datos.

El repositorio `ThatCatIsMine` se usa únicamente como referencia de reglas y arte. Este proyecto vive en `ThatCatIsMineOnline` y no modifica el repositorio de referencia ni sus archivos.

## Requisitos

- Node.js 22.12 o posterior y npm.
- Windows, macOS o Linux. Las instrucciones siguientes usan comandos npm.

## Arranque local

Desde la carpeta del proyecto:

```sh
npm install
npm run dev
```

Para cambiar los puertos, copia `.env.example` como `.env` y ajusta `HTTP_PORT` o `GAME_PORT` antes de iniciar el servidor.

Abre <http://127.0.0.1:5173>, inicia sesión y usa el navegador de salas. Puedes crear una sala pública o privada para 2–5 jugadores, unirte a una sala pública de la lista o introducir un código para unirte a cualquier sala:

| Perfil | Contraseña |
| --- | --- |
| gato1 | gato123 |
| gato2 | gato123 |
| gato3 | gato123 |
| gato4 | gato123 |
| gato5 | gato123 |

Cada sala tiene un código aleatorio de cuatro letras o números en mayúsculas. Las privadas no aparecen en la lista pública; el código permite entrar en ambas. Quien crea la sala puede expulsar jugadores e iniciar manualmente cuando haya al menos dos. Al llenarse, empieza una cuenta atrás de 10 segundos, que se cancela si alguien sale antes de que termine. El servidor de juego escucha en `127.0.0.1:2567`; la API HTTP usa `127.0.0.1:2568`. Son direcciones locales de desarrollo.

Al empezar, cada jugador elige en privado si sus gatos del reparto inicial van al Sofá o al Salón; el primer turno comienza cuando todos hayan confirmado. Pulsa la ilustración de cualquier carta para ampliarla y leer su texto de reglas.

Al robar o capturar un gato durante la partida, el juego espera a que el nuevo dueño elija Sofá o Salón; el Sofá solo se ofrece si tiene capacidad. Puerta Gatera conserva las zonas intercambiadas, tal como indica su carta. El tablero separa Sofá, Estructura y Salón, con iconos tenues de zona y cartas sin paneles de fondo. El último descarte se muestra junto a un botón para consultar toda la pila; al agotarse el mazo, se baraja el descarte excepto su carta superior. El tema claro/oscuro se cambia desde el perfil y se guarda por cuenta.

Los robos muestran en un diálogo privado una carta cada vez, con imagen y motivo. Tras aceptar, aparece la siguiente; si es un gato, eliges Sofá o Salón antes de continuar. Los repartos iniciales y las decisiones que requieren interacción también se presentan como ventanas modales adaptables.

Las respuestas de Flús-Flús aparecen en una ventana con cuenta atrás de 15 segundos; pasar o dejar que venza no consume una carta, y el servidor avanza automáticamente al siguiente jugador. Antes de cancelar una Acción de alguien con Victimista, se muestra una advertencia del descarte adicional. Quien jugó la carta ve una ventana de espera y el registro identifica tanto a quien la jugó como a quien finalmente la canceló. Las respuestas a ataques ofrecen solo cartas válidas de defensa y muestran una cuenta atrás de 30 segundos; si vence, el servidor acepta el ataque sin revelar si el jugador tenía una defensa. Espía de Ventana permite ver el Ataque y sus Apoyos antes de decidir la defensa; Cotilla puede hacer lo mismo con su coste correspondiente. El atacante también ve el aviso de espera.

Las decisiones para jugar cartas, colocar gatos, descartar, resolver efectos y responder aparecen en diálogos. Las casillas de selección se han personalizado y ampliado. Cada tablero muestra el número de sinergias activas y permite abrir sus reglas y las cartas de gato que las forman; también puedes consultar el catálogo completo de sinergias. Los ataques muestran las cartas utilizadas, el daño y el resultado en una ventana; la página se tiñe de rojo mientras debes responder. Al ganar, aparece una ventana de victoria y después una clasificación que ordena primero al ganador y luego al resto por prestigio. Tras un minuto sin actividad en una decisión pendiente aparece un indicador AFK con cronómetro; no se saltan turnos automáticamente. Al jugar el Láser Infrarrojo, quien lo juega selecciona una casa que tenga gatos, el gato y la zona de destino.

Consulta [FUNCIONALIDAD-Y-FLUJOS.md](./FUNCIONALIDAD-Y-FLUJOS.md) para el inventario de características, los flujos de juego, la lógica de tiempos de espera y la estructura del proyecto.

Para generar y arrancar la versión compilada:

```sh
npm run build
npm start
```

La aplicación de producción y la API se sirven en el puerto `2568`; el servidor de juego continúa en `2567`.

## Datos y desarrollo

- `server/data/card-quantities.json`: inventario editable. Las cantidades deben sumar el tamaño indicado en `expectedDeckSize` y cada clave debe existir en el catálogo.
- `shared/card-catalog.ts`: definiciones, efectos y rutas del arte.
- `shared/synergies.ts`: sinergias del juego.
- `server/game/`: mazo, reglas, motor, proyecciones públicas/privadas y sala de Colyseus.
- `client/`: interfaz del navegador.
- `imagenes/emojis/`: copias locales de la huella, ataque, Sofá, Salón y Estructura; los originales de `ThatCatIsMine` permanecen intactos.
- `server/data/game.sqlite`: base SQLite creada automáticamente al iniciar. Se crean cinco perfiles de prueba si aún no existen.
- `accounts.theme`: preferencia clara u oscura persistida por cuenta.

Comprobaciones disponibles:

```sh
npm run check:inventory
npm run typecheck
npm test
npm run build
npm run smoke
```

`npm run smoke` requiere que la aplicación esté compilada y levanta un servidor temporal en puertos 2867 y 2868 para comprobar los códigos privados, el listado público, las expulsiones, el inicio automático, la privacidad de manos y el avance del turno.

Las cuentas de prueba y sus contraseñas son solo para desarrollo local. La sesión de acceso se mantiene en memoria y se invalida al reiniciar el proceso.

## Criterios provisionales de reglas

La implementación prioriza el README, el resumen de reglas y las definiciones YAML más recientes disponibles en el proyecto de referencia. Se consideran provisionales, hasta revisar el PDF o una decisión de diseño definitiva:

- Huelga bloquea los movimientos voluntarios entre Sofá y Salón, pero no la colocación de gatos recién obtenidos.
- Cama protege al gato elegido de ataques y movimientos mientras la estructura siga en juego.
- Veteranos añade +2 de prestigio a la pareja.
- Curioso devuelve las cartas no elegidas a la parte superior del mazo, conservando el orden.
- Al agotarse el mazo, se baraja el descarte dejando su carta superior en la pila.
- Los gatos robados esperan a que su dueño elija Sofá o Salón.
- El Rascador de Sisal se puede armar desde el turno posterior al que se juega.
- Los descartes impuestos se guardan en Arenero si su dueño tiene esa estructura; el exceso de mano se descarta al montón común.
- Una defensa detiene el ataque cuando su daño iguala o supera el daño atacante.

El motor y la interfaz continúan sujetos a pruebas contra el reglamento completo; cualquier interpretación provisional deberá cotejarse antes de publicar el juego en internet.
