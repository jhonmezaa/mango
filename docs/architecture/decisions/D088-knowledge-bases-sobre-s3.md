# D88 · Knowledge bases: una entidad compartida entre agentes, con documentos de S3

- **Estado:** vigente
- **Fecha:** 2026-10-21 (los puntos 1 a 6, tomados por el dueño ese día, por menú; el cómo, puntos 7 a 17, propuesto por un agente; las respuestas del dueño a sus ocho preguntas, puntos 18 a 26, tomadas ese día, por menú; aceptada por el dueño ese día, por menú: «Aceptar D88 (Recomendada)»; lo que mostró la prueba técnica previa, punto 27, nota de ese día propuesta por un agente; lo construido de los recursos fijos, punto 28, nota de ese día propuesta por un agente, con el cifrado de los vectores elegido ese día por menú; lo construido del registro, punto 29, nota de ese día propuesta por un agente; lo construido de la subida, punto 30, nota de ese día propuesta por un agente; el ciclo de la plantilla, punto 31, nota de ese día propuesta por un agente; lo construido de la sincronización, punto 32, nota de ese día propuesta por un agente; el rol que firma las subidas, punto 33, elegido por el dueño ese día, nota propuesta por un agente; 2026-10-22: los permisos de la ingesta directa, punto 34, diagnosticados por el dueño ese día en la instalación, nota propuesta por un agente; lo construido de la asociación con agentes en la API, punto 35, nota de ese día propuesta por un agente)
- **Precisa / reemplaza a:** precisa [D26](D026-reglas-del-ciclo-de-vida.md) (la alerta de las knowledge bases: qué significa cuando el filtro sale de quien pregunta) y [D25](D025-recursos-creados-en-runtime.md) (el primer caso de KB: sin stacks de CloudFormation en ejecución); toma el diseño de §4.4
- **Precisada por:** —

## Decisión

Origen: el hito «Knowledge bases», abierto por el dueño el 2026-10-21. **Esta decisión no construye nada:** fija qué se construye y cómo. Modelo de amenazas: [`knowledge-bases-threat-model.md`](../../security/threat-models/knowledge-bases-threat-model.md). Los puntos 1 a 6 los tomó el dueño; el cómo (7 a 17) lo propuso un agente con ocho preguntas, que el dueño contestó el mismo día (18 a 26), y aceptó la decisión entera.

### Lo que decidió el dueño (2026-10-21, por menú)

**(1) Primera versión: solo S3.** Confluence, Google Drive y GitHub quedan como «Próximamente» en la pantalla.

**(2) Dos maneras de traer documentos.** Subida desde el navegador con URL prefirmada, como bedrock-chat (prefijo temporal; al guardar, a la carpeta de la KB; después, la sincronización). Y buckets S3 que ya existen en la cuenta de la instalación (`s3_urls`), leídos con un rol limitado a ese ARN.

**(3) Las URLs web (crawler y sitemap) quedan fuera.** URLs web: para evaluar más adelante (salida a internet, SSRF y contenido no confiable).

**(4) Crean y editan KBs los administradores y los creadores de agentes** (`mango-agent-creator`).

**(5) La KB es una entidad propia, compartida entre agentes.** Se asocia en el Agent Builder, con la alerta de [D26](D026-reglas-del-ciclo-de-vida.md).

**(6) Proceso como el del hito de tareas:** modelo de amenazas, decisiones aceptadas por el dueño, construcción, release e instalación con su OK.

### El cómo (propuesto por un agente, aceptado por el dueño el 2026-10-21)

**(7) Una sola base de conocimiento de Bedrock por perfil de indexación, sobre S3 Vectors** (§4.4, modelo *pooled*). En v1 hay un perfil: Titan Text Embeddings v2, 1024 dimensiones, chunking por defecto de Bedrock y su parser por defecto (un PDF escaneado sin texto queda «Sin texto legible»). Los recursos fijos son: el bucket de documentos `mango-<ns>-knowledge-…` (llave propia `alias/Mango-<ns>-knowledge`, `RETAIN`, solo TLS, sin ACL, bloqueo público, versiones no actuales borradas al día), un bucket vectorial y un índice de S3 Vectors, la base de Bedrock con un *data source* de tipo `CUSTOM`, su rol de servicio (lee solo `kb/*` de ese bucket e invoca solo el modelo de embeddings por ARN), la máquina de sincronización y la Lambda de la tool. **Una KB de Mango no crea ningún recurso de AWS:** es un registro y un prefijo `kb/<kb_id>/`. Así no cuenta contra las 100 bases por cuenta. Los recursos fijos nacen en la plantilla `Core` (18). El precio del modelo de embeddings va en el catálogo de modelos (regla 7).

