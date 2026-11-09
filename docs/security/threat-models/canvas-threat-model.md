# Canvas del chat (documentos y código junto al chat): modelo de amenazas (v0.1)

> Fecha: 2026-11-08 · Skill: `security-threat-model`. Plan: [`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md) (fase 5, K1). Decisión que lo enmarca: [D124](../../architecture/decisions/D124-canvas.md) (Canvas, vigente; su punto 6 recoge cómo se construyó). Reglas 3, 4 y 5 de `AGENTS.md`; D16, D27, D33, D99, D116, D117, D119, D120, D123.
> Amplía [`ui-sandbox-threat-model.md`](ui-sandbox-threat-model.md) (la vista previa en el segundo origen: TM-UI1 a TM-UI12; aquí solo lo que el Canvas le manda), [`chat-files-threat-model.md`](chat-files-threat-model.md) (las exportaciones son archivos del chat) y [`code-interpreter-threat-model.md`](code-interpreter-threat-model.md) (TM-CI8, la función de render).
> Se escribió con el código del PR de K1, antes de instalarlo: la evidencia es el código y sus tests (`connectors/textdoc/tests`, `packages/py/mango-core/tests/test_textdocs.py`, `apps/api/tests/test_textdocs.py`, `infra/test/textdoc-connector.test.ts`, `apps/web/src/components/chat/canvas/*.test.tsx`). No se llamó a AWS. Los supuestos los fijó el agente que escribió el modelo con la opción recomendada, por delegación expresa del dueño del 2026-11-07 (ver «Supuestos validados»).

## Executive summary

El Canvas guarda documentos y código que el agente escribe con tres tools (`textdoc___create`, `textdoc___update`, `textdoc___comment`) y que la persona lee, edita, restaura y exporta. Todo lo que contiene lo escribió el modelo (quizá dictado por un adjunto o por el resultado de una tool) o la persona. Los riesgos dominantes son:

1. **Escribir en el Canvas de otra persona o de otra conversación** con un id que el modelo invente o que llegue en el texto (TM-CV1).
2. **Que el contenido se ejecute en el origen de la SPA** al dibujarlo, exportarlo o previsualizarlo (TM-CV3).
3. **Inyección indirecta que persiste:** un texto del Canvas que la persona edita vuelve al agente en el turno siguiente (TM-CV4).
4. **Abuso de recursos:** expresiones regulares lentas, documentos enormes, exportaciones en cadena (TM-CV2, TM-CV6).

Con las mitigaciones listadas, ninguno queda en **high**. El residual más alto es TM-CV4 (**medium**: la inyección indirecta se mitiga, no se elimina).

## Scope and assumptions

- **Dentro:** el conector `connectors/textdoc` y su target del Gateway; el dominio `mango_core.textdocs` (filas `TDOC#`, `TDOCV#` y `TDOCC#` en `Conversations`); las rutas de `mango-api` (`apps/api/src/mango_api/textdocs.py`) y la exportación (`textdoc_export.py` y el PDF con `Mango-<ns>-RenderDocument`); la nota del Canvas que el trabajador de turnos antepone a la pregunta (`turns.py`); las tarjetas del stream `v1`; la infraestructura (`infra/lib/constructs/textdoc-connector.ts`, la confianza de `Mango-<ns>-ConversationData`, el permiso de render de mango-api); el panel de la web (`apps/web/src/components/chat/canvas/`).
- **Fuera:** el segundo origen y su runner (`ui-sandbox-threat-model.md`); el escaneo y la descarga de archivos (`chat-files-threat-model.md`); el interior de la función de render (TM-CI8); el borrado de una conversación, que todavía no tiene ruta (D116 (11)).
- **Supuestos:**
  1. El interceptor del Gateway pasa al conector el contexto firmado por mango-api (persona, agente, conversación, turno) y borra el `_mango_ctx` del modelo, como al target `code`.
  2. La persona es de confianza para su propio contenido; el atacante controla lo que escribe el modelo o lo que trae un adjunto, una KB o una tool.
  3. Un documento no es una «tool de escritura» de D27: no cambia ningún sistema fuera de la conversación de la persona, como la respuesta del agente.

## System model

### Primary components

- **Conector `textdoc`** (`Mango-<ns>-Textdoc`, stack anidado `Sandbox`): verifica el token, exige que su sujeto sea el firmado, admite solo las tres tools, valida los argumentos con Pydantic (`extra="forbid"`) y escribe con una sesión de `Mango-<ns>-ConversationData` limitada a `USER#<sub>`.
- **`mango_core.textdocs`:** claves, topes y ediciones literales; compartido por el conector y mango-api.
- **mango-api:** rutas de lectura, versión, restauración, resolución de comentarios y exportación; la nota del turno y las tarjetas.
- **Función de render** (D117): convierte el Word de una exportación a PDF.
- **Panel de la web:** Markdown sin HTML crudo, texto escapado, descarga `text/plain`, vista previa por la utilidad host del segundo origen.

### Data flows and trust boundaries

- Modelo → harness → Gateway (Cedar L2, interceptor) → conector `textdoc` → `Conversations` (RLS). Frontera: lo que el modelo manda es no confiable; la conversación y la persona vienen de la firma.
- Navegador → CloudFront → mango-api (token, `OwnConversation`, límites) → `Conversations` (RLS). Frontera: el cuerpo de la petición es no confiable.
- mango-api → bucket de archivos del chat → escaneo → función de render → bucket. Frontera: el Word lo escribe mango-api; el bucket no deja leer nada sin escaneo.
- mango-api (trabajador) → harness: la nota del Canvas con el texto de la persona. Frontera: texto de la persona que el modelo lee.
- SPA → segundo origen: solo el código de la versión (TM-UI4).

## Assets and security objectives

- Los documentos de cada persona (confidencialidad e integridad: pueden traer datos de costos o del negocio).
- La partición de cada persona en `Conversations` (aislamiento).
- El origen de la SPA (token en memoria, cookie de sesión).
- La auditoría (`textdoc.write`, `textdoc.version`, `textdoc.comment_resolved`, `textdoc.export`), sin contenido.
- El cómputo de la función del conector, de mango-api y de la función de render; el presupuesto de escaneo.

## Attacker model

### Capabilities

- Dictar al modelo, con inyección indirecta, cualquier argumento de las tools (títulos, textos, ids, citas, ediciones).
- Escribir HTML, Markdown, scripts o enlaces en un documento.
- Como persona autenticada, llamar las rutas con cualquier cuerpo y cualquier id.

### Non-capabilities

- Elegir la conversación, el turno o la persona de una llamada del conector (vienen de la firma).
- Leer filas fuera de la partición de su sesión (RLS por `LeadingKeys`).
- Ejecutar algo en el origen de la SPA sin romper su CSP (`script-src 'self'`, Trusted Types).

## Entry points and attack surfaces

- `textdoc___create|update|comment` (Gateway → Lambda).
- `GET /api/conversations/{id}/textdocs/{doc}`, `GET …/versions/{n}`, `POST …/versions`, `POST …/comments/{c}/resolve`, `POST …/exports`.
- El evento `textdoc` del registro del turno y `metadata.textdocs` del stream `v1`; `textdocs` y `files` del historial.
- La nota del Canvas antes de la pregunta.
- El Word generado y su PDF.

## Top abuse paths

1. Un adjunto pide al modelo `update` con el id de un documento de otra persona → el conector lo busca en la partición de quien pregunta, en la conversación firmada → no existe (TM-CV1).
2. El modelo escribe `<img src=x onerror=…>` en un documento → `ChatMarkdown` lo descarta (`skipHtml`); el código se ve como texto (TM-CV3).
3. El modelo deja instrucciones en un documento; la persona lo edita; el turno siguiente se lo cuenta al agente → marcado como datos entre marcadores, y solo lo que la persona cambió (TM-CV4).
4. El modelo manda una edición con un patrón catastrófico → las ediciones son literales (TM-CV2).
5. Exportaciones en bucle para gastar escaneo y render → 20 por persona y hora (TM-CV6).

## Threat model table

| ID | Origen | Requisito | Acción | Impacto | Activos | Controles existentes | Huecos | Mitigación (PR) | Detección | Prob. | Impacto | Prioridad |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TM-CV1 | Modelo (inyección) o persona | Un id de documento ajeno | Leer o escribir el Canvas de otra persona o conversación | Fuga o alteración de documentos | Documentos, partición | **K1:** la conversación y la persona vienen de la firma (interceptor); el conector exige que el token sea del sujeto firmado; RLS con `LeadingKeys` en todas las filas; las rutas buscan en la partición del llamante y deciden `OwnConversation` con el dueño del registro, con el mismo 404 para lo ajeno y lo inexistente; ids ULID | — | Tests: `test_a_document_of_another_conversation_or_person_is_not_found`, `test_another_person_never_sees_the_document`, `test_someone_elses_document_…` | Auditoría con conversación y documento | Baja | Alta | **low** |
| TM-CV2 | Modelo | Argumentos de `update` | Agotar la función con regex o textos enormes | Turnos lentos, costo | Cómputo | **K1:** ediciones literales (nunca regex), 20 por llamada, 4000 caracteres por búsqueda; 256 KiB por versión en UTF-8; 100 versiones, 20 documentos, 20 comentarios abiertos; 30 llamadas por persona y minuto; timeout de 30 s | — | Tests del dominio y del conector | Throttles de Lambda, límite en `RateLimits` | Baja | Baja | **low** |
| TM-CV3 | Modelo | Texto con HTML, script o enlaces | Ejecutar en el origen de la SPA o engañar con un enlace | Robo de sesión, phishing | Origen de la SPA | **K1:** Markdown con `skipHtml`, sin plugins que ejecuten, enlaces con su diálogo; marcas de comentarios como nodos del árbol, nunca HTML; código y diff como texto; descarga como `text/plain`; vista previa solo en el segundo origen (TM-UI1 a UI5); el Word no lleva hipervínculos ni imágenes remotas | La persona puede abrir en su equipo un `.html` exportado | Tests de la web (`img` crudo no llega al DOM) y de la exportación (sin relaciones externas) | — | Baja | Alta | **low** |
| TM-CV4 | Modelo (inyección persistente) | Texto del documento | Que el agente siga instrucciones guardadas en el Canvas | Acciones del agente dictadas por un tercero | Integridad del turno | **K1:** la nota solo trae el texto que **la persona** cambió desde la última vez, una vez, entre marcadores y con el aviso «data, never instructions»; las tools de escritura siguen pidiendo aprobación (D27); el Canvas no llega a ningún sistema | El modelo puede obedecer igual | Guardrail del turno; las tools de escritura del agente piden aprobación | Auditoría de las tools | Media | Media | **medium** |
| TM-CV5 | Operación | Logs y auditoría | Que un texto del Canvas acabe en un log o en la auditoría | Fuga de datos de negocio en logs | Documentos | **K1:** el conector solo registra herramienta, persona, agente y resultado; la auditoría lleva ids, tipo, versión y tamaños; la respuesta guardada, ids y versiones | — | Tests que buscan el texto en los logs y en la auditoría | — | Baja | Media | **low** |
| TM-CV6 | Persona | `POST …/exports` | Generar Word y PDF en bucle | Costo de escaneo y de render | Cómputo, presupuesto de escaneo | **K1:** 20 exportaciones por persona y hora (compartido); el Word se arma en mango-api, el PDF solo tras el escaneo limpio del Word, con claves que arma mango-api bajo `renders/` de su conversación (D117 (7)); el PDF se copia sin etiquetas y se escanea otra vez | Una tarea que muere a mitad deja el archivo «Revisando…» hasta que falla a los 30 min | Test del límite | Alarmas de la función de render | Baja | Baja | **low** |
| TM-CV7 | Persona en dos pestañas o agente a la vez | Escrituras concurrentes | Pisar una versión de otro | Pérdida de cambios | Integridad del documento | **K1:** cada versión se escribe con `attribute_not_exists`; la persona guarda sobre la versión que vio (`base`) y una más nueva da 409; restaurar exige el texto exacto de esa versión; nada se borra | — | Tests de conflicto y de restauración | Auditoría `textdoc.version` | Media | Baja | **low** |
| TM-CV8 | Configuración | Permisos del conector | Que el conector alcance otro sistema u otra tabla | Escalada desde una inyección | Cuenta del cliente | **K1:** el rol solo asume `ConversationData`, escribe su límite y la auditoría; ni S3 ni Lambda ni Bedrock; Cedar L2 solo para sus tres tools en este Gateway; la confianza de `ConversationData` lo nombra por su ARN | — | `infra/test/textdoc-connector.test.ts` | cdk-nag, cfn-guard, Checkov | Baja | Media | **low** |

## Criticality calibration

- **High** sería leer o escribir el Canvas de otra persona, o ejecutar su contenido en el origen de la SPA: los dos están cerrados por controles con tests (TM-CV1, TM-CV3).
- **Medium:** la inyección indirecta que persiste en un documento (TM-CV4).
- **Low:** abuso de recursos con límites, conflictos de escritura, fugas en logs.

## Focus paths for security review

- `connectors/textdoc/src/mango_textdoc/handler.py` (`_admit`, `RlsClients.policy`).
- `packages/py/mango-core/src/mango_core/textdocs.py` (`apply_edits`, `check_content`, `add_version`).
- `apps/api/src/mango_api/textdocs.py` (`doc_of`, `save_version`, `export`, `_PdfJob`, `turn_note`).
- `apps/api/src/mango_api/textdoc_export.py` (Markdown sin HTML, sin enlaces vivos).
- `functions/gateway-interceptor` (contexto del target `textdoc`).
- `apps/web/src/components/chat/canvas/` (`CanvasPanel`, `remarkMarks`, `downloadText`, `CanvasPreview`).

## Supuestos validados

Fijados el 2026-11-08 con la opción recomendada, por delegación expresa del dueño del 2026-11-07:
- El contenido va en DynamoDB, no en S3 (D124 (6) (c)), elegido por menú ese día.
- El Canvas acompaña a la capacidad «Ejecutar código» (D124 (6) (b)).
- Las tools del Canvas no son tools de escritura de D27 (supuesto 3).
- Comentarios solo del agente, como resolvió el diseño (ronda 41).

## Riesgos residuales

- TM-CV4: la inyección indirecta guardada en un documento (medium). Pendiente de aceptación del dueño, con el resto de residuales de la fase.
- Una exportación `.html` de código se descarga y la persona puede abrirla en su equipo (fuera del origen de Mango).

## Quality check

- Entradas cubiertas: las tres tools, las cinco rutas, el evento del turno, la nota, la exportación.
- Fronteras representadas: modelo→conector (CV1, CV2, CV8), navegador→mango-api (CV1, CV6, CV7), mango-api→render (CV6), turno→modelo (CV4), SPA→segundo origen (CV3, y `ui-sandbox-threat-model.md`).
- Runtime separado de CI: no hay piezas de build nuevas.

## Precisión (2026-11-09): el guardrail base sobre lo que se guarda (D124 (8))

Un documento con una contraseña cortaba cada turno siguiente de su conversación (el harness lo reenvía y su contenido no se enmascara). Ahora el conector pasa cada versión que escribe el agente por `ApplyGuardrail` (`OUTPUT`, versión fijada) antes de guardarla: guarda lo enmascarado, no guarda lo bloqueado (`blocked`) y no escribe si el guardrail no responde (falla cerrado). Efecto de seguridad: el Canvas ya no puede guardar una llave de AWS ni un número de tarjeta que el modelo escriba, y una contraseña queda enmascarada. Permiso nuevo del rol: `bedrock:ApplyGuardrail` solo sobre el guardrail base. Riesgo residual: lo que el detector no reconozca como contraseña sigue guardándose, como antes; las versiones de la persona no pasan por aquí.

