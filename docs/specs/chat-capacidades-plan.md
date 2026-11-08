# Capacidades del chat (código, gráficas, archivos, documentos, UI interactiva, memoria): plan de implementación (v0.1)

> Fecha: 2026-11-07 · Estado: **decisiones del dueño tomadas (12, por menú, el 2026-11-07); D114–D125 registradas en P0 y todas vigentes (2026-11-07)**.
> Origen: el dueño pidió que el chat de Mango tenga lo que tiene el de ChatGPT: ejecución de código, gráficas, PDF, Word, Excel, PowerPoint, chats interactivos, «básicamente todo». Antes de este plan se hizo una investigación de ingeniería inversa del chat de ChatGPT (cuatro informes, más el análisis con REA de su JavaScript público) y cuatro investigaciones de AWS y del repo. Los informes viven fuera del repo, en la carpeta local del laboratorio; §10 resume qué dicen.
> Decisiones afectadas: D13, D16, D23, D24, D25, D26, D39, D57, D58, D63, D69, D70, D73, D78, D86, D87, D88, D90, D92, D93, D98; reglas 1, 3, 4, 5 y 7 de `AGENTS.md`.

## 1. Punto de partida

Lo que existe hoy en `main` (`0a6a7d85`):

| Área | Estado |
|---|---|
| Turno de chat | `POST /api/chat` (`apps/api/src/mango_api/app.py`): Cedar `UseAgent`, reserva de presupuesto (D73, más el costo de las búsquedas de KB), una sesión del runtime por conversación (D39), `InvokeHarness` con una sola tool `remote_mcp` al Gateway (`harness.py:284`). El turno vive dentro de la petición HTTP |
| Stream | 9 eventos SSE propios (`conversation`, `status`, `delta`, `tool`, `knowledge`, `approval`, `remote_connection_required`, `done`, `error`; D57), sin `id:`. La web los valida con zod (`apps/web/src/api/chatEvents.ts`) y su parser ignora `id`/`retry` (`sse.ts`): no hay reanudación |
| Turnos largos | Un agente admite hasta 600 s; un despliegue drena 120 s (D70 (6)) y corta lo que dure más. CloudFront (60 s entre paquetes) y el ALB (120 s de inactividad) no cortan gracias al `: ping` cada 15 s |
| Pintado | `ChatMarkdown.tsx`: `react-markdown` + `remark-gfm`, `skipHtml`, imágenes bloqueadas, «no Mermaid, KaTeX or other plugins». Sin librería de gráficos |
| Código | Nada. Los agentes no tienen `shell` ni `file_operations` (D26, D92 (2)). El boundary de agentes no permite acciones de Code Interpreter |
| Archivos | Descarga prefirmada de 5 min con `Mango-<ns>-Presign` solo para los PDF de tareas (D86); subida prefirmada solo a knowledge bases (D88 (9), (33)). En el compositor, «Adjuntar» es «Próximamente» (`ChatInput.tsx:67`) |
| Documentos | Solo el PDF de tareas: datos validados y ReportLab en una Lambda zip (D87) |
| Memoria | Desactivada a propósito (D13: «Harness con `Memory: Disabled`»). D103 busca en las conversaciones propias |
| UI interactiva | Ninguna. CSP de la SPA en `infra/lib/constructs/edge.ts:321-372`: `script-src 'self'`, `img-src 'self' data:`, sin `frame-src` (cae en `default-src 'self'`), `require-trusted-types-for 'script'`, `trusted-types 'none'` |
| MCP remotos | Solo lectura, perfil firmado, esquema fijo (D93); el Gateway solo deja pasar `initialize`, `ping`, `tools/list` y `notifications/*` (D98 (16)) y borra `_meta` (D93 (8)) |

## 2. Prueba y resultados de la investigación

### 2.1 Prueba en una instalación (2026-11-07)

Autorizada por el dueño por menú («Sesión del CI del sistema»). Una sesión efímera del Code Interpreter del sistema (`aws.codeinterpreter.v1`) en la instalación del cliente, solo comandos de lectura, parada al terminar. No se creó ningún recurso.