**(8) Registro.** KB (`KB#<id>`, ULID: nombre, descripción, dueño, área, grupos, clasificación, estado, contadores), fuentes (`SRC#<id>`: `upload` o `bucket`, con ARN, prefijo y rol), documentos (`DOC#<doc_id>`, ULID: nombre mostrado, clave, tamaño, tipo, SHA-256, estado y motivo) y sincronizaciones (`SYNC#<id>`: quién, cuándo, cuántos, costo reservado y real). Vive en la tabla nueva `Mango-<ns>-Knowledge` (21). Estados de una KB: `pending` (nunca sincronizada), `syncing`, `ok`, `warn` (algún documento no se indexó), `error`, `deleting`. De un documento: `uploaded`, `indexing`, `indexed`, `failed` (con motivo: tipo no admitido, sin texto, demasiado grande, protegido), `deleting`.

**(9) Subida.** `POST /api/knowledge-bases/{id}/uploads` recibe nombre, tamaño y tipo de hasta 20 archivos y devuelve un POST prefirmado por archivo, de 15 minutos, con la clave exacta `uploads/<sub>/<subida>/<doc_id>` (la elige el servidor), `content-length-range` y `Content-Type` exactos. El prefijo `uploads/` se borra solo al día. Al guardar (`POST …/documents`), `mango-api` comprueba con `HeadObject` el tamaño, lee los primeros bytes para confirmar el tipo y copia el objeto a `kb/<kb_id>/docs/<doc_id>` (`CopyObject`, del lado del servidor); después arranca la sincronización. Tipos: PDF, DOCX, TXT, MD, CSV y XLSX. Hasta 50 MB por archivo, 1.000 documentos y 5 GB por KB. El nombre mostrado se guarda saneado y nunca forma parte de una clave. En v1 no se descarga el original desde Mango (supuesto 4 del modelo de amenazas).

**(10) Fuentes de bucket existente.** Se registran con `s3://bucket/prefijo/`. `mango-api` rechaza un bucket que no esté en la cuenta de la instalación (`HeadBucket` con `ExpectedBucketOwner`), uno de la instalación (`mango-<ns>-*`, los de access logs) y uno cifrado con una llave que el rol no puede usar (v1 admite SSE-S3 y la llave administrada `aws/s3`). El provisioner crea por SDK el rol `Mango-<ns>-kbsrc-<src>`, con el boundary `Mango-<ns>-kbsrc-boundary` (solo `s3:GetObject` y `s3:ListBucket`, solo con `s3:ResourceAccount` = la cuenta de la instalación, y un deny a los buckets de Mango) y una política con ese ARN y ese prefijo, nada más. Quien lo asume es la Lambda de sincronización, con `SourceIdentity` de quien sincroniza. La sincronización copia lo del bucket al bucket de documentos (19). La fuente la propone un creador y la aprueba un administrador distinto (20): el rol se crea solo después de la aprobación. Al quitar la fuente, el deprovisioner borra el rol (con la misma condición de boundary que D48 (7)).

**(11) Sincronización** (`Mango-<ns>-KnowledgeSync`, Step Functions y Lambda, por SDK, [D25](D025-recursos-creados-en-runtime.md)). Un lock por base de Bedrock (escritura condicional, patrón de bedrock-chat). Diff entre lo que hay (por clave y ETag) y lo indexado; ingesta incremental con `IngestKnowledgeBaseDocuments` y `DeleteKnowledgeBaseDocuments` en lotes de 25, al ritmo de la cuota (5 por segundo); estado por documento con `GetKnowledgeBaseDocuments`. Cada fragmento lleva `kb_id`, `business_unit` (el área de la KB, o `all`), `acl_groups` (los grupos de la KB al indexar) y `classification`, puestos inline en la ingesta directa desde el registro, nunca desde la ruta, el nombre ni el contenido (23). Antes de empezar estima los tokens por tamaño y **reserva contra el presupuesto de quien sincroniza** (regla 4; 24); al terminar concilia. Cuándo corre: al guardar documentos subidos; una fuente de bucket, a pedido y con la frecuencia del diseño (manual, cada 6 h, diaria, semanal) por EventBridge Scheduler en el grupo `Mango-<ns>-knowledge`. Una sincronización que encuentra otra en curso de la misma KB no arranca una segunda. Asíncrona con DLQ y alarma.

**(12) API de `mango-api`** (módulo `knowledge.py` y `knowledge_store.py`): listar y ver KBs; crear, editar (nombre, descripción, grupos, clasificación, frecuencia) y borrar; subidas y guardado; fuentes; sincronizar; documentos con su estado; «Probar búsqueda» (`POST …/search`, mismo filtro que la tool, con límite por persona, auditado y sin contar como consulta de un agente). Cada acción audita `kb.*` con ids y conteos, nunca contenido ni la consulta (solo su longitud).

