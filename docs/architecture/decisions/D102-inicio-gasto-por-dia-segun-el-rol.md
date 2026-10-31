# D102 · Inicio: gasto e invocaciones por día, con el alcance que decide el servidor según el rol

- **Estado:** vigente
- **Fecha:** 2026-10-29 (construir Inicio con lo que hay más un agregado de gasto e invocaciones por día, y según el rol, elegido por el dueño ese día, por menú; el contador, el área de un turno, los presupuestos por rol, la lectura de lo propio con RLS, las variantes que el diseño no dibuja y los días sin contador, elegidos por menú ese día durante el trabajo) · punto (10) del 2026-10-30 (lo que dibujó la ronda 28 del diseño; ocultar lo que no tiene fuente, elegido por el dueño ese día, por menú) · punto (11) del 2026-10-30 (lo que dibujó la ronda 29 del diseño; el saludo con nombre y el campo `discarded`, elegidos por el dueño ese día, por menú) · punto (12) del 2026-10-30 (lo que dibujó la ronda 30 del diseño; las marcas del eje hasta USD 5 se corrigen porque eran un defecto del producto) · punto (13) del 2026-10-31 (lo que dibujó la ronda 31 del diseño; las etiquetas del eje del diseño, elegidas por el dueño ese día, por menú)
- **Precisa / reemplaza a:** precisa [D73](D073-turno-cortado-nunca-cuesta-cero.md) (la transacción que cierra un turno suma también sus contadores del día), [D70](D070-dos-tareas-y-limites-compartidos.md) (un límite nuevo contado por tarea: `home.reads`) y [D24](D024-diseno-de-la-ui.md) (en Inicio, lo que no tiene fuente no se muestra, punto 10)
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

**(5) Presupuestos según el rol, sin ampliar permisos.** Administradores (`ViewAdmin` y `is_admin`, como Presupuestos): los cuatro agentes más cerca de su límite, como el diseño; un agente nunca publicado también sale con su nombre (el de su última versión), y uno descartado como borrador, que ya no existe, no ocupa un lugar en la tarjeta aunque tenga gasto del mes: Presupuestos lo sigue listando, para cuadrar el gasto (2026-10-30), como «Agente descartado · {id}» (punto 11). Cualquier otra persona, también `finops-central` sin administrador: solo su presupuesto personal (D17 y D89 (1): los presupuestos de agentes y personas son de administradores; no hay presupuestos de área ni de equipo).

**(6) Aprobaciones:** quien firma (`ApproveToolCall`) ve las solicitudes que esperan su firma, como Gobernanza (ni las que pidió ni las que ya firmó), más las propuestas de bucket que puede decidir (D88 (48)); cualquier otra persona, solo esas propuestas. Un conteo, nunca argumentos ni personas.

**(7) Límite y caché.** `home.reads`: 30 por minuto y persona, contado en la memoria de cada tarea (precisa D70): no sostiene ninguna excepción, cada lectura son dos consultas acotadas de los contadores y la caché absorbe las recargas. La caché guarda la respuesta 30 s por persona, permisos y periodo, como mucho 256 entradas.

**(8) Lo que ve cada rol en la web, hasta que el diseño lo dibuje (sustituido por el punto 10).** El diseño solo dibuja la vista de la organización. Inicio muestra datos a administradores y `finops-central`; para un `bu-lead` y una persona sin esos roles sigue «Próximamente» (navegación y página) hasta la ronda de diseño que dibuje sus variantes. El servidor ya les responde con su alcance. Brief: `docs/design/briefs/sync-2026-10-29c-inicio.md`.

**(9) Lo que no tiene fuente queda «Próximamente» (D24; sustituido por el punto 10).** Estado de agentes (heartbeat; D89 (7) ya lo dejó pendiente de su propia decisión), tickets resueltos (no hay tickets) y latencia p95 (no se mide el primer token). Los días sin contador se muestran en cero, sin textos nuevos; `counted_since` queda en la respuesta para el estado «Cuenta desde el {fecha}» que se pide al diseño.