| Pregunta | Resultado |
|---|---|
| Entorno | arm64, Amazon Linux 2023, usuario sin privilegios, 2 vCPU, 8 GB, 9,7 GB de disco. Arranque de sesión 1,9 s; celdas de 0,3 a 1,4 s |
| Librerías | Python 3.12 con pandas 2.3, numpy, matplotlib 3.9, seaborn, plotly, polars, duckdb, pyarrow, openpyxl, XlsxWriter, python-docx, python-pptx, ReportLab 4.2, pypdf, pypdfium2, pdfplumber, markitdown, pillow (285 paquetes) |
| Binarios | **Sin LibreOffice**, pandoc, tesseract, wkhtmltopdf, ffmpeg ni ghostscript. **Con** Poppler (`pdftoppm`), ImageMagick `convert`, Node y Deno. 95 fuentes (Noto Sans, Droid Sans con CJK, árabe y hebreo, URW) |
| Red y credenciales | Sin internet, metadatos 401, sin credenciales de AWS |
| Figuras | `plt.show()` devuelve solo `<Figure …>` en texto. `savefig` + `readFiles` devuelve el PNG como `resource.blob` con `mimeType: image/png` |
| Conclusión | Análisis, gráficas, PDF y archivos de Office se generan en el sandbox. **El render visual de Word, Excel y PowerPoint no es posible ahí** (sin LibreOffice, y el Code Interpreter no admite imagen propia). PDF → PNG sí |

### 2.2 Lo que dice la documentación (resumen)

- **Code Interpreter:** sesión con estado hasta 8 h (`sessionTimeoutSeconds` es un TTL, por defecto 900 s), Python/JS/TS y shell, archivos de hasta 100 MB por llamada, red `SANDBOX`/`PUBLIC`/`VPC`. Cuotas: 1000 sesiones y **30 TPS de `InvokeCodeInterpreter` por cuenta** (ajustables). Precio 0,0895 USD/vCPU-h y 0,00945 USD/GB-h por segundo; tope de una sesión 7,07·10⁻⁵ USD/s. CloudFormation: `AWS::BedrockAgentCore::CodeInterpreterCustom`, todas sus propiedades salvo `Tags` exigen reemplazo; CDK 2.271 trae L1 y L2. El AWS CLI no tiene `invoke-code-interpreter` (se usa boto3).
- **Tool integrada del harness** (`agentcore_code_interpreter`): existe, pero sus resultados en el stream son solo `text`/`json`, corre con el rol del agente, no pasa por Cedar y `mango-api` no puede leer la sesión. Por eso el dueño eligió el conector detrás del Gateway (§3, punto 1).
- **Segundo origen:** `cloudfront.net` está en la Public Suffix List: una segunda distribución es **otro sitio registrable** y sirve en la PoC sin dominio propio. Sin dominio no hay subdominios por app: el aislamiento entre apps va por un iframe interior de origen opaco. Response Headers Policy: CSP de hasta 1.783 caracteres, 20 políticas por cuenta.
- **Malware:** GuardDuty Malware Protection for S3 escanea al crear el objeto, admite CMK y deja la etiqueta `GuardDutyMalwareScanStatus` para cerrar el acceso con TBAC hasta `NO_THREATS_FOUND`. 100 GB por objeto y 25 buckets protegidos por región y cuenta.
- **Turnos largos:** el corte real es el drenaje de un despliegue y que el turno vive dentro de la petición.

### 2.3 Lo que se copia del cliente de ChatGPT (observado con REA)

- **Gráficas:** un spec JSON (`chartType` `bar|line|pie|scatter`, `data`, `xKey`, `series`, `axes`, `meta`, `valueFormat` `compact|integer|raw`), validado con zod tolerante (`.loose()` + `.catch()`), dibujado con Recharts. Copia como TSV con defensa contra fórmulas (`'` delante de `= + - @`). Sin límite de filas: Mango pone uno.
- **Bloque «Analizando»:** estados `running`, `completed`, `error` y `paused`, con sus reglas; stdout y stderr seguidos del mismo stream se juntan; imágenes por referencia, nunca en base64 dentro del stream.
- **Enlaces a archivos del sandbox:** prefijo fijo, ≤ 4096 caracteres, sin `.`, `..`, `/` final ni caracteres de control, decodificación iterativa hasta un punto fijo (4 rondas). La descarga responde `{download_url} | {status:"retry"} | {status:"error"}`; reintento de 10 intentos o 15 s, 500 ms × 1,6, tope 4 s.
- **Stream:** `event: delta_encoding` `"v1"`, deltas `{c, p, o, v}` con canal, ruta JSON Pointer, operaciones `add`, `replace`, `remove`, `append`, `truncate` y `patch`, herencia de `c`/`p`/`o` (nunca `v`), bloqueo de `__proto__`, `constructor` y `prototype`. Reanudación con token y offset: 12 reintentos, 300 ms × 1,5, tope 5 s, jitter del 50 %, reintento ante 408, 409, 425, 429, 502 y 504.
- **Sandbox de UI:** doble iframe en un origen aparte, `init` con `initId` aleatorio, validación de `source`, `origin` y del conjunto exacto de puertos, RPC por `MessageChannel` (`CALL/RESOLVE/REJECT/ABORT`), tiempos de 20, 30 y 50 s; CSP del iframe interior que solo se endurece.
- **No se copia:** la tabla interactiva de DataFrames (no está en el cliente actual; probablemente retirada), los editores nativos de documentos (ChatGPT Work, Slides) y el DIL.