**(13) Cedar L1, acciones nuevas:** `ViewKnowledgeBase` (creadores y administradores ven la lista; los documentos y la prueba, solo dueño, administradores y creadores en sus grupos), `CreateKnowledgeBase` (creadores y administradores), `EditKnowledgeBase` (su dueño mientras sea creador, o un administrador; el patrón de `agents-edit.cedar`), `ProposeKbSource` (dueño de la KB mientras sea creador, o un administrador) y `ApproveKbSource` (un administrador distinto de quien la propuso, 20) y `UseKnowledgeBase` (la persona está en algún grupo de la KB). En L2, la tool `knowledge-retrieve` se permite por tipo de usuario como las demás ([D33](D033-autorizacion-de-agentes-y-tools.md)).

**(14) La tool `knowledge-retrieve`.** Lambda target del Gateway (`connectors/knowledge-retrieve`), de clase `read`. El modelo solo da la consulta (hasta 1.000 caracteres) y, si quiere, un subconjunto de las KBs del agente. Las KBs del agente las firma `mango-api` en la invocación junto con sus tools y el interceptor las pasa a la tool. La tool valida el token de quien pregunta, lee del registro los grupos actuales de cada KB, se queda con las del agente que la persona puede usar y arma el filtro `andAll[kb_id ∈ permitidas, business_unit ∈ áreas de esas KBs]` (no se filtra por `acl_groups` de cada fragmento, 22). Con la lista vacía no llama a Bedrock. Devuelve hasta 8 fragmentos con KB, documento, página y puntaje, marcados como contenido de documentos y no como instrucciones, con un tope de tamaño. Límite por persona y alarma de throttling: `Retrieve` admite 20 por segundo para toda la cuenta. Cada llamada audita `kb.retrieve` (KBs pedidas, permitidas y devueltas, ids de fragmentos). El costo de la consulta va al presupuesto del turno.

**(15) Asociación en el Agent Builder.** La versión de un agente lleva `knowledge_bases` (hasta 5) y pasa por la revisión de [D18](D018-creacion-y-publicacion-de-agentes.md) como sus tools: el revisor ve qué KBs usa. El Builder solo ofrece las KBs que su autor puede usar. Una KB usada por un agente publicado no se borra: hay que quitarla antes de una versión. **La alerta de D26, precisada:** como la KB solo responde a quien está en sus grupos (supuesto 2 del modelo de amenazas, regla 5), un agente visible para grupos sin acceso a la KB no la expone: esas personas no reciben nada de ella. La alerta dice eso («Estos grupos usan el agente pero no reciben respuestas de esta knowledge base») en vez de «podrían ver su contenido».

**(16) Borrado.** Un documento, una fuente o una KB pasan a `deleting`: la máquina de sincronización borra los objetos, pide a Bedrock el borrado de sus documentos y **comprueba** con una consulta filtrada por `kb_id` (y por documento) que no queda ningún vector antes de marcarlo borrado. Un borrado que no se verifica en 6 horas salta una alarma. Los registros se borran al final; la auditoría queda.

**(17) Lo que queda «Próximamente»:** Confluence, Google Drive y GitHub (fuente y conector), las URLs web (para evaluar más adelante, 3), el tier premium (Managed KB), la descarga del original, las consultas de 30 días en la tabla si la métrica no llega en esta versión, el reranking, y los buckets de otras cuentas o cifrados con una llave propia. Lo que el diseño muestra sin backend se muestra así, sin datos de ejemplo ([D24](D024-diseno-de-la-ui.md)).

### Lo que decidió el dueño sobre el cómo (2026-10-21, por menú)

Las ocho preguntas que dejó abiertas la propuesta, con la opción que eligió el dueño.

**(18) Recursos fijos en la plantilla `Core`** («En la plantilla Core (Recomendada)»). La base de Bedrock, el bucket vectorial y su índice, el bucket de documentos, los roles, la máquina de sincronización y la Lambda de la tool vienen en `Core` desde la instalación, revisados por cdk-nag, cfn-guard y Checkov. En ejecución solo se crea, por SDK y con boundary, el rol de lectura de una fuente de bucket. Las KBs de Mango se crean por API (registro y prefijo), como pedía la nota del dueño: lo que nace con la plantilla es el recurso compartido de Bedrock.

**(19) Los buckets existentes se copian al bucket de Mango** («Copiar al bucket de Mango (Recomendada)»). La sincronización lee el origen con el rol de la fuente y copia a `kb/<kb_id>/docs/`; el rol de servicio de Bedrock solo lee el bucket de documentos. Un borrado en el origen se refleja en la sincronización siguiente.

**(20) Un bucket existente lo propone un creador y lo aprueba un administrador distinto** («Creador con aprobación de un admin»; no era la opción recomendada). La propuesta lleva el ARN y el prefijo exactos y queda «Pendiente de aprobación»; lo aprueba o rechaza un administrador que no sea quien la propuso, también cuando la propuso otro administrador (lo comprueba `mango-api`, como en la revisión de agentes). La aprobación vale solo para ese ARN y ese prefijo: cambiarlos es una propuesta nueva. Hasta aprobarla no se crea el rol ni se lee nada. Proponer, aprobar y rechazar se auditan con el ARN. La solicitud se ve en Aprobaciones y en la Bandeja de los administradores que pueden firmarla.