**(10) Lo que dibujó la ronda 28 del diseño (2026-10-30):** sustituye los puntos 8 y 9.
- **Inicio es para todas las cuentas.** La web muestra lo que responde el servidor, que ya decidía el alcance: la organización, el área o lo propio, con su subtítulo y sus textos de información. Ningún permiso cambia y la API no cambia: el rol en la web solo elige el subtítulo mientras carga la respuesta.
- **Lo que no tiene fuente no se muestra (elegido por el dueño, por menú).** Estado de agentes, tickets resueltos y latencia p95 se ocultan, y «Ver detalles» se quita. Es una excepción a D24 solo para Inicio, que el diseño dibuja así: lo que no tiene fecha no ocupa la portada.
- **Los días antes de `counted_since` no son cero.** La API sigue respondiendo 0, y la web los trata como días sin datos: no se suman ni se dibujan (zona rayada, «Sin datos» y «Cuenta desde el {fecha}»). Sin periodo anterior completo no hay comparación, y sin ningún día contado el total es «—». Esa fecha es la de la organización: en un área o en lo propio, un día posterior sin actividad sí es un cero.
- **Presupuestos:** administradores, «Presupuestos cerca del límite»; cualquier otra persona, «Tu presupuesto» con una fila «Límite personal», sin enlace.
- **Saludo:** solo con el nombre; sin nombre, el saludo solo, nunca el correo.

**(11) Lo que dibujó la ronda 29 del diseño (2026-10-30):**
- **Antes del primer turno de la instalación** (`counted_since` nulo), el gráfico entero va rayado con «Sin datos», el total es «—» y no hay «Cuenta desde…». El tooltip añade «Mango todavía no tiene datos. Empieza a contar con el primer turno.» y la etiqueta del gráfico termina en «· todavía sin datos».
- **Invocaciones nombra las tareas programadas**, que el contador ya sumaba (punto 1).
- **Presupuestos dice «Agente descartado · {id}»** cuando el agente ya no existe. `GET /api/admin/budgets` gana `discarded` por agente, porque un nombre nulo también puede ser una lectura de nombres fallida: solo es cierto si la lectura se completó y el agente no tiene nombre, y nunca para el agente de la release (elegido por el dueño, por menú). Si la lectura falla, sale el id a secas, como antes, sin afirmar nada. No añade datos: el id ya estaba en la respuesta.
- **El saludo sigue el punto 10, con nombre si lo hay (elegido por el dueño, por menú).** La ronda 29 dibuja «Saludo sin nombre siempre» bajo «Alineado con el producto», y no coincide con él; se le pide corregirlo. Es una diferencia con D24 solo mientras el diseño no lo corrija.
- **Marcas del eje:** el producto conserva `axisOf` (`model.ts`). El diseño adoptó su regla con una diferencia: admite tres decimales en USD por debajo de 10 («USD 0,125»), y el producto usa céntimos y, si no caben, un paso de 1, 2 o 5.

**(12) Lo que dibujó la ronda 30 del diseño (2026-10-30):**
- **El diseño vuelve al saludo del punto 10:** con nombre, «{saludo}, {nombre}»; sin nombre, el saludo solo. La diferencia con D24 del punto 11 se cierra.
- **«Agente descartado» solo cuando la API lo dice:** el diseño lo acepta y no lo dibuja aparte.
- **Marcas del eje:** el diseño adopta los céntimos («USD por debajo de 10 en céntimos, siempre dos decimales»). Al comparar las dos reglas salió un defecto del producto: con el eje hasta USD 5, las marcas 1,25, 2,50 y 3,75 se redondeaban a «USD 1, 3, 4». Se corrige porque era un defecto: ahora dicen sus céntimos, como el diseño.
- **El resto de `axisOf` se conserva.** Quedan dos diferencias con `axisTicks`, que van al brief de la ronda: el producto baja de un céntimo cuando el pico es menor («USD 0,001»), donde el diseño pinta «USD 0, USD 0,01»; y su paso de 1, 2 o 5 divide el eje en cinco partes como mucho, y el del diseño en cuatro («0,50 … 2,50» frente a «1,00 … 3,00»).

**(13) Lo que dibujó la ronda 31 del diseño (2026-10-31):**
- **Una sola regla para las marcas del eje.** El diseño copió `axisOf` en `axisTicks`, y las dos dan las mismas marcas (comparadas en 25.400 picos de USD e invocaciones). Las diferencias del punto 12 se cierran.
- **Etiquetas por debajo de un céntimo, las del diseño (elegido por el dueño, por menú):** dos decimales como mínimo y los del paso como máximo, hasta 8. La marca dice «USD 0,001», ya no «USD 0,0010». Sustituye en esto al producto, que conservaba el cero final y llegaba a 6 decimales.
- **La columna del eje sale de su etiqueta más larga,** con un mínimo de 48 px: unos 6,6 px por carácter más 8 px de aire, como el diseño. En Gasto en Bedrock, las marcas ya no se montan sobre la gráfica.

Modelo de amenazas: `docs/security/threat-models/home-threat-model.md`
