# D115 · Presupuesto del sandbox de código: se reserva el tiempo de cómputo antes del turno y se liquida con lo medido

- **Estado:** vigente
- **Fecha:** 2026-11-07 (propuesta por un agente en el plan de capacidades del chat; ninguna de las preguntas del dueño de ese día la eligió por sí sola) · aceptada por el dueño el 2026-11-07, por menú: «Aceptar las cuatro (Recomendada)»; cómo se mide y se liquida, punto 7, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07, el 2026-11-08 (PR C2 del plan)
- **Precisa / reemplaza a:** precisa la regla 4 de `AGENTS.md` y [D73](D073-turno-cortado-nunca-cuesta-cero.md) (una tool que se cobra por tiempo de cómputo; con su punto 7, un turno retenido guarda el coste medido de sus tools); usa la regla 7 (precios como configuración)
- **Precisada por:** —

## Decisión

Origen: el sandbox de [D114](D114-code-interpreter-detras-del-gateway.md) se cobra por segundo de vCPU y de memoria mientras la sesión vive. La regla 4 pide reservar antes de invocar una tool, así que el turno debe reservar también su tiempo de sandbox. Plan: [`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md).

**(1) Reserva antes del turno.** La reserva del turno suma, a la del modelo y a la de las búsquedas de knowledge bases, la del sandbox: `celdas como mucho × 300 s × precio por segundo (vCPU + GB) + arranque de una sesión nueva`. Las celdas como mucho son el menor de `max_iterations` y un tope de celdas por turno. Solo la reservan las versiones con la capacidad `code_interpreter`.

**(2) Precios como configuración (regla 7).** Los precios por vCPU-hora y por GB-hora del Code Interpreter van en el catálogo, como el de los embeddings de las knowledge bases; nunca en el código.

**(3) Liquidación con lo medido.** La Lambda mide cada celda y escribe su uso (turno, segundos, estado), ligado a la firma de la invocación como `kb.retrieve` liga su auditoría. Al cerrar el turno se suma lo medido. Lo que no se sabe se retiene y se concilia: «no sé lo que costó» nunca se registra como «no costó nada» ([D73](D073-turno-cortado-nunca-cuesta-cero.md)).

**(4) Sesiones ociosas.** El tiempo en que la sesión vive sin celdas se carga al turno que la abrió o la prolongó. La vida corta de [D114](D114-code-interpreter-detras-del-gateway.md) (4) lo acota.

**(5) Ámbitos y Playground.** Persona y agente, como el chat; en el Playground, los mismos ([D91](D091-playground.md) (3)), con una sesión nueva por prueba que se cierra al terminar.

**(6) Orden de magnitud.** Una celda de 300 s con 2 vCPU y 8 GB cuesta unos 0,02 USD a precios de lista de 2026-11; ocho celdas al tope, unos 0,17 USD, comparable a un turno largo de modelo.

**(7) Cómo se mide y se liquida (elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07, el 2026-11-08, PR C2 del plan).**
- **El modelo de coste.** AWS cobra la memoria de una sesión mientras vive, ociosa o no, y la CPU solo mientras trabaja. Por eso una sesión nueva carga al turno que la abrió su vida entera (30 minutos × 8 GB, punto 4) y cada celda, sus segundos × 2 vCPU. Es una cota que nunca se queda corta.
- **La reserva (`_code_reserve`).** `min(max_iterations, 8)` celdas × 300 s de CPU, más una sesión nueva: una sesión vive más que cualquier turno, así que un turno abre como mucho una. Con los precios de la release (0,0895 USD/vCPU-h y 0,00945 USD/GB-h), unos 0,16 USD con ocho celdas. El conector rechaza la novena celda de un turno. Una versión que ejecuta código no se sirve, ni se prueba en el Playground o en evals, sin precios; tampoco pasa las reglas al enviarse a revisión (`code_interpreter_unavailable`).
- **La medida.** El conector escribe la fila de la celda antes de ejecutarla, con la vida de la sesión si la abrió, y al terminar, sus segundos (redondeados hacia arriba). Una celda que nunca escribe su final cuenta su corte entero.
- **La liquidación.** Al cerrar el turno, `mango-api` (o el trabajador) lee las filas del turno de la partición de la persona y suma su coste al del modelo y las búsquedas. Si no se pueden leer, se cobra lo más que un turno puede ejecutar (8 celdas y una sesión). Un turno retenido (D73) cobra igualmente lo medido del código: el registro pendiente guarda ese coste (`tool_cost`) y el conciliador lo suma a los tokens que lee, así que el cierre final nunca lo pierde (precisa [D73](D073-turno-cortado-nunca-cuesta-cero.md)). La auditoría `agent.completed` lleva `code_usd`.
