# D103 · Buscar conversaciones: las propias, recorridas en `mango-api` con la sesión de seguridad por fila y un tope

- **Estado:** propuesta
- **Fecha:** 2026-11-03 (el motor y las búsquedas recientes en memoria, elegidos por el dueño por menú, 2026-11-03; la línea del tope, las sugerencias ocultas, los errores con los patrones comunes y abrir la conversación como el diseño, elegidos ese día por menú por el agente que lanzó el trabajo; los topes, los límites, la acción Cedar, la auditoría y el `POST`, decididos durante el trabajo)
- **Precisa / reemplaza a:** precisa [D70](D070-dos-tareas-y-limites-compartidos.md) (un límite compartido nuevo: `conversations.searches`) y [D24](D024-diseno-de-la-ui.md) (cuatro diferencias con `search.jsx`, punto 7, para el próximo brief)
- **Precisada por:** —

## Decisión

Origen: la entrada «Buscar conversaciones» de la barra lateral era «Próximamente». El diseño (D24, `search.jsx` `GlobalSearch`) la dibuja como una página con buscador, filtros (agente, fecha y en qué buscar: títulos, mis mensajes, respuestas, herramientas), orden (relevancia o recientes), fragmentos con los términos marcados, navegación con teclado, búsquedas recientes y conversaciones recientes.

**(1) El motor: recorrer las conversaciones de la persona en `mango-api` (elegido por el dueño por menú, 2026-11-03).** Sin infraestructura nueva ni copia del contenido en otro sitio (ni índice, ni OpenSearch, ni S3). Cada búsqueda lee la partición de la persona en `Conversations` con su cliente de seguridad por fila (`dynamodb:LeadingKeys` = `USER#<sub>`, el de `conversations.py`), solo los ítems `CONV#` y `MSG#`, y filtra en memoria. Solo las conversaciones propias: nada para administradores sobre las de otras personas (D23 no cambia). Ninguna entrada nombra a otra persona y la sesión de STS no alcanza otra partición.

**(2) Lectura acotada, la más nueva primero (`conversation_search.py`).**
- Se listan los `CONV#` (proyección: título, fecha, agente; como mucho 10 páginas de 1 MB, unas 50.000 conversaciones), se ordenan por `updated_at` y se leen los mensajes de las **200 más recientes**, hasta **4.000 mensajes** o **4 MiB de texto** (títulos, contenidos y nombres de tools), lo primero que llegue.
- La respuesta dice si un tope cortó la lectura (`capped`) y cuántas conversaciones se leyeron (`conversations_read`): la pantalla lo dice (punto 7).
- Medido en local (2026-11-03) con 200 conversaciones de 20 mensajes de ~1 KB (4.000 mensajes, 4,3 M caracteres): la lectura ocupa unos 5 MB en memoria; filtrar cuesta unos 15 ms si nada coincide y unos 250 a 320 ms en el peor caso, cuando casi todos los mensajes coinciden. En DynamoDB, una lectura completa son unos 4 MB eventualmente consistentes: unas 512 RRU, una fracción de centavo.
- La respuesta lleva como mucho **100 conversaciones** (`truncated` si coincidían más) y **20 coincidencias** por conversación.

**(3) Qué se busca y cómo.** Como `searchMessages` del diseño: palabras de dos caracteres o más (como mucho 8, sin repetir), en minúsculas, **todas en el mismo texto**. Los textos son el título, los mensajes de la persona, las respuestas del agente y los **nombres de las tools** que llamó cada respuesta, tal como se guardan (los argumentos de una llamada no se guardan, así que no se buscan). Mensajes y respuestas se comparan en texto plano (sin marcas de Markdown ni reglas de tabla); los nombres de tools, tal cual. Relevancia: número de coincidencias, más 5 si coincide el título; «Más recientes»: por `updated_at`. «Hoy» y «Desde ayer» se calculan con el reloj de la persona (`utc_offset_minutes`, acotado a ±14 h) sobre la última actividad de la conversación.

