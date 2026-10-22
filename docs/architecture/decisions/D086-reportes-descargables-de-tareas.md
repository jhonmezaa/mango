# D86 · Reportes descargables de las tareas: un PDF por ejecución, generado en una Lambda de la release

- **Estado:** vigente
- **Fecha:** 2026-10-19 (los nueve puntos, tomados por el dueño ese día, por menú, todos con la opción «(Recomendada)»); 2026-10-21 (punto 10, el rol que firma los enlaces, elegido por el dueño ese día; nota propuesta por un agente)
- **Precisa / reemplaza a:** precisa [D78](D078-tareas-sin-chat.md) (lo que entrega una ejecución) y [D79](D079-investigacion-de-anomalias-por-evento.md) (lo que entrega la investigación de una anomalía)
- **Precisada por:** [D87](D087-como-se-construyen-los-reportes.md) (2: ReportLab en el zip de la función, con IBM Plex; 6: la tool interna es una `inline_function` del harness y la serie diaria sale de la consulta cuando se puede)

## Decisión

Origen: la parte D del brief unificado del 2026-10-16, que la ronda de Claude Design del 2026-10-16b dibujó entera (editor, detalle, resultado, Bandeja, auditoría y las plantillas `Reporte de tarea.html`). En el producto, hoy solo está la casilla «Reporte descargable» del editor, como «Próximamente» (D24). **Esta decisión no construye nada:** fija cómo se construirá.

**(1) Formato: solo PDF.** Un solo estado y un solo límite, y no lleva código activo. Sin HTML.

**(2) Dónde se genera: una Lambda propia, empaquetada en la release.** El motor de PDF y las fuentes van dentro del artefacto de la release; nada se compila ni se descarga en runtime ([D25](D025-recursos-creados-en-runtime.md)). La función es asíncrona, con DLQ (la regla de Checkov `CKV_AWS_116` aplica) y un rol mínimo: leer los datos de esa ejecución y escribir su PDF. Nunca se genera en la SPA: el reporte debe ser el mismo que ve y audita el servidor. Tampoco en `mango-api`.

**(3) Almacén: un bucket S3 propio de la instalación.** `Mango-<ns>-…`, con CMK, `RETAIN`, acceso solo por TLS, prefijo por dueño de la tarea y ciclo de vida que borra cada PDF a los 90 días («se guarda hasta el {fecha}»).

**(4) Descarga: URL prefirmada de 5 minutos.** La emite `mango-api` solo al dueño de la tarea (L1 `OwnTask`); un administrador ve que el PDF está listo, sin botón ([D82](D082-tareas-para-cualquiera-y-lo-que-ve-un-admin.md)). Cada descarga se audita (`schedule.report_download`: tarea, ejecución y archivo), nunca con el contenido. La URL no va a los logs.

**(5) Cuándo se pide: es una opción de la tarea.** La casilla «También un PDF · {tipo}» del editor, apagada por defecto. Desde el chat, por ahora no.

**(6) Cómo entrega el agente los datos: con una tool interna validada.** Recibe `cost_summary` o `anomaly` con su esquema, no cuenta en «Pasos» y el servidor calcula las variaciones. Las series se toman, cuando se pueda, de la respuesta de cada tool por su id de llamada, no de lo que copie el modelo. Lo que entrega el modelo se trata como no confiable.

**(7) Tipos: dos, fijos por disparador.** Una tarea por horario da «Resumen de costos»; una por anomalía, «Investigación de anomalía».

**(8) Límites y nombre: los del diseño.** 10 MB por PDF, 25 filas por tabla (el resto en «Otros»), 400 días de serie, 4.000 caracteres de notas y 280 por texto corto. El archivo se llama `{tarea}-{fecha}-{hhmm|id corto}.pdf`.

**(9) Modelo de amenazas antes de construir.** Con `security-threat-model`, en `docs/security/threat-models/`. Cubre los datos estructurados que entrega un modelo y llegan a un renderizador, las URLs prefirmadas y las fuentes incrustadas.

**(10) Las URLs se firman con un rol propio (2026-10-21, nota propuesta por un agente; el arreglo lo eligió el dueño ese día).** GuardDuty marcó con severidad 8 `UnauthorizedAccess:IAMUser/ResourceCredentialExfiltration.OutsideAWS` en la instalación del cliente. El caso fue la subida de una knowledge base ([D88](D088-knowledge-bases-sobre-s3.md) (33)), pero la descarga de este PDF firmaba igual.

Una URL prefirmada lleva la sesión de quien la firma (`x-amz-security-token`). Firmada con las credenciales de la tarea ECS de `mango-api`, su uso desde el navegador son credenciales de un recurso usadas fuera de AWS.

Ahora:
- `mango-api` asume `Mango-<ns>-Presign` por STS, una sesión de 30 minutos por persona con `SourceIdentity` = el dueño de la tarea (regla 5), y firma solo con ella (`mango_api.presign`).
- El rol solo hace `GetObject` bajo `owner/` de este bucket, con su llave a través de S3 (además de las subidas de D88).
- Su trust solo admite al rol de la tarea de `mango-api` y exige `SourceIdentity`.
- El rol de la tarea ya no puede leer ningún PDF.
- Sin el rol de firma no se emite enlace (503), nunca con la sesión de la tarea.
- El enlace sigue durando 5 minutos, y el bucket sigue negando firmas más viejas.

