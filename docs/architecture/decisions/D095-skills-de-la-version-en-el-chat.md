# D95 · Quien usa un agente ve en el chat las skills de la versión que le responde, desde el detalle del agente

- **Estado:** vigente
- **Fecha:** 2026-10-26 (elegida por el dueño ese día, por menú: «Detalle del agente (Recomendada)», al construir lo que dejó la ronda de diseño 23)
- **Precisa / reemplaza a:** reemplaza el punto (8) de [D92](D092-skills-de-solo-instrucciones.md) en lo que toca al popover «Skills y tools» (el botón «Skill» del compositor se quita, como pide el diseño); precisa D92 (3) (quién ve una skill)
- **Precisada por:** —

## Decisión

Origen: la ronda 23 de Claude Design (2026-10-26) dibujó el popover «Qué puede usar {agente}» del chat, con las skills de la versión que responde (nombre, descripción y versión), y quitó el botón «Skill» del compositor, porque una skill no se puede forzar. D92 (8) dejaba el popover «Próximamente», y D92 (3) daba la vista de skills solo a administradores y creadores (`GET /api/skills`).

**(1) Dónde (elegida por el dueño, por menú: «Detalle del agente (Recomendada)»).** `GET /api/agents/{id}` trae `skills`: id, versión, nombre y descripción de cada skill aprobada de la versión que sirve el chat, en el orden de la versión. Nunca sus instrucciones ni sus MCP. La lista del marketplace (`GET /api/agents`) no las trae (`null`) y no lee la tabla `Skills`. No hay ruta nueva y `GET /api/skills` sigue solo para administradores y creadores.

**(2) Quién.** Quien puede usar el agente: la misma autorización `UseAgent` del detalle, sobre la versión que sirve el chat. Quien no puede recibe el mismo 403 de siempre. Nombre y descripción de una skill son lo que el harness ya pone en el prompt del agente; quien usa el agente puede pedírselos al propio agente.

**(3) Cómo lo pide la web.** El popover pide el detalle la primera vez que se abre, no al abrir el chat. Si la tabla `Skills` no se puede leer, el detalle responde igual con `skills: null` y el popover dice que no pudo cargarlas, con «Reintentar». La latencia y la salud de cada MCP que dibuja el diseño no tienen backend y no se muestran.

**(4) El Playground nombra la skill que ya no está aprobada.** El `422 skill_unavailable` de `POST /api/playground/runs` trae `skills`, la lista de `id@versión` que dejaron de estar aprobadas: quien prueba ya las ve en el Agent Builder. La pantalla muestra «{skill} v{n} ya no está aprobada…», la insignia «Ya no aprobada» en el panel y «Abrir en el Agent Builder».