**(21) El registro vive en una tabla nueva `Mango-<ns>-Knowledge`** («Tabla nueva Knowledge (Recomendada)»), con la llave de datos de la instalación, `RETAIN`, `deletionProtection` y PITR. Escriben `mango-api` y la sincronización, fijados por IAM.

**(22) El acceso se decide por KB, no por fragmento** («No, se decide por KB (Recomendada)»). La tool filtra por `kb_id` (y `business_unit`) con los grupos actuales de cada KB, leídos en cada llamada: un cambio de grupos rige al instante y no reindexa. `acl_groups` y `classification` se guardan en cada fragmento para un ACL por documento futuro, sin usarlos para autorizar.

**(23) Los metadatos se ponen en la ingesta directa** («En la ingesta directa (Recomendada)»): inline en `IngestKnowledgeBaseDocuments` sobre el *data source* `CUSTOM`, desde el registro. Sin Lambda de transformación y nunca un `StartIngestionJob`.

**(24) Los embeddings van al presupuesto de quien sincroniza** («Al de quien sincroniza (Recomendada)»): en una sincronización por horario, al dueño de la KB. Con reserva previa, como un turno.

**(25) Sin escaneo de malware en v1** (el dueño: «por ahora no en v1»). Los documentos solo vuelven a una persona como fragmentos de texto. GuardDuty Malware Protection for S3: para evaluar más adelante; sería necesario si algún día se descarga el original.

**(26) La alerta de D26 cambia de sentido** («Sí, cambia el sentido (Recomendada)»): las personas de los grupos que usan el agente sin acceso a la KB no recibirán respuestas de esa KB (15). Anotado en [D26](D026-reglas-del-ciclo-de-vida.md).

**Prueba técnica previa.** Antes de construir, una prueba en la cuenta de Mango de la instalación del cliente, con recursos temporales `Mango-<ns>-kbprobe…` que se borran en la misma tarea (decidido por el dueño el 2026-10-21, por menú, con la opción recomendada; el nombre del cliente no va en el repositorio, D59): el filtro `in` sobre S3 Vectors, la ingesta directa con metadatos inline, el borrado y las cuotas reales.

**(27) Lo que mostró la prueba técnica previa (2026-10-21).** La hizo el dueño en la cuenta de Mango de la instalación del cliente, con recursos temporales que borró en la misma tarea. Confirmado:

- **Tipos de CloudFormation:** existen `AWS::S3Vectors::VectorBucket`, `AWS::S3Vectors::Index`, `AWS::Bedrock::KnowledgeBase` (con S3 Vectors) y `AWS::Bedrock::DataSource`: los recursos fijos en `Core` (18) son viables. El índice: 1024 dimensiones, float32, coseno, con `AMAZON_BEDROCK_TEXT` y `AMAZON_BEDROCK_METADATA` como claves no filtrables; su nombre necesita al menos 3 caracteres. La base, con Titan Text Embeddings v2 y un *data source* `CUSTOM`, quedó activa en unos 20 s.
- **Ingesta directa (23):** `IngestKnowledgeBaseDocuments` con el contenido en S3 (`S3_LOCATION`, con la cuenta dueña del bucket) y metadatos inline (`IN_LINE_ATTRIBUTE`) indexó documentos en 10 s o menos, sin Lambda de transformación.
- **Filtros de `Retrieve` (14):** `in` sobre `kb_id` devuelve solo esas KBs; `andAll[in kb_id, in business_unit]` funciona; una lista de 50 ids funciona; un id que no existe devuelve 0 resultados. **Una lista vacía no es «ningún resultado»: `Retrieve` la rechaza** (`ValidationException`, mínimo 1). Por eso la regla de (14) es obligatoria: si la persona no puede leer ninguna KB del agente, la tool responde sin resultados y **no llama a `Retrieve`**; nunca convierte el error en un reintento sin filtro.
- **Qué devuelve `Retrieve`:** el texto del fragmento, `location.type` = `CUSTOM` y los metadatos puestos en la ingesta, más el id del fragmento y del *data source*. No trae el nombre del documento: la ingesta pone también `doc_id` en los metadatos (lo necesita además la verificación del borrado de (16)) y la tool resuelve el nombre mostrado desde el registro. La página no se vio en esta prueba.
- **Borrado (16):** con `DeleteKnowledgeBaseDocuments`, el documento dejó de salir en `Retrieve` en 6 s o menos. La verificación de (16) se mantiene; su alarma de 6 horas tiene margen de sobra.
- **Cuotas reales de la cuenta:** `Retrieve`, 20 por segundo; `IngestKnowledgeBaseDocuments`, 5 por segundo, con 25 archivos y 6 MB de carga por llamada; 10 llamadas de ingesta o borrado a la vez; archivos de texto de hasta 50 MB; 100 bases por cuenta; consulta de hasta 1.000 caracteres. La sincronización (11) arma sus lotes por las dos cotas, 25 archivos y 6 MB, y no pasa de 10 llamadas a la vez; los 50 MB por archivo de (9) y los 1.000 caracteres de la consulta de (14) coinciden con la cuenta.

