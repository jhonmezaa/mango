# D118 · Gráficas y tablas por un spec JSON cerrado, dibujadas por componentes propios

- **Estado:** vigente
- **Fecha:** 2026-11-07 (propuesta por un agente en el plan de capacidades del chat; ninguna de las preguntas del dueño de ese día la eligió por sí sola) · aceptada por el dueño el 2026-11-07, por menú: «Aceptar las cuatro (Recomendada)» · notas de la construcción W1, 2026-11-08, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07 · la construcción, punto 7, 2026-11-08, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07 (PR G1 + T1 del plan)
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

**(7) Cómo se construyó (G1 + T1, 2026-11-08; elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07).** Precisa los puntos 1, 2, 4 y 5:

- **El servidor lee y valida el spec.** La SPA no lee el `*.chart.json` ni el `*.table.json` del bucket: los pide a `GET /api/conversations/{id}/files/{archivo}/output` (`mango_api.chat_outputs`). La ruta exige lo mismo que una figura (la partición de la persona, `OwnConversation`, el escaneo limpio, el límite de 120 por minuto y la auditoría `chat.file_download` sin contenido). Lee como mucho 2 MB, valida con los modelos cerrados de Pydantic y devuelve siempre el spec normalizado, nunca el archivo. Los modelos salen en el OpenAPI y el cliente generado trae sus esquemas de zod.
- **El formato es el de Mango, con los valores por defecto del que copia** (rea-gaps §2.1). Una serie es `{key, label}`; `meta`, `{title, subtitle, footer}`; `axes`, `{x: {label}, y: {label}}`. También acepta los nombres del formato que copia (`dataKey`, `meta.description`, `axes` como lista con `dimension`, `xAxisLabel`). Solo pasan valores simples (texto, números finitos, booleanos), con los textos recortados. Más de 5.000 filas o de 20 series no se recortan: la gráfica no se dibuja («No se pudo dibujar esta gráfica…»).
- **El bloque ```` ```mango-chart ```` se dibuja donde lo escribió el agente**, en el texto. La SPA lo normaliza con las mismas reglas y lo valida al final con el esquema generado del servidor; mientras llega, «Cargando la gráfica…». Sus textos son parte de la respuesta, que ya revisa el guardrail del turno (D39).
- **`ApplyGuardrail` sobre los textos de una gráfica o una tabla**, como las celdas (TM-CI5). Lo hace `mango-api`, que gana `bedrock:ApplyGuardrail` sobre el guardrail base y nada más, en su política de los archivos del chat (`Mango-<ns>-ApiChatFiles`, en el anidado `Sandbox`): la política inline del rol está al límite y otra sentencia crearía una política de desborde, un recurso más en `Core` (D99). Se pregunta una vez por archivo: el «pasa» se guarda en el registro del archivo. Si interviene, si no responde o si hay más de 100.000 caracteres de texto, no se muestra y no se guarda nada: «Mango no muestra esta gráfica: infringía una regla de seguridad.».
- **La tabla muestra 200 filas, sin grilla virtualizada.** Es el tope del diseño de la ronda 40: el servidor manda las primeras 200, con el total. Precisa el punto 5.
- **El CSV de la tabla lo escribe `display_table`** en la carpeta de trabajo, con todas las filas: `<nombre>.csv`, o `<nombre>-table.csv` si ya hay otro archivo con ese nombre que no escribió él. Toda celda de texto que empiece por `=`, `+`, `-`, `@`, tabulador o retorno lleva `'` delante. El JSON lo nombra, y la SPA lo empareja por nombre dentro de la misma celda: la tarjeta va al pie de la tabla y no se repite tras ella.
- **«Copiar datos»** copia la columna x y una columna por serie, con las etiquetas de las series como cabecera (una tarta, solo su serie). Los números van en el locale del navegador sin separador de miles. Los textos llevan la misma defensa contra fórmulas, y sus tabuladores y saltos de línea pasan a espacios.
- **Recharts 3.10.1** (y `react-is`, que pide). Va en el chunk de `ChartView`, que se carga solo con una gráfica: unos 420 KB, 118 KB comprimido, fuera del `vendor` inicial. Se comprobó en un build de producción servido con la CSP de CloudFront, dibujando barras, líneas, tarta, puntos y el bloque del texto: ninguna violación nueva y ningún `<style>` insertado. Recharts escribe estilos solo por el CSSOM y nunca usa `innerHTML`.
- **El rol de un archivo de una celda** (`role`: `file`, `figure`, `chart` o `table`) va aparte de su extensión (`kind`). El conector guarda el rol en `kind`, y el bloque lo leía como extensión: en una instalación, una figura no habría salido como imagen.
- **Estados que el diseño no dibuja**, para la próxima ronda de Claude Design (D24):
  - la gráfica o la tabla retenidas por el guardrail;
  - el fallo al leerlas, con «Reintentar»;
  - la tabla que no se puede mostrar;
  - una gráfica o una tabla bloqueadas por el escaneo o que ya no están, que muestran la tarjeta de su archivo, como una figura.

  Además, como en el diseño, una gráfica sin título no tiene cabecera, así que tampoco «Copiar datos».

## Notas de la construcción (W1, 2026-11-08; elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07)

El bloque «Analizando» y la tarjeta de archivo de la ronda 40 están construidos ([D114](D114-code-interpreter-detras-del-gateway.md) (14), [D116](D116-archivos-del-chat.md) (13)). La gráfica y la tabla (G1 y T1 del plan) llevarán al pie la misma tarjeta para su CSV, con sus estados: no cambia nada de esta decisión.