## 3. Decisiones del dueño (2026-11-07, por menú)

| # | Pregunta | Elegido |
|---|---|---|
| 1 | Dónde corre el sandbox de código | **Conector detrás del Gateway** (Recomendada): Lambda de Mango como target, identidad de la persona, Cedar L2, presupuesto, sesión por persona y conversación |
| 2 | Alcance del plan | **Todo detallado**: las seis fases PR a PR |
| 3 | Pruebas en AWS | **Sesión del CI del sistema** (Recomendada); resultado en §2.1 |
| 4 | Turnos largos | **Trabajador desde el inicio**: el turno corre fuera de la petición desde la primera versión |
| 5 | Verificación visual de Office | **Lambda-contenedor con LibreOffice** (Recomendada): tool `render_document` detrás del Gateway, imagen de la release |
| 6 | Archivos del chat | **20 × 100 MB, 90 días** (el diseño dibuja 5 × 25 MB: hay que corregirlo en Claude Design) |
| 7 | Malware | **Sí: subidas y generados** (Recomendada) |
| 8 | Dominio del segundo origen en producción | **Dominio registrable aparte** (Recomendada); en la PoC, una segunda distribución `*.cloudfront.net` |
| 9 | Memoria | **AgentCore Memory por usuario** |
| 10 | MCP Apps | **Solo lectura, `ui://` curado en el perfil** (Recomendada) |
| 11 | Formato del stream | **Migrar a parches JSON** |
| 12 | Claude Design | **Brief por fase, al empezarla** (Recomendada) |

## 4. Decisiones a registrar (P0)

Se registran en `docs/architecture/decisions/`, con su línea en §8 y el cuerpo de la arquitectura en el mismo cambio. Nacen `vigente` las que eligió el dueño (D114, D116, D117, D120 a D123 y D125). D115, D118, D119 y D124 no salían de ninguna de sus respuestas y nacieron `propuesta`; el dueño las aceptó el 2026-11-07, por menú: «Aceptar las cuatro (Recomendada)». Los puntos de «cómo» que propone este plan llevan la marca «propuesto por un agente» y se aceptan en la revisión de P0.

| ID | Título | Precisa o contradice |
|---|---|---|
| **D114** | Los agentes ejecutan código en un Code Interpreter propio de la instalación, detrás del Gateway | Precisa la regla 1 (el código del modelo corre en un sandbox aislado, no en la aplicación; sin `pip`/`npm`, solo lo preinstalado y lo que trae la release), D26 y D92 (2) (ejecución de código sin `shell` en el harness), D90 (3) (el bloque del chat es contenido de la conversación, no Actividad), D16 (código y salida solo en la tabla de conversaciones o en S3) |
| **D115** | Presupuesto del sandbox: reserva por tiempo de cómputo | Precisa la regla 4 y D73 (una tool que se cobra por tiempo) |
| **D116** | Archivos del chat: bucket propio, 20 × 100 MB, 90 días, escaneo de malware | Precisa D88 (25) (el escaneo deja de ser «más adelante»), D86 (1) y (5) (vía nueva, aparte de los reportes), la CSP (`img-src blob:`) |
| **D117** | Render de Office en una Lambda-contenedor con LibreOffice, de la release | Precisa D87 (2) (que evitó imágenes de contenedor para los reportes) y D58 (imagen en el ECR del proveedor) |
| **D118** | Gráficas y tablas por spec cerrado, dibujadas por componentes propios | Ninguna regla cambia (JSON, nunca código ni HTML); D24 |
| **D119** | Skills de documentos con helpers firmados en la release | Precisa D26 («las skills con scripts solo vienen en la release») y D92 (2) («sin scripts») |
| **D120** | El stream del chat pasa a parches JSON (`v1`) sobre mensajes con `recipient` y `channel`, numerados y reanudables | Reemplaza el formato de eventos de D57 (las fases del turno se conservan como datos del mensaje); precisa D39 (el guardrail entrega trozos) |
| **D121** | El turno corre en un trabajador fuera de `mango-api` | Precisa D70 (6) (un despliegue ya no corta los turnos) y D78 (2) (las ejecuciones de tareas pasan por el mismo trabajador) |
| **D122** | Memoria de AgentCore por persona | **Contradice D13** («`Memory: Disabled`»); aplica R4/TM-007 (namespaces por persona y tests de aislamiento), D23 (los administradores no leen memorias) y D16 |
| **D123** | Segundo origen para código no confiable y espejo de dependencias en la release | Precisa D25 y D69 (el espejo viaja en la release, por contenido), D15 (una distribución más), la CSP (`frame-src`) y la excepción `CKV_AWS_174` (también para la segunda distribución mientras use `*.cloudfront.net`) |
| **D124** | Canvas: documentos y código editables junto al chat, con vista previa en el segundo origen | Precisa la regla 1 (transpilar en el navegador de la persona no es compilar en la cuenta) |
| **D125** | MCP Apps de solo lectura con su interfaz curada en el perfil firmado | Precisa D98 (16) (el Gateway sigue sin `resources/read`: el HTML viene del perfil) y D93 (3) y (8) (`_meta.ui` curado en el perfil, no del servidor ni del modelo) |

