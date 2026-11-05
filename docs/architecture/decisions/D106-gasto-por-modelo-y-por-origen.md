# D106 · Gasto por modelo y por origen: dos contadores por día más en la transacción que cierra el turno

- **Estado:** vigente
- **Fecha:** 2026-11-05 (elegida por el dueño ese día, por menú)
- **Precisa / reemplaza a:** precisa [D102](D102-inicio-gasto-por-dia-segun-el-rol.md) (1) y [D104](D104-gasto-de-bedrock-por-agente-en-la-factura.md) (7) (la transacción que cierra un turno suma también el contador del día de su modelo y el de su origen)
- **Precisada por:** —

## Decisión

Origen: la vista Costos del diseño (`costs2.jsx`, D105) desglosa el gasto «Por modelo» y «Por origen» (Conversaciones, Schedules, Evals, Playground). Ninguna de las dos dimensiones se cuenta hoy:

- el turno pendiente guarda el modelo, pero no se suma a ningún contador, y un agente cambia de modelo entre versiones, así que «el modelo actual del agente» no sirve como historia;
- una ejecución de una tarea (D78) suma a su agente igual que el chat, y las evals no existen.

El dueño eligió el 2026-11-05, por menú, contarlas.

**(1) Dos contadores nuevos por día, en la misma transacción.** Cada escritura que suma al `spent` de un turno (`settle` y `hold` en `mango-api`, `close` en el conciliador de presupuesto) suma también, **en la misma transacción** y con la misma SK (el día UTC en que empezó el turno) que los contadores de D102 (1) y de D104 (7):

- `DAY#MODEL#<model_id>`: el modelo con el que se reservó el turno, el id del catálogo (D22; regla 7: nunca una lista en el código);
- `DAY#SOURCE#<origen>`, con un origen de una lista cerrada: `chat`, `task`, `playground` y `eval`.

Guardan `spent` y `turns`, con las mismas reglas que los de D102: se cuentan exactamente una vez, un turno retenido cuenta al retenerse y su costo según se conoce, y uno que nunca llegó al agente no cuenta. Caducan como ellos.

**(2) Sin infraestructura.** Van en la tabla `Budgets` y en la transacción que ya existe (`mango_core.budget_turns`, `mango_core.usage_days`). El conciliador de presupuesto ya puede escribir `DAY#*`. Ningún recurso nuevo en `Core`. Una transacción de DynamoDB admite 100 operaciones: dos más no se acercan al tope.

**(3) Cuentan desde que se instalan.** No hay historia hacia atrás: la respuesta de Costos trae desde cuándo cuenta cada uno (`counted_since`, como Inicio, D102), y la vista lo dice. Lo de antes sale como «sin desglose», nunca repartido con una estimación.

**(4) El origen `eval`.** Lo escriben las ejecuciones de evals cuando existan (D110). Hasta entonces la lista lo admite y nadie lo usa. Los contadores por agente siguen la regla de D104 (7): suman por el rol que llamó a Bedrock.

**(5) Opciones descartadas.** (b) Solo el origen, y «Por modelo» con el modelo actual de cada agente, marcado como aproximado: un agente que cambió de modelo se contaría mal todo el mes. (c) Las dos pestañas «Próximamente»: dejaba la vista sin la mitad del desglose teniendo los datos a mano.