**(28) Estado de lo construido: los recursos fijos en `Core` (2026-10-21).** Construidos con tests, sin ver en una instalación, en `infra/lib/constructs/knowledge.ts` (el PR 1 del plan). Lo que precisa del texto de arriba:

- **Los vectores se cifran con la misma llave que los documentos,** `alias/Mango-<ns>-knowledge` (elegido el 2026-10-21 por menú: «Llave de knowledge (Recomendada)»; la prueba de (27) usó el cifrado por defecto). El texto de cada fragmento vive también en el índice. La política de la llave deja a `indexing.s3vectors.amazonaws.com` solo `kms:Decrypt`, solo para vectores de esta cuenta y con el contexto de cifrado de S3 Vectors; el rol de servicio la usa solo a través de S3 (documentos) y de S3 Vectors (vectores). Falta ver en la instalación que la base pase a `ACTIVE` y que la ingesta indexe con esta llave.
- **Nombres:** bucket vectorial `mango-<ns>-knowledge`, índice `titan-v2-1024`, base `Mango-<ns>-knowledge`, *data source* `Mango-<ns>-documents`, rol `Mango-<ns>-KnowledgeBase`. El bucket de documentos lleva el nombre que genera CloudFormation desde el stack (`mango-<ns>-core-knowledgedocuments…`), como los demás buckets de `Core`: con un nombre fijo, una instalación que se borra con los datos retenidos impediría volver a instalar el mismo *namespace*. Sigue cubierto por el deny `mango-<ns>-*` del boundary de fuentes.
- **El perfil de indexación es una constante de la plantilla** (`INDEXING_PROFILE`: Titan Text Embeddings v2, 1024): otro modelo es otro índice y otra base, no un ajuste. El precio de los embeddings entra al catálogo de modelos con la reserva de la sincronización (PR 4), que es quien lo usa.
- **Alarmas:** `Knowledge-retrieve-throttled` y `Knowledge-deletion-unverified` leen métricas `Mango/Knowledge/<ns>` que publicarán la tool (PR 5) y la sincronización (PR 4); la de la tabla sale como la de toda tabla (D71). La de la sincronización fallida llega con su máquina y su cola de errores (PR 4).
- **Lo que no hace todavía:** `mango-api` no tiene permisos sobre nada de esto, no hay funciones ni rutas, y la tabla no se lee ni se escribe.

**(29) Estado de lo construido: el registro, la API y Cedar (2026-10-21).** Construidos con tests, sin ver en una instalación (el PR 2 del plan): `apps/api/src/mango_api/knowledge.py` y `knowledge_store.py`, `mango_core.knowledge` (ids y estados, compartidos con la sincronización y la tool) y cuatro políticas en `policies/cedar/platform/knowledge-*.cedar`. Rutas en `/api/knowledge-bases`: listar, crear, ver, editar y `POST …/delete`. `mango-api` usa la tabla con una política administrada propia (`Mango-<ns>-ApiKnowledge`: leer, crear y actualizar, sin borrar ítems ni `Scan`). Lo que precisa del texto de arriba, propuesto por un agente:

- **Cedar (13):** la lista es `ViewKnowledgeBase` sobre la plataforma, para administradores y creadores (con `CreateKnowledgeBase` en la misma política). Los documentos, y después «Probar búsqueda», son `ViewKnowledgeBase` sobre la KB: su dueño, los administradores y los creadores que están en alguno de sus grupos. `EditKnowledgeBase` sigue el patrón de `EditAgent`. `UseKnowledgeBase` es solo estar en uno de sus grupos: ni el dueño ni un administrador la usan por serlo (regla 5). El dueño y los grupos los pone `mango-api` desde la tabla, nunca desde la petición.
- **Campos:** nombre (una línea, hasta 80 caracteres), descripción (hasta 500), de 1 a 20 grupos del registro de grupos, área (`all` o un área de la instalación, elegida al crear y fija después), clasificación (`public`, `internal`, `confidential` o `restricted`, por defecto `internal`; los valores los propuso el agente, porque D88 no los fijaba y no autoriza nada, (22)) y frecuencia (`manual`, `6h`, `daily`, `weekly`). Nombre y descripción pasan por la misma búsqueda de credenciales que el prompt de un agente (D26) y no van a la auditoría.
- **Edición y borrado:** cada cambio nombra la versión que leyó, y uno hecho entre medio responde 409. Borrar marca la KB `deleting`: sigue en la lista y ya no se edita. Hasta que exista la sincronización (PR 4), una KB borrada se queda en `deleting`; no tiene documentos ni vectores que borrar. El bloqueo de borrar una KB en uso llega con la asociación (15).
- **Respuestas:** el correo del dueño solo lo ven los administradores y el dueño; los demás creadores ven su nombre. Cada KB dice si quien pregunta puede editarla y ver sus documentos (`can_edit`, `can_view_documents`), por una decisión de Cedar en lote.
- **Auditoría y límites:** `kb.create`, `kb.update` (qué campos cambiaron y, si cambian los grupos, de cuáles a cuáles) y `kb.delete`, cada uno antes y después de escribir. Si no se puede auditar, no se escribe. Crear, editar y borrar cuentan en un límite compartido de 30 por hora y persona (D70).