## 5. Arquitectura objetivo

```
SPA (CSP sin cambios salvo img-src blob: y frame-src del sandbox)
 │  POST /api/chat → {conversation_id, turn_id}
 │  GET  /api/chat/turns/{turn}/stream?after=<offset>   (SSE delta_encoding v1, reanudable)
 ▼
mango-api ──encola──► SQS Mango-<ns>-ChatTurns ──► mango-turn-worker (ECS, misma imagen, protección de tarea mientras corre un turno)
 │   lee los eventos del turno                          │  autoriza, reserva, InvokeHarness, traduce a parches v1
 ▼                                                      ▼
DynamoDB Conversations: TURN#<turn>#EVT#<seq> (TTL)  ◄──┘  y el mensaje final
                                                        │
                       harness ──remote_mcp──► Gateway ──► interceptor (firma, _mango_ctx)
                                                        ├─► code-interpreter (Lambda) ──► Code Interpreter Mango_<ns>_sandbox (SANDBOX, sin rol)
                                                        │        sesión por (persona, conversación); salidas → S3 chat-files
                                                        ├─► render-document (Lambda contenedor, LibreOffice) ──► PDF/PNG → S3 y de vuelta al sandbox
                                                        └─► packs y MCP remotos (como hoy)
S3 Mango-<ns>-chat-files (CMK, 90 días, GuardDuty Malware Protection, TBAC) ──► URL prefirmada 5 min (Mango-<ns>-Presign)
AgentCore Memory (namespace por persona) ◄── harness (D122)
CloudFront 2 (sandbox: runner, /vendor/ con el espejo; CSP propia) ◄── iframe desde la SPA (Canvas, MCP Apps)
```

## 6. Fases y PR

Tamaños: S (~300 líneas), M (~1.000), L (más). Todas pasan `mise run lint`, tipos y tests; las de infra, además `synth`, `guard` y `checkov`. Las de web aplican `security-best-practices` (React) y `vercel-react-best-practices`. Las que tocan IAM, trusts, Gateway o auth pasan `security-audit` (guía). Cada PR que registra o precisa una decisión actualiza en el mismo cambio el cuerpo de la arquitectura y la página de draw.io que toque.

### Fase 0 — Decisiones y modelos de amenazas

| PR | Qué | Tamaño | Depende de |
|---|---|---|---|
| **P0** | D114–D125 en `docs/architecture/decisions/` y §8; cuerpo de la arquitectura (§3 diagrama, §4.1, §4.2, §4.3, §4.13, «Estado de lo construido»); páginas «vista general» y «flujo de un turno» del draw.io | M (docs) | — |
| **P1** | Modelos de amenazas nuevos con `security-threat-model`: `code-interpreter-threat-model.md`, `chat-files-threat-model.md`, `turn-worker-threat-model.md` | M (docs) | P0 |

### Fase 1 — Trabajador de turnos y stream v1 (D120, D121)

Va primero: el sandbox alarga los turnos y el formato del stream cambia para todo lo demás.