**(4) La ruta: `POST /api/search/conversations`, con cuerpo JSON.**
- No `GET`: el ALB guarda en sus logs de acceso la línea de la petición con su query string, y los términos de una búsqueda no deben llegar a ningún log.
- Modelos explícitos de Pydantic (`extra="forbid"`): la consulta (1 a 200 caracteres), el agente (`AGENT_ID_PATTERN`), en qué buscar, la fecha y el orden (listas cerradas) y el desfase del reloj. La respuesta: conversación, título, agente, fecha y, por coincidencia, su tipo, el id del mensaje y el fragmento en partes de texto plano (`{text, hit}`), 60 caracteres antes del primer término y 140 después, nunca HTML. El texto guardado de agentes y tools se trata como no confiable: la web lo pinta como texto.
- El cliente TypeScript se regenera desde el OpenAPI (`mise run api-client`).

**(5) Cedar, auditoría y logs.**
- Acción L1 **`SearchConversations`** sobre `Mango::Platform::"mango"`, para toda persona de Mango (`conversation-search.cedar`, la misma condición que `ViewHome`), deny por defecto y auditada como lectura (`READ_ACTIONS`).
- Un evento **`conversation.search`** por búsqueda, en `READ_EVENTS` (se ve con «Mostrar lecturas»), **solo con conteos**: largo de la consulta, número de términos, coincidencias, conversaciones encontradas y leídas, si hubo tope, si salió de la caché y si había filtros. **Nunca** la consulta, sus términos, el agente filtrado ni ningún contenido. Auditoría lo muestra con el formato genérico, como los eventos que el diseño no nombra.
- Un fallo de DynamoDB responde 503 (`search_unavailable`) y el log solo lleva el tipo del error.

**(6) Límite y caché.**
- **`conversations.searches`: 60 por minuto y persona, compartido entre las tareas** (tabla `RateLimits`; precisa D70). La pantalla pide una vez por pausa al escribir (300 ms) y solo desde dos caracteres.
- **Caché de la lectura, 30 s por persona, como mucho 16 entradas** (unos 5 MB cada una en el peor caso, unos 85 MB por tarea): lo que alguien escribe seguido se busca sobre la misma lectura. Una entrada solo se guarda y se devuelve para la persona que la leyó. Un mensaje nuevo aparece en la búsqueda a los 30 s como mucho.

**(7) La web (`apps/web/src/pages/search/`), con el diseño de `search.jsx` y cuatro diferencias para el próximo brief:**
- **Búsquedas recientes solo en memoria (elegido por el dueño por menú, 2026-11-03):** viven mientras la pestaña está abierta, por persona; nada en `localStorage` ni en `sessionStorage`. El diseño las guarda en `localStorage` (`mango-search-recent`).
- **El tope:** una línea en gris bajo el contador, también bajo «Sin resultados»: «Buscamos en tus {N} conversaciones más recientes; las más antiguas no se revisaron.»; y, si coincidieron más de 100, «Se muestran las 100 conversaciones con más coincidencias; afina la búsqueda para ver otras.». El diseño no dibuja ese estado.
- **«Prueba con» no se muestra:** el diseño saca nombres de herramientas de todos los mensajes, y sin una consulta no hay de dónde sacarlos sin leer contenido. El diseño ya lo oculta cuando no hay sugerencias.
- **Errores con los patrones comunes:** un fallo dice «No se pudo buscar en tus conversaciones.» con «Reintentar»; un 429, con la cuenta atrás de la ronda 34. El diseño no dibuja errores en esta pantalla.
- **Abrir un resultado abre su conversación** (`/c/<id>`), como `openChat` del diseño. Desplazarse hasta el mensaje de la coincidencia queda como propuesta para el próximo brief, sin construir.
- Las conversaciones recientes muestran el agente y la hora, sin el último mensaje: la API no lo da (igual que el historial del chat).

Modelo de amenazas: `docs/security/threat-models/conversation-search-threat-model.md`.
