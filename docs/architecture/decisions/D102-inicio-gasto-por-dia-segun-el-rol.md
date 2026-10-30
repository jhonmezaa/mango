# D102 · Inicio: gasto e invocaciones por día, con el alcance que decide el servidor según el rol

- **Estado:** vigente
- **Fecha:** 2026-10-29 (construir Inicio con lo que hay más un agregado de gasto e invocaciones por día, y según el rol, elegido por el dueño ese día, por menú; el contador, el área de un turno, los presupuestos por rol, la lectura de lo propio con RLS, las variantes que el diseño no dibuja y los días sin contador, elegidos por menú ese día durante el trabajo)
- **Precisa / reemplaza a:** precisa [D73](D073-turno-cortado-nunca-cuesta-cero.md) (la transacción que cierra un turno suma también sus contadores del día) y [D70](D070-dos-tareas-y-limites-compartidos.md) (un límite nuevo contado por tarea: `home.reads`)
- **Precisada por:** —

## Decisión

Origen: el diseño (D24, `dashboard.jsx`) tiene una pantalla Inicio que el producto mostraba como «Próximamente»: saludo, selector de periodo, aviso de aprobaciones, gasto en Bedrock e invocaciones por día comparados con el periodo anterior, estado de agentes, tickets resueltos, latencia p95 y los presupuestos más cerca de su límite.

**(1) Un contador por día, en la transacción que cierra el turno.** El costo de un turno solo quedaba en el acumulado mensual de Budgets (`USER#`, `AGENT#`, SK = mes) y en el evento `agent.completed` del índice de auditoría, que dura 30 días y mezcla todos los eventos del día: ninguno sirve para seis meses por día sin leerlo todo. Cada escritura que suma al `spent` de un turno (`settle` y `hold` en `mango-api`, `close` en el conciliador de presupuesto) suma también, **en la misma transacción**, a tres contadores del día: `DAY#ORG`, `DAY#AREA#<área>` y `DAY#USER#<sub>`, con SK = el día UTC en que empezó el turno (`mango_core.usage_days`). Guardan `spent` (USD) y `turns` (turnos que llegaron al agente: chat, tareas y Playground). Se cuentan exactamente una vez, como el presupuesto: un turno retenido cuenta al retenerse y su costo según se conoce; uno que nunca llegó al agente no cuenta. El título de una conversación nueva suma gasto, no turno. Caducan a los 400 días (dos periodos de 180 y margen). El conciliador gana `DAY#*` en las claves que puede escribir (`SettleBudgets`). Empiezan el día que se despliega, sin histórico.

**(2) El área de un turno es la de la persona cuando lo hizo.** Sale del claim verificado `mango_business_unit` del token de ese turno y viaja con el registro pendiente del turno (`area`). Quien no tiene exactamente un área cuenta solo en la organización y en lo suyo. Cambiar de área no mueve el pasado. No se eligió sumar al leer los miembros actuales del área: exige leer el directorio y una consulta por persona en cada carga.

**(3) Una lectura: `GET /api/home?period=7d|30d|90d|180d`.** Acción Cedar `ViewHome` (toda persona de Mango, `home-view.cedar`), auditada como lectura. Responde los días del periodo y los del periodo anterior (uno por día, en cero los que no tienen contador), desde qué día cuenta la organización (`counted_since`), lo que espera la decisión de quien mira en Aprobaciones y hasta cuatro presupuestos. El periodo es una lista cerrada; no hay otra entrada. La semana y la comparación son presentación de la web.

**(4) El alcance lo decide el servidor, con Cedar y deny por defecto.**
- **La organización:** `ViewOrgUsage` (administradores y `finops-central`, `home-org-usage.cedar`).
- **Su área:** `ViewAreaUsage` (`bu-lead` con área en el token, `home-area-usage.cedar`); el área es siempre la del token, nunca un parámetro.
- **Lo suyo:** cualquier otra persona, también sin permiso de los anteriores. Se lee con su cliente de seguridad por fila: la session policy de `mango-api` gana, sobre la tabla Budgets, `GetItem` y `Query` de las claves `USER#<sub>` y `DAY#USER#<sub>` de esa persona, y el rol de datos (`Mango-<ns>-ConversationData`) gana esa misma lectura acotada a `USER#*` y `DAY#USER#*` (`OwnBudgetRead`).
- Los contadores de la organización y de un área los lee el rol de `mango-api`, con la clave que arma el servidor.

**(5) Presupuestos según el rol, sin ampliar permisos.** Administradores (`ViewAdmin` y `is_admin`, como Presupuestos): los cuatro agentes más cerca de su límite, como el diseño. Cualquier otra persona, también `finops-central` sin administrador: solo su presupuesto personal (D17 y D89 (1): los presupuestos de agentes y personas son de administradores; no hay presupuestos de área ni de equipo).

**(6) Aprobaciones:** quien firma (`ApproveToolCall`) ve las solicitudes que esperan su firma, como Gobernanza (ni las que pidió ni las que ya firmó), más las propuestas de bucket que puede decidir (D88 (48)); cualquier otra persona, solo esas propuestas. Un conteo, nunca argumentos ni personas.

**(7) Límite y caché.** `home.reads`: 30 por minuto y persona, contado en la memoria de cada tarea (precisa D70): no sostiene ninguna excepción, cada lectura son dos consultas acotadas de los contadores y la caché absorbe las recargas. La caché guarda la respuesta 30 s por persona, permisos y periodo, como mucho 256 entradas.

**(8) Lo que ve cada rol en la web, hasta que el diseño lo dibuje.** El diseño solo dibuja la vista de la organización. Inicio muestra datos a administradores y `finops-central`; para un `bu-lead` y una persona sin esos roles sigue «Próximamente» (navegación y página) hasta la ronda de diseño que dibuje sus variantes. El servidor ya les responde con su alcance. Brief: `docs/design/briefs/sync-2026-10-29c-inicio.md`.

**(9) Lo que no tiene fuente queda «Próximamente» (D24).** Estado de agentes (heartbeat; D89 (7) ya lo dejó pendiente de su propia decisión), tickets resueltos (no hay tickets) y latencia p95 (no se mide el primer token). Los días sin contador se muestran en cero, sin textos nuevos; `counted_since` queda en la respuesta para el estado «Cuenta desde el {fecha}» que se pide al diseño.

Modelo de amenazas: `docs/security/threat-models/home-threat-model.md`