**(30) Estado de lo construido: la subida y el guardado (2026-10-21).** Construidos con tests, sin ver en una instalación (el PR 3 del plan): `apps/api/src/mango_api/knowledge_uploads.py` y las rutas `POST …/uploads`, `POST …/documents` y `GET …/documents`. Lo que precisa del texto de arriba, propuesto por un agente:

- **Subir y guardar es editar la KB** (`EditKnowledgeBase`). Ver sus documentos es `ViewKnowledgeBase` sobre la KB. Cada subida queda registrada (`UPLOAD#`) con quién la pidió y los archivos que anunció; solo esa persona la guarda, en esa KB, durante 23 horas, y cada documento una sola vez.
- **El tipo lo da la extensión,** de la lista de (9), y el `Content-Type` que manda el navegador debe ser el de esa extensión. Al guardar, los bytes deben estar de acuerdo:
  - `%PDF-` al principio para un PDF;
  - un ZIP cuyo directorio nombre `word/document.xml` o `xl/workbook.xml` para DOCX y XLSX;
  - UTF-8 sin bytes nulos para TXT, MD y CSV.
  El tamaño debe ser el anunciado. Las lecturas y la copia llevan el ETag de lo que se comprobó: como el POST vale 15 minutos, otro archivo subido a la misma clave entre medio no es el que se copia. Lo que no cumple se rechaza con su motivo (`not_uploaded`, `too_large`, `size_mismatch`, `type_mismatch`), no se copia ni se cuenta, y se borra con `uploads/` al día.
- **El nombre mostrado** es solo el último componente de la ruta, sin caracteres de control, de ancho cero ni de dirección, con hasta 200 caracteres. Las claves solo llevan el sujeto de quien sube y ULIDs.
- **Los contadores** (`documents`, `bytes`) crecen en la misma transacción que los documentos, dentro de los topes de (9), y no cambian la versión de la KB. S3 calcula el SHA-256 de cada copia, que queda en el registro. Una copia que falla deja el documento `failed` con motivo `storage`.
- **El navegador sube directo al bucket.** La CSP de CloudFront admite su host regional solo en `connect-src`, y la CORS del bucket solo acepta `POST` desde el origen de la app. Para que ninguno de los dos nombre al otro como recurso (un ciclo en la plantilla), el bucket de documentos se llama ahora `mango-<ns>-knowledge-<8 hex del id del stack>`, en vez del nombre generado de (28). Es único por instalación, y un bucket retenido de una instalación anterior no impide otra. Si ya estaba instalado el de (28), vacío, CloudFormation crea el nuevo y retiene el viejo.
- **`mango-api`**, en su política propia: `GetObject` y `PutObject` solo bajo `uploads/`, `PutObject` solo bajo `kb/*/docs/` (el destino de la copia), y la llave a través de S3. No lee ni borra bajo `kb/`. Los registros de subida vencen con el TTL nuevo de la tabla (`expires_at`).
- **Límite compartido:** 60 pedidos de subida o de guardado por hora y persona, cada uno de hasta 20 archivos.
- **La indexación** queda para la sincronización (PR 4): hasta entonces, los documentos guardados están `uploaded`.

**(31) Un ciclo en la plantilla, corregido (2026-10-21).** CloudFormation rechazó la plantilla `Core` de (30) con «Circular dependency between resources». La causa no era la CSP:
- la política del bucket compartido de access logs nombraba el bucket de documentos como recurso (para recibir sus logs);
- el bucket nombra la distribución en su CORS;
- la distribución llega al balanceador, y el balanceador depende de esa misma política.

Ahora los logs del bucket de documentos se configuran a mano y la política lo nombra por su ARN, armado desde su nombre de (30). Eso no depende de ningún recurso. La CSP, la CORS y los logs son los mismos de antes. `infra/test/cycles.test.ts` ordena el grafo de dependencias de cada plantilla, con las banderas de `cdk.json`, y falla ante un ciclo. Sin esas banderas, los tests no veían este.

