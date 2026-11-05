# D112 · Tickets propios de Mango: tabla, API con permiso por objeto y una tool interna en el Gateway

- **Estado:** vigente
- **Fecha:** 2026-11-05 (tickets propios de Mango y asignar solo a sí mismo o a quien ya participa, elegidos por el dueño ese día, por menú; la visibilidad, propuesta por la investigación y aceptada como parte de esa opción)
- **Precisa / reemplaza a:** precisa [D78](D078-tareas-sin-chat.md) (14) («Crear ticket» deja de ser «Próximamente»: es una salida más del resultado de una ejecución)
- **Precisada por:** —

## Decisión

Origen: el diseño (D24, `tickets.jsx`) tiene una vista «Tickets», principal y para todos (`NAV_PRIMARY`, `USER_VIEWS`): tablero y lista, un panel con comentarios, actividad y herramientas, y «Nuevo ticket». El producto no tiene ninguna fuente: ni tabla, ni API, ni tool, ni evento. Lo más cercano son las aprobaciones (D56), la Actividad (D90) y las tareas (D78). La investigación del 2026-11-05 planteó tickets propios, un ITSM externo por MCP remoto o dejarlo todo «Próximamente». El dueño eligió tickets propios.

**(1) Tickets propios de Mango** (elegido por el dueño el 2026-11-05, por menú):

- **Datos:** una tabla `Mango-<ns>-Tickets` en `Core`, con datos de producción: `RETAIN`, `deletionProtection` y PITR (D58 (7), D99). Los índices por asignado, creador y agente los precisa el PR que la construye.
- **API** en `mango-api` (`tickets.py`, con su `tickets_store.py`), con autorización **por objeto** en Verified Permissions (Cedar) y deny por defecto.
- **Comentarios** en cada ticket. Son contenido: viven en la tabla, nunca en logs, y la web los muestra como Markdown sin HTML crudo.
- **Auditoría:** `ticket.create`, `ticket.update` y `ticket.comment`, con ids y nunca el texto.
- **Una tool interna en el Gateway** para que los agentes creen y actualicen tickets: un target servido por una Lambda, como las demás tools de Mango. Pasa por el Gateway como toda tool que alcanza un sistema (regla 3), con su clase (D84) y la aprobación que le toque según D56. Tiene tope por turno.
- **«Crear ticket» como salida de una tarea** (D78): una ejecución puede dejar su resultado en un ticket.

**(2) Ids públicos aleatorios.** El diseño usa `MNG-413`, un número incremental, que `AGENTS.md` prohíbe. Cada ticket tiene un id aleatorio, y la pantalla muestra una forma corta de él.

**(3) Asignar: solo a sí mismo o a quien ya participa en el ticket** (elegido por el dueño el 2026-11-05, por menú). El desplegable de personas del diseño expondría el directorio a cualquier usuario, y la regla de auth «Sin revelar si un usuario existe» solo lo abre a creadores y administradores (excepciones de `AGENTS.md`). Con esta opción **no hay excepción nueva**: la lista de candidatos son quien mira y las personas que ya aparecen en el ticket (quien lo creó, quien lo tiene asignado y quienes comentaron).

**(4) Quién ve qué ticket** (aceptado como parte de (1)): quien lo creó, quien lo tiene asignado y quien puede usar su agente (`UseAgent`); los administradores, todos. Lo decide el servidor en cada lectura. Quien deja de cumplirlo deja de verlo.

**(5) Sin parámetros de tools.** La pestaña «Herramientas» del panel muestra las llamadas del agente como la Actividad (nombre, resultado y latencia), sin argumentos ni resultados, que no se guardan en ningún sitio (D16, D90 (3)).

**(6) Lo que no toca.** Los MCP remotos siguen siendo de solo lectura (D93 (2)): la tool de tickets es interna de Mango, no un remoto. Las menciones a la Bandeja siguen «Próximamente» (D83).

**(7) Opciones descartadas.** (b) Un ITSM externo (Jira Service Management o ServiceNow) por MCP remoto con escritura: chocaba con D93 (2), exigía aprobaciones por tool, 3LO por persona y la marca «los datos salen de AWS», y la pantalla sería un espejo del sistema externo. (c) Todo «Próximamente» hasta un piloto con un cliente. Para asignar: buscar por correo con límite y auditoría, o la lista del directorio, que eran excepciones nuevas a la regla de auth.

Modelo de amenazas: `docs/security/threat-models/tickets-threat-model.md` (lo escribe el PR que construye los tickets, con la tool interna).
