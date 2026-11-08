# D118 · Gráficas y tablas por un spec JSON cerrado, dibujadas por componentes propios

- **Estado:** vigente
- **Fecha:** 2026-11-07 (propuesta por un agente en el plan de capacidades del chat; ninguna de las preguntas del dueño de ese día la eligió por sí sola) · aceptada por el dueño el 2026-11-07, por menú: «Aceptar las cuatro (Recomendada)» · notas de la construcción W1, 2026-11-08, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07
- **Precisa / reemplaza a:** — (ninguna regla cambia: el modelo solo produce datos JSON, nunca código ni HTML que se ejecute en la SPA); respeta [D24](D024-diseno-de-la-ui.md)
- **Precisada por:** —

## Decisión

Origen: el plan de capacidades del chat ([`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md)), que copia del cliente de ChatGPT el formato de sus gráficas (§2.3 del plan).

**(1) Un spec cerrado.** Una gráfica es un JSON con `chartType` (`bar`, `line`, `pie` o `scatter`), `data`, `xKey`, `series`, `axes`, `meta` y `valueFormat` (`compact`, `integer` o `raw`). El esquema vive en Pydantic en el servidor y se exporta al cliente, que lo valida con zod tolerante: un campo desconocido se ignora y uno inválido cae a su valor por defecto. Límites: 5.000 filas y 20 series.

**(2) De dónde sale.** Se prefiere el `*.chart.json` que escribe el sandbox ([D114](D114-code-interpreter-detras-del-gateway.md)) desde los datos calculados, como los reportes sacan su serie de la consulta ([D87](D087-como-se-construyen-los-reportes.md)). Un bloque ```` ```mango-chart ```` en el texto del modelo también se acepta, validado con el mismo esquema.

**(3) Quién la dibuja.** Un componente propio, cargado a pedido, con Recharts. Es una dependencia nueva: el PR que la añade la justifica y comprueba con la CSP real que no usa `innerHTML` (Trusted Types). Nunca se pinta código ni HTML del modelo; el Markdown sigue sin HTML crudo.

**(4) Copiar los datos.** Como TSV, con defensa contra fórmulas: una celda que empieza por `=`, `+`, `-` o `@` lleva `'` delante. Los números se formatean con el locale de la persona.

**(5) Tablas.** El sandbox escribe un `*.table.json`; la SPA lo pinta en una grilla virtualizada con tope de filas y ofrece el CSV como archivo del chat ([D116](D116-archivos-del-chat.md)).

**(6) Diseño.** La gráfica, la tabla y sus estados salen de la ronda de Claude Design de esa fase ([D24](D024-diseno-de-la-ui.md), [D114](D114-code-interpreter-detras-del-gateway.md) (10)).

## Notas de la construcción (W1, 2026-11-08; elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07)

El bloque «Analizando» y la tarjeta de archivo de la ronda 40 están construidos ([D114](D114-code-interpreter-detras-del-gateway.md) (14), [D116](D116-archivos-del-chat.md) (13)). La gráfica y la tabla (G1 y T1 del plan) llevarán al pie la misma tarjeta para su CSV, con sus estados: no cambia nada de esta decisión.