**(32) Estado de lo construido: la sincronización (2026-10-21).** Construida con tests, sin ver en una instalación (el PR 4 del plan): `functions/knowledge-sync` y la máquina `Mango-<ns>-KnowledgeSync` en `Core`. Lo que precisa del texto de arriba, propuesto por un agente:

- **Quién la arranca (11):** `mango-api`, al guardar documentos, al quitar uno (ruta nueva `POST …/documents/{doc_id}/delete`), al borrar una KB y con «Sincronizar ahora» (`POST …/sync`, `EditKnowledgeBase`). Antes de arrancar la máquina, `mango-api` marca la KB con la sincronización (`sync_id`). Si ya corre otra, queda anotado quién pidió una más (`sync_again`), y esa arranca cuando la que corre termina. Si la máquina no arranca, lo guardado sigue guardado y «Sincronizar ahora» la pide de nuevo.
- **Pasos:**
  - el lock con vencimiento de la base de Bedrock (cada 30 s, hasta una hora detrás de otra);
  - el plan, leído del registro;
  - la ingesta por lotes de 25, con un `clientToken` por lote;
  - el estado de cada documento, cada 10 s durante hasta 15 minutos (lo que siga indexándose lo consulta la sincronización siguiente);
  - el borrado por lotes de 25;
  - la verificación cada 20 s, hasta 10 minutos;
  - el cierre: cobra, libera el resto de la reserva y el lock, deja el estado de la KB, audita `kb.sync` y arranca la pedida mientras tanto.

  El cierre corre también después de cualquier fallo, así que una sincronización que falla nunca deja la reserva ni el lock tomados. La máquina dura hasta 2 horas.
- **Metadatos (23):** `kb_id`, `doc_id`, `business_unit`, `acl_groups` (como lista) y `classification`, inline desde el registro. Un test comprueba que todo documento ingerido lleva su `kb_id`. Falta ver en la instalación que S3 Vectors guarde `acl_groups` como lista.
- **Presupuesto (24):** reserva la función de sincronización, antes de ingerir, contra el presupuesto de la persona (`USER#<sub>`), con el límite que `mango-api` le pasa al arrancarla. La estimación es de 4 bytes por token, al precio del modelo de embeddings, que ahora es configuración (`embeddingPrices` en `release-defaults.json`, regla 7).
  - Bedrock no informa los tokens de una ingesta: se cobra la estimación de lo indexado (y de lo que aún se indexa), se libera el resto y se concilia contra la factura como el resto de §4.5.
  - Si no alcanza el presupuesto, no se ingiere nada, la KB queda «Error» y la sincronización registra `budget`; los borrados siguen.
  - Las sincronizaciones que arranca el barrido solo borran y no cuestan nada.
- **Borrado (16):** un documento borrado se da por borrado cuando una búsqueda filtrada por `kb_id` y por ese documento no devuelve nada. Entonces se borra su objeto (en un bucket versionado: la versión vieja se va al día) y su registro, y bajan los contadores. Una KB borrada desaparece cuando no le queda ningún registro de documento y una búsqueda solo por su `kb_id` no devuelve nada (`kb.deleted`).
- **Cada hora, la misma máquina barre:**
  - publica `DeletionsOverdue` (KBs con un borrado pedido hace más de 6 horas, por `deleting_since`), que lee la alarma de (28);
  - arranca la sincronización de los borrados que nadie terminó;
  - y si una sincronización tiene su KB tomada hace más de 3 horas, la da por muerta: cobra entera su reserva (lo gastado ya no se sabe), libera la KB y el lock, y lo audita.
- **Alarma `KnowledgeSync-failed`:** una ejecución que falla o se queda sin tiempo. La función solo la invoca Step Functions, de forma síncrona, así que no lleva DLQ (excepción acordada de `AGENTS.md`).
- **El rol de la sincronización:**
  - el registro;
  - solo `UpdateItem` en los presupuestos `USER#*`;
  - ingesta, estado, borrado y búsqueda solo sobre la base de Bedrock de la instalación;
  - leer y borrar solo bajo `kb/*/docs/` (leer, por si Bedrock pide los permisos de quien ingiere sobre la ubicación S3: a ver en la instalación);
  - arrancar su propia máquina, nombrada por su ARN, y la auditoría.

**(33) Las subidas se firman con un rol propio (2026-10-21).** GuardDuty marcó con severidad 8 `UnauthorizedAccess:IAMUser/ResourceCredentialExfiltration.OutsideAWS` la prueba de subida de (30) en la instalación del cliente. Fue un `PutObject` desde el navegador con las credenciales del rol de la tarea ECS de `mango-api`: el POST prefirmado lleva su sesión, así que cada subida de cada persona lo habría disparado. El dueño eligió arreglarlo ese día.