| PR | Qué | Tamaño | Depende de | Claude Design |
|---|---|---|---|---|
| **R0** | **Hecha el 2026-11-07** (D121 (9)): la protección de tarea de ECS detiene un despliegue mientras un turno corre; cortar el stream de `InvokeHarness` no corta el turno y la sesión guarda la respuesta, así que tras un turno interrumpido la conversación pasa a una sesión nueva (D121 (7)) | — | P0 | — |
| **R1** | Infra: cola `Mango-<ns>-ChatTurns` (CMK, DLQ), servicio `mango-turn-worker` (misma imagen, otro punto de entrada, 2 tareas, sin balanceador), permisos (los del turno, que hoy tiene `mango-api`) | M | R0 | — |
| **R2** | Dominio del turno en `mango-core` o en un módulo compartido: el camino de `POST /api/chat` sale de la petición; `mango-api` autoriza, valida y encola; el trabajador reserva, invoca y escribe eventos `TURN#<turn>#EVT#<seq>` (TTL 4 h) y el mensaje final. Las ejecuciones de tareas (D78) pasan por el mismo camino | L | R1 | — |
| **R3** | Protocolo v1 en el servidor: mensajes `{id, author.role, recipient, channel, content_type, content, status, metadata}`, deltas `{c,p,o,v}`, `GET /api/chat/turns/{turn}/stream?after=` desde cualquier tarea, heartbeat con un test que lo fije por debajo del `readTimeout` de CloudFront | L | R2 | — |
| **R4** | Web: aplicador de parches (herencia, `truncate`, bloqueo de claves peligrosas, inmutable), reanudación con backoff, reducer de mensajes, mock de dev reescrito, estado «Reconectando» | L | R3 | **Ronda 1**: «Reconectando», turno interrumpido |
| **R5** | Retirada del formato antiguo de eventos y de su código en el cliente | S | R4 | — |

### Fase 2 — Sandbox de análisis, figuras, gráficas y archivos (D114–D116, D118)

| PR | Qué | Tamaño | Depende de | Claude Design |
|---|---|---|---|---|
| **C1** | Infra: `CodeInterpreterCustom` `Mango_<ns>_sandbox` (modo `VPC` en una VPC propia sin salida ni DNS tras T5, D114 (11); sin rol de ejecución, tags del stack) en el anidado `Sandbox` (D99); bucket `Mango-<ns>-chat-files` (CMK, `RETAIN`, TLS, versionado con versiones viejas a 1 día, `uploads/` a 1 día, 90 días, deny por `s3:signatureAge`); plan de GuardDuty Malware Protection con etiqueta; TBAC; el rol Presign gana `uploads/` y `owner/` de ese bucket | M | P1 | — |
| **C2** | **Hecha el 2026-11-08** (un PR con C3; D114 (13)), sin integrar hasta repetir T5 en una instalación. Conector `connectors/code-interpreter/`: tools `run_python`, `list_files`, `read_file`; verifica token y firma; sesión por (persona, conversación) en DynamoDB con el `sessionId` cifrado y nunca devuelto; bootstrap (`/mnt/data` lógico, `Agg`, módulo de display con un nombre no registrable en PyPI); tras cada celda, `listFiles` + `readFiles` de las salidas → S3; respuesta al modelo solo texto con tope; corte propio de 300 s; uso medido y auditoría `code.execute` (nunca el código). Target `code` del Gateway y política Cedar L2 | L | C1 | — |
| **C3** | **Hecha el 2026-11-08**, con C2 (D115 (7); sin la casilla del Builder, que es de W1). Dominio: capacidad `code_interpreter` en `AgentDefinition`, Builder (API), firma y `allowedTools` en `mango-api` y el provisioner; reserva `_code_reserve` con precios del catálogo (regla 7) y liquidación medida (D115) | M | C2 | Builder (casilla) |
| **C4** | Trabajador: mensajes `recipient: "code.run_python"` y su resultado (`aggregate_result` propio: estado, stdout/stderr con tope, excepción, imágenes y archivos por id) | M | C2, R3 | — |
| **C5** | Archivos: `GET /api/conversations/{id}/files/{file}/content` (imágenes como `blob:`), `POST …/download` (prefirmada 5 min, `attachment`, tipo de una lista cerrada, auditada, 60 por persona y hora), validador de rutas en el servidor con las reglas de §2.3; CSP `img-src 'self' data: blob:` | M | C1, C4 | — |
| **W1** | Web: bloque «Analizando → Analizado» (estados y agrupación de §2.3), código plegable, STDOUT/STDERR, figuras con ampliar y descargar, tarjeta de archivo, enlaces `mango-file:` en `safeUrl.ts` | L | C4, C5 | **Ronda 2**: bloque, figura, tarjeta, errores |
| **G1** | Gráficas: esquema en Pydantic exportado al cliente, límites (5.000 filas, 20 series), `Chart.tsx` lazy con Recharts (dependencia justificada; comprobar con la CSP real que no usa `innerHTML`), bloque ```` ```mango-chart ```` validado y `*.chart.json` escrito por el sandbox desde los datos calculados; copia TSV con defensa contra fórmulas; formato con el locale de la persona | M | W1 | **Ronda 2** (gráfica) |
| **T1** | Tablas: helper `*.table.json` en la sesión, grilla virtualizada con tope de filas y descarga del CSV | M | W1 | **Ronda 2** (tabla) |

### Fase 3 — Adjuntos y documentos (D116, D117, D119)

| PR | Qué | Tamaño | Depende de | Claude Design |
|---|---|---|---|---|
| **U1** | **Hecho en el servidor (2026-11-08, D116 (11))** y **el compositor en la web (U1-web, 2026-11-08, D116 (12); PR abierto)**: la subida, el escaneo, la descarga, las imágenes y los adjuntos del turno en `mango-api`, y la función que guarda el escaneo; la hidratación con `writeFiles` la hace C2 (D114 (13)); el compositor de la ronda 40 (20 archivos, progreso, «Revisando el archivo…», «Enviar» que espera, arrastrar, historial con «Ya no disponible») y `AgentOut.capabilities`; falta la ruta de borrar una conversación. Subida al chat: `POST /api/conversations/{id}/uploads` (patrón D88 (9)/(33): POST prefirmado, clave del servidor, `content-length-range`, tipo exacto, firma de bytes), 20 × 100 MB, `ChatRequest.attachments` por id; nada llega al sandbox hasta `NO_THREATS_FOUND`; hidratación de la sesión con `writeFiles`; el compositor deja de ser «Próximamente» | L | C2, C5 | **Ronda 3**: compositor 20 × 100 MB, «Revisando el archivo» |
| **D1** | Lambda-contenedor `render-document` (LibreOffice headless con perfil por proceso, fuentes fijadas, arm64), imagen construida en el CI de la release y publicada en el ECR del proveedor (D58); target del Gateway: recibe un archivo por id, devuelve PDF y PNG por página a S3 y al sandbox | L | C2 | — |
| **D2** | Skills de documentos (instrucciones, D92): `pdf`, `docx`, `xlsx`, `pptx`, con el bucle crear → renderizar → mirar → corregir; helpers firmados en la release, copiados a la sesión; lista cerrada de extensiones de salida (sin HTML, SVG, macros ni ejecutables) | M | D1 | — |
| **D3** | El modelo ve sus renders: prueba de si una imagen en el resultado MCP del Gateway llega al modelo; si no, alternativa documentada (descripción por un paso de visión del propio trabajador) | M | D1, R0 | — |

### Fase 4 — Memoria (D122)

| PR | Qué | Tamaño | Depende de | Claude Design |
|---|---|---|---|---|
| **M0** | Modelo de amenazas `memory-threat-model.md` y prueba de aislamiento de namespaces (R4/TM-007) en AWS, si el dueño la autoriza | M | P0 | — |
| **M1** | Infra: AgentCore Memory de la instalación, estrategias (preferencias, hechos, resumen), por persona y agente; el harness la usa solo con el `actorId` de quien pregunta, que arma el servidor, y falla cerrado sin él (D122 (8)). **Construido apagado el 2026-11-08** (D122, notas de construcción): se enciende tras M0 | M | M0 | — |
| **M2** | API: listar, editar y borrar las memorias propias; borrado al dar de baja a una persona; auditoría sin contenido. **Construido apagado el 2026-11-08** salvo editar | M | M1 | — |
| **M3** | Web: «Memoria» en Ajustes, indicador en el chat cuando se usa | M | M2 | **Ronda 4** |

### Fase 5 — Segundo origen y Canvas (D123, D124)

| PR | Qué | Tamaño | Depende de | Claude Design |
|---|---|---|---|---|
| **V0** | Modelo de amenazas `ui-sandbox-threat-model.md` y pruebas en AWS (dos distribuciones son dos sitios, CSP de 1.783, `.wasm` con su tipo, Worker y Pyodide en origen opaco, canales de salida del iframe interior por navegador) | M | P0 | — |
| **V1** | Infra: segunda distribución con OAC a un bucket de la release, Response Headers Policy propia (`frame-ancestors` por CloudFront Function + KeyValueStore para no cerrar un ciclo entre las dos distribuciones), CORS en `/vendor/*`, `frame-src` en la CSP de la SPA; con dominio propio, alias comodín y validación del `Host` | L | V0 | — |
| **V2** | Espejo: script de build que fija versiones y sha256 (React, Recharts, esbuild-wasm, Babel, `@tailwindcss/browser`, núcleo de Pyodide con numpy, pandas y matplotlib; ~100 MB), empaquetado en la release; `.wasm` como `application/wasm` con un test | M | V1 | — |
| **V3** | Runner del sandbox: doble iframe, handshake y RPC de §2.3, CSP interior que solo se endurece, límites de tamaño en el RPC | L | V2 | — |
| **K1** | Canvas: tool `textdoc.create/update/comment`, versiones en DynamoDB y contenido en S3, «mostrar cambios», exportación (.md, .docx y PDF por `render-document`), vista previa de React/HTML y Python en el navegador | L | V3, D1 | **Ronda 5** |

### Fase 6 — MCP Apps (D125)

| PR | Qué | Tamaño | Depende de | Claude Design |
|---|---|---|---|---|
| **A1** | Perfil firmado con `_meta.ui` curado (HTML con hash, CSP declarada); el pipeline de la release verifica el hash; el interceptor sigue borrando el `_meta` del modelo | M | V3 | — |
| **A2** | Host MCP Apps (`@modelcontextprotocol/ext-apps`) en el runner: `ui/initialize`, `tool-input`, `tool-result`, `request-display-mode`; las `tools/call` de la app vuelven por el Gateway con Cedar y presupuesto, solo lectura | L | A1 | **Ronda 6** |

### Olas en paralelo

0: P0, después P1 · 1: R0–R2 y C1 · 2: R3, C2 · 3: R4, C3, C4 · 4: R5, C5, W1, D1 · 5: G1, T1, U1, D2, M0 · 6: D3, M1–M3, V0 · 7: V1–V3 · 8: K1, A1, A2.

Choques de archivos: `app.py` (R2, C3, U1: en ese orden); `chatEvents.ts`, `chatState.ts` y el mock (R4 los reescribe; W1, G1 y T1 van después); `edge.ts` (C5, V1).

## 7. Seguridad

- **Modelos de amenazas** antes de construir: código (P1), archivos (P1), trabajador (P1), memoria (M0), sandbox de UI (V0). La skill `security-threat-model` los escribe; los riesgos aceptados se consultan con el dueño.
  - Escritos en P1 (2026-11-07): [`code-interpreter-threat-model.md`](../security/threat-models/code-interpreter-threat-model.md) (TM-CI1–CI12), [`chat-files-threat-model.md`](../security/threat-models/chat-files-threat-model.md) (TM-CF1–CF9) y [`turn-worker-threat-model.md`](../security/threat-models/turn-worker-threat-model.md) (TM-TW1–TW10). Fijan cuatro supuestos (por menú, el 2026-11-07): el trabajador usa el access token de la persona, cifrado en el mensaje de la cola; lo que muestra el bloque «Analizando» pasa por `ApplyGuardrail`; C2 no se integra hasta que la prueba T5 diga si la red `SANDBOX` deja salir a S3 ajeno; borrar una conversación o dar de baja a una persona borra sus archivos y para su sesión del Code Interpreter.
  - Escritos en M0 y V0 (2026-11-07, sin la prueba en AWS, que sigue pendiente de autorización): [`memory-threat-model.md`](../security/threat-models/memory-threat-model.md) (TM-ME1–ME10) y [`ui-sandbox-threat-model.md`](../security/threat-models/ui-sandbox-threat-model.md) (TM-UI1–UI12). Sus supuestos los fijó el agente que los escribió con la opción recomendada, por delegación expresa del dueño del 2026-11-07, y quedan en [D122](../architecture/decisions/D122-memoria-de-agentcore-por-persona.md) (8), [D123](../architecture/decisions/D123-segundo-origen-para-codigo-no-confiable.md) (8) y [D125](../architecture/decisions/D125-mcp-apps-de-solo-lectura.md) (6): memoria por persona y agente con un `actorId` del servidor y fallo cerrado, sin memoria en tareas, evals y Playground; iframe interior de origen opaco sin más red que el espejo; MCP Apps con una lista cerrada de métodos. Sus riesgos residuales quedan pendientes de aceptación del dueño.
- **El `sessionId` del Code Interpreter es la única barrera entre personas dentro del mismo recurso** (IAM no acota por sesión): nunca llega al modelo, al navegador ni a los logs.
- **Sin credenciales en el código:** el Code Interpreter va sin rol de ejecución; todo movimiento de archivos lo hace la Lambda con `writeFiles`/`readFiles` (tope de 100 MB por llamada).
- **Inyección indirecta con ejecución:** un adjunto puede pedir al modelo que empaquete otros archivos. La sesión es por persona y conversación, sin red, y cada archivo generado lleva su origen en la tarjeta.
- **Archivos hostiles:** lista cerrada de extensiones, `attachment` siempre, tipo decidido por el servidor, comprobación por bytes, escaneo de malware antes de entregar.
- **El guardrail no revisa el código ni la salida que se muestran:** pasan por `ApplyGuardrail` antes de mostrarse (TM-CI5, C4).
- **Segundo origen:** `unsafe-eval` solo dentro del sandbox; un test impide que la distribución de la SPA sirva el runner; la CSP de la SPA no gana `unsafe-eval` ni pierde Trusted Types; el iframe interior es de origen opaco y solo llega al espejo; el host manda al sandbox solo lo que hay que dibujar (TM-UI1–UI4).
- **Memoria:** por persona y agente, con el `actorId` que arma el servidor y fallo cerrado sin él; tests de aislamiento, borrado completo al dar de baja, los administradores no la leen, tampoco en las trazas (TM-ME1, ME4, ME5).

## 8. Pruebas en AWS pendientes (cada una con autorización del dueño)

Todas en la instalación del cliente solo si el dueño lo autoriza por menú; recursos temporales con prefijo `mango-probe-`, borrados en la misma tarea.

| # | Qué confirma | PR |
|---|---|---|
| T5 | Si la red `SANDBOX` deja subir a un bucket ajeno (exfiltración); C2 no se integra sin su resultado (TM-CI3). **Hecha el 2026-11-07**, con el visto bueno del dueño, desde el CI del sistema: S3 de la región responde (HTTP 307); S3 de otra región, STS, DynamoDB e internet, no. Mitigación: modo `VPC` sin salida ni DNS (D114 (11)); falta repetirla desde el CI de Mango en una instalación | C1 |
| T6/T7 | Nombre de la tool en `allowedTools` y sesión del CI que usa el harness (solo para cerrar la comparación) | — |
| R0 | Protección de tarea de ECS frente a un despliegue; sesión del harness tras cortar el stream. **Hecha el 2026-11-07** (D121 (9)) | R0 |
| G | Imagen en el resultado MCP del Gateway: ¿la ve el modelo? | D3 |
| L | Tiempo máximo de una llamada del Gateway a un target Lambda (60, 180, 300 s) | C2 |
| M | Aislamiento de namespaces de AgentCore Memory | M0 |
| W | Dos distribuciones como dos sitios, CSP de 1.783 caracteres, `.wasm`, Pyodide en origen opaco | V0 |
| GD | GuardDuty Malware Protection con CMK y TBAC | C1 |

## 9. Riesgos

- **30 TPS de `InvokeCodeInterpreter` por cuenta:** cada celda son de 1 a 3 llamadas; con muchas personas hay que pedir aumento y encolar.
- **Coste de sesiones ociosas:** la memoria se cobra mientras la sesión vive; TTL corto (15–30 min) y parada explícita.
- **Reescritura del stream (D120):** toca todo el chat y el mock; R5 no se integra hasta que R4 lleve una semana instalado sin regresiones.
- **El trabajador cambia la ruta crítica del chat:** R2 mantiene los mismos tests de extremo a extremo del chat antes de mover nada.
- **Imagen de contenedor nueva (D117):** otra pieza en el ECR del proveedor y en la verificación de la release.
- **Dependencias del espejo:** ~100 MB por versión en la release; versiones fijas con sha256.
- **Diseño:** el compositor de 20 × 100 MB difiere del diseño actual (5 × 25 MB): se corrige primero en Claude Design (D24).

## 10. Fuentes

Informes locales del laboratorio (fuera del repo, no versionados):
- Investigación del chat de ChatGPT: sandbox y gráficas, documentos, UI interactiva, protocolo con tres chats de prueba, síntesis.
- Investigaciones para el plan: Code Interpreter (API, IAM, CloudFormation, harness frente a Gateway, costos), infraestructura web del sandbox y de archivos, mapa del repo frente a las capacidades, y el análisis con REA del JavaScript ya descargado.
- La prueba de §2.1.

Documentación oficial: AgentCore Code Interpreter (tool, gestión de recursos, integración con S3, filesystems, librerías preinstaladas, cuotas, precios), harness (tools, seguridad, entorno, hooks), CloudFront (cuotas, response headers policies, Functions, OAC), GuardDuty Malware Protection for S3, especificación MCP Apps 2026-01-26.