Ahora:
- `mango-api` asume `Mango-<ns>-Presign` por STS, una sesión de 30 minutos por persona con `SourceIdentity` = quien sube (regla 5), cacheada mientras le queden más de 16 minutos, y firma solo con ella.
- El rol solo hace `PutObject` bajo `uploads/` del bucket de documentos, con `kms:GenerateDataKey` de su llave a través de S3 (además de los PDF de [D86](D086-reportes-descargables-de-tareas.md) (10)).
- Su trust solo admite al rol de la tarea y exige `SourceIdentity`.
- El rol de la tarea ya no puede escribir en `uploads/`: lee ahí lo que comprueba y copia, y escribe solo en `kb/*/docs/`.
- Sin el rol de firma no se firma ninguna subida (503), nunca con la sesión de la tarea.
- Las condiciones del POST (clave, tamaño, tipo, 15 minutos) no cambian.

**(34) La ingesta directa pide cinco permisos, no tres (2026-10-22).** En la instalación del cliente, `DeleteKnowledgeBaseDocuments` respondía `AccessDenied`, con mensaje vacío, al rol `Mango-<ns>-KnowledgeSync`. Ese rol tenía `Delete`, `Get` e `IngestKnowledgeBaseDocuments` sobre la KB, y `simulate-principal-policy` daba `allowed`.

El dueño lo diagnosticó ese día con políticas temporales, ya quitadas:
- con S3 Vectors y KMS, siguió negado;
- con las lecturas de la base y de su *data source*, siguió negado;
- con `bedrock:StartIngestionJob` y `bedrock:ListKnowledgeBaseDocuments` sobre la KB, pasó.

La guía de AWS («Prerequisites for direct ingestion») pide los cinco juntos: `StartIngestionJob` y `Ingest`, `Get`, `List` y `DeleteKnowledgeBaseDocuments`. La ingesta habría fallado igual.

El rol de sincronización tiene ahora exactamente esos cinco sobre la KB, más `Retrieve` para verificar los borrados, y un test lo fija. Tener `StartIngestionJob` no cambia (23): la sincronización nunca arranca un trabajo de ingesta. Los permisos de S3 Vectors y de la llave siguen solo en el rol de servicio de la base (28).

La sincronización, además:
- deja en el log el código de error de AWS, nunca su mensaje;
- no reintenta un permiso negado: el paso termina en el cierre, que libera la reserva y el lock y deja la KB en «Error», y la ejecución falla, lo que dispara `KnowledgeSync-failed`.

**(35) Estado de lo construido: la asociación con agentes, en la API (2026-10-22).** Construida con tests, sin ver en una instalación (la parte de servidor del PR 6 del plan; el selector del Builder y la revisión en pantalla esperan la ronda de diseño, D24). Lo que precisa de (15), propuesto por un agente:

- **El campo:** `knowledge_bases` en la definición de la versión (`mango_core.agents`), de 0 a 5 ids de KB (ULID), sin repetidos y ordenados. Mientras está vacío no entra en la forma canónica: el contenido y el hash de las versiones escritas antes, y los del agente de la release, no cambian.
- **Quién añade una KB:** al crear el agente o guardar un borrador, cada KB que **entra** en la versión debe existir, no estar en `deleting` y ser una que quien guarda puede usar (`UseKnowledgeBase`, con los grupos del registro; tampoco aquí basta ser administrador). Si no, 422 con `knowledge_base_unavailable` o `knowledge_base_not_usable`, auditado como un rechazo. Las que la versión ya tenía se quedan: así un administrador puede editar un agente cuyas KBs no usa. Es la regla de servidor de «el Builder solo ofrece las KBs que su autor puede usar».
- **Revisión (D18):** al enviar y al aprobar, cada KB debe existir y no estar en `deleting` (`knowledge_base_unavailable`); un modelo sin tools no puede tener KBs (`model_without_tools`: la búsqueda es una tool, (14)). El diff de la revisión lista las KBs añadidas y quitadas, y la versión trae cada una con su nombre y su estado (`knowledge_bases`), para quien edita o revisa la versión, que ya ve la lista de KBs.
- **La alerta de D26 (26):** por cada KB, los grupos del agente que no están en ninguno de sus grupos (`groups_without_access`): «Estos grupos usan el agente pero no reciben respuestas de esta knowledge base». Nunca nombra los grupos de la KB, y no bloquea. Las personas con las que el agente se comparte una por una no se miran: sus grupos están en su token.
- **Borrar una KB en uso:** responde 409 `knowledge_base_in_use` con los agentes (id, versión y nombre) si alguna versión publicada, aprobada o con la publicación fallida la usa: la fallida se reintenta sin otra revisión. Una en revisión no cuenta: su aprobación comprueba otra vez que la KB existe. Si los agentes no se pueden leer, no se borra (503).
- **Pendiente:** los textos de los dos códigos nuevos y de la alerta llegan con la ronda de diseño (brief, §2.5 y §2.6); hasta entonces, la web muestra un código que no conoce como regla desconocida. La tool que usa estas KBs llega con el PR 5.
