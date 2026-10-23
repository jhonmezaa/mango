# D88 · Knowledge bases: una entidad compartida entre agentes, con documentos de S3

- **Estado:** vigente
- **Fecha:** 2026-10-21 (los puntos 1 a 6, tomados por el dueño ese día, por menú; el cómo, puntos 7 a 17, propuesto por un agente; las respuestas del dueño a sus ocho preguntas, puntos 18 a 26, tomadas ese día, por menú; aceptada por el dueño ese día, por menú: «Aceptar D88 (Recomendada)»; lo que mostró la prueba técnica previa, punto 27, nota de ese día propuesta por un agente; lo construido de los recursos fijos, punto 28, nota de ese día propuesta por un agente, con el cifrado de los vectores elegido ese día por menú; lo construido del registro, punto 29, nota de ese día propuesta por un agente; lo construido de la subida, punto 30, nota de ese día propuesta por un agente; el ciclo de la plantilla, punto 31, nota de ese día propuesta por un agente; lo construido de la sincronización, punto 32, nota de ese día propuesta por un agente; el rol que firma las subidas, punto 33, elegido por el dueño ese día, nota propuesta por un agente; 2026-10-22: los permisos de la ingesta directa, punto 34, diagnosticados por el dueño ese día en la instalación, nota propuesta por un agente; lo construido de la asociación con agentes en la API, punto 35, nota de ese día propuesta por un agente; lo construido de la tool, punto 36, nota de ese día propuesta por un agente, con sus cuatro precisiones elegidas ese día por menú por el agente que lanzó el trabajo; lo construido de «Probar búsqueda», punto 37, nota de ese día propuesta por un agente, con su autorización, que precisa el punto 29, elegida por el dueño ese día, por menú: «Verla y estar en sus grupos (Recomendada)»; lo construido de las fuentes en la API, punto 38, nota de ese día propuesta por un agente, con tres precisiones elegidas ese día por menú por el agente que lanzó el trabajo; lo construido del rol de cada fuente, punto 39, nota de ese día propuesta por un agente; lo construido de la copia de las fuentes, punto 40, nota de ese día propuesta por un agente, con dos precisiones elegidas ese día por menú por el agente que lanzó el trabajo; lo construido de la frecuencia de las fuentes, punto 41, nota de ese día propuesta por un agente; un origen por KB, un bucket por KB y la nota de cada decisión, punto 42, decididos por el dueño ese día, por menú, para alinear el servidor con el diseño de la ronda 17; lo que la pantalla lee de cada KB, punto 43, pedido por el dueño ese día por menú y con el detalle propuesto por un agente; las citas del chat, solo metadatos, punto 44, elegidas por el dueño ese día, por menú: «Ahora, solo metadatos (Recomendada)»; lo construido de la pantalla, punto 45, nota de ese día propuesta por un agente, con su diferencia con el diseño elegida por el dueño ese día, por menú: «Pantalla con el texto exacto (Recomendada)»; 2026-10-23: lo construido de la segunda parte de la pantalla, punto 46, nota de ese día propuesta por un agente; lo construido en el Builder y la revisión, punto 47, nota de ese día propuesta por un agente; las propuestas propias y decididas en Aprobaciones, punto 48, pedidas por el dueño ese día por menú, «PR de servidor antes», con el detalle propuesto por un agente)
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

- **Cedar (13):** la lista es `ViewKnowledgeBase` sobre la plataforma, para administradores y creadores (con `CreateKnowledgeBase` en la misma política). Los documentos, y después «Probar búsqueda», son `ViewKnowledgeBase` sobre la KB: su dueño, los administradores y los creadores que están en alguno de sus grupos. La prueba exige además `UseKnowledgeBase` ((37), elegido por el dueño el 2026-10-22). `EditKnowledgeBase` sigue el patrón de `EditAgent`. `UseKnowledgeBase` es solo estar en uno de sus grupos: ni el dueño ni un administrador la usan por serlo (regla 5). El dueño y los grupos los pone `mango-api` desde la tabla, nunca desde la petición.
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

**(36) Estado de lo construido: la tool `knowledge-retrieve` (2026-10-22).** Construida con tests, sin ver en una instalación (el PR 5a del plan; «Probar búsqueda» queda para el 5b). Hay código en `connectors/knowledge-retrieve`, `mango_core.knowledge_search`, el interceptor del Gateway, `mango-api` y el provisioner. El agente propuso las precisiones de (14), y el agente que lanzó el trabajo eligió cada una por menú, siempre la opción recomendada:

- **La tool es implícita.** Una versión con `knowledge_bases` tiene `knowledge___retrieve`, y solo esa versión. Nadie la añade a mano: no está en el catálogo de tools, sin `manifest.json`. La ponen `mango-api`, en `allowedTools` y en la firma, y el provisioner, en el harness. El target `knowledge` queda reservado: ningún pack lo toma. El hash de la versión no cambia, porque la tool sale de `knowledge_bases`.
- **La firma:** la invocación v2 lleva las KBs de la versión en el claim `kbs`, solo si tiene alguna. Así la firma de un agente sin KBs no cambia. El interceptor las pasa a la tool en `_mango_ctx`, junto con el token, el agente y la versión. Ningún otro conector las recibe.
- **La tool:**
  - verifica el token y toma de él los grupos;
  - acepta del modelo solo la consulta, de hasta 1.000 caracteres, y un subconjunto de esas KBs: un id que no es de la versión se ignora;
  - lee las KBs del registro en cada llamada y busca solo en las que no están en `deleting` y en cuyos grupos está la persona. Es la regla de `UseKnowledgeBase`, en `mango_core.knowledge.usable`, y un test la compara con la política Cedar;
  - con nada que buscar, no llama a `Retrieve`;
  - devuelve hasta 8 fragmentos de hasta 2.000 caracteres, cada uno con su KB, su documento (el nombre, del registro), su página y su puntaje, bajo un aviso de que son datos y no instrucciones. Si llega un fragmento de una KB no buscada, lo descarta y lo deja en el log.
- **Auditoría:** antes de responder, `kb.retrieve` registra el agente, las KBs pedidas, las permitidas y las devueltas, los ids de los fragmentos y el largo de la consulta. Si no se puede auditar, no responde.
- **Límite por persona:** 60 búsquedas por minuto, en la tabla `RateLimits` (D70). El limitador compartido pasó a `mango_core.rate_limits`; `mango_api.rate_limits` lo reexporta con su logger, así la alarma de D71 no cambia. El rol de la tool solo usa los ítems `LIMIT#kb.retrieve#*`.
- **Throttling:** un `Retrieve` rechazado por la cuota publica `RetrieveThrottles`, la métrica que lee la alarma de (28), y responde «ocupado». Un error nunca se reintenta sin el filtro.
- **Costo (14):** `mango-api` reserva para cada turno de un agente con KBs una búsqueda por iteración. Al cerrar el turno, cobra cada búsqueda del stream como si fuera la consulta más larga (250 tokens) al precio de los embeddings, que es configuración (`KNOWLEDGE_EMBEDDING_PRICE`, regla 7). Se elige la consulta más larga porque una respuesta larga de la tool puede no quedar registrada, y así la estimación nunca se queda corta. La consulta a S3 Vectors queda para la conciliación (§4.5). Una tool de un pack con el mismo nombre también se cobra, a lo sumo unas millonésimas de dólar.
- **Cedar L2:** `Mango_<ns>_KnowledgeRetrieve` permite la tool a todo usuario con sesión, como un pack público (D33). Qué KBs responden lo decide la tool. También la usa una tarea, con el token de su dueño (D78).
- **El rol `Mango-<ns>-KnowledgeRetrieve`:** `BatchGetItem` del registro, `Retrieve` sobre la base de la instalación, sus ítems de `RateLimits` y la auditoría. No lee documentos, no escribe el registro y no ingiere ni borra nada. Un test lo fija.
- **Aislamiento (R4):** los tests de `connectors/knowledge-retrieve` usan dos KBs de dos grupos y dos áreas, con un Bedrock falso que aplica el filtro, y corren en el CI con los demás. Cubren estos casos:
  - nadie fuera de los grupos de una KB recibe un fragmento de ella, tampoco un administrador;
  - una KB que el modelo nombra fuera del agente no se busca;
  - con la lista vacía no se llama a Bedrock;
  - un cambio de grupos rige al instante;
  - un fragmento ajeno que devuelva Bedrock se descarta.
- **Pendiente de ver en la instalación:** que una persona del grupo reciba fragmentos en el chat y otra que usa el mismo agente no, con `kb.retrieve` en la auditoría; que S3 Vectors devuelva la página (la prueba de (27) no la vio); y si `Retrieve` pide a quien llama algún permiso más que `bedrock:Retrieve`.

**(37) Estado de lo construido: «Probar búsqueda» (2026-10-22).** Construida con tests, sin ver en una instalación (el PR 5b del plan; la pantalla espera la ronda de diseño, D24). Es `POST /api/knowledge-bases/{id}/search`, en `mango-api`.

- **Quién (precisa (29)):** la prueba exige `ViewKnowledgeBase` **y** `UseKnowledgeBase` sobre la KB: ver sus documentos y estar en uno de sus grupos. El texto de (29) solo pedía ver la KB. El modelo de amenazas (TM-K1) pedía `UseKnowledgeBase`, y la regla 5 de (13) dice que ni el dueño ni un administrador la usan por serlo. Lo eligió el dueño el 2026-10-22, por menú: «Verla y estar en sus grupos (Recomendada)». Un administrador o el dueño que no está en los grupos sigue viendo la lista de documentos, pero no lee su contenido.
- **Qué:** una consulta de hasta 1.000 caracteres, sin caracteres de control salvo el salto de línea. Busca solo esa KB, con el filtro y los límites de la tool (`mango_core.knowledge_search`), y no busca en una KB en `deleting` (409). Devuelve cada fragmento con su documento (el nombre, del registro), su página y su puntaje, para mostrarlo como texto.
- **Límite:** 20 búsquedas por minuto por persona, compartido entre las tareas (D70, `knowledge.searches`). No cuenta como consulta de un agente ni va a ningún presupuesto.
- **Auditoría:** `kb.search`, con la KB, los ids de los fragmentos, el largo de la consulta y el resultado, antes de responder. Si no se puede auditar, no responde.
- **Throttling:** si Bedrock rechaza la búsqueda por su cuota, la ruta responde 503 `search_busy` y deja una línea en el log de `mango-api`. Un filtro de métricas la suma a `RetrieveThrottles`, así la alarma de (28) cuenta la tool y la prueba. Es el segundo filtro de métricas de `Core`, después del de D71 (18).
- **`mango-api`** puede hacer `bedrock:Retrieve` sobre la base de la instalación, en su política `Mango-<ns>-ApiKnowledge`, y nada más de Bedrock en ella. Lo fija un test.
- **Pendiente de ver en la instalación:** que la prueba devuelva fragmentos de una KB indexada a quien está en sus grupos, y que un administrador fuera de ellos reciba 403.

**(38) Estado de lo construido: las fuentes de bucket existente, en la API (2026-10-22).** Construidas con tests, sin ver en una instalación. Es el PR 7a del plan, y lo que sigue llega después: el rol de cada fuente (7b) y la copia en la sincronización con su frecuencia (7c). El código está en `apps/api/src/mango_api/knowledge_sources.py`, con las políticas `knowledge-source-propose.cedar` y `knowledge-source-approve.cedar`.

El agente que lanzó el trabajo eligió por menú tres precisiones, siempre la opción recomendada:
- el PR 7 va en tres partes;
- el rol `Mango-<ns>-kbsrc-<src>` lo crea y lo borra una función propia, `Mango-<ns>-KnowledgeSources` (7b), y no el provisioner de agentes ni el de packs;
- la Bandeja y Aprobaciones muestran las fuentes pendientes cuando llegue su diseño (D24). Por ahora solo existe la API.

Lo demás de este punto lo propuso un agente:

- **Rutas:**
  - `GET` y `POST /api/knowledge-bases/{id}/sources`;
  - `POST …/sources/{src_id}/approve`, `…/reject` y `…/delete`;
  - `GET /api/knowledge-sources/pending`, la lista de lo que el administrador puede firmar, sin lo que propuso él.
- **Quién (Cedar L1, (13)):**
  - `ProposeKbSource` es la regla de `EditKnowledgeBase`: el dueño mientras sea creador, o un administrador. Con ella también se quita una fuente.
  - `ApproveKbSource` es para administradores.
  - Que no decida quien propuso, también si es administrador (20), lo comprueban `mango-api` y una condición de la tabla (`proposed_by <> :me`), como en la revisión de agentes.
  - La lista de fuentes la ve quien ve los documentos.
- **La propuesta:**
  - `s3://bucket/prefijo/`, con el prefijo vacío o terminado en `/`;
  - hasta 5 fuentes activas por KB, sin repetir bucket y prefijo;
  - la fuente queda `pending`;
  - el bucket y el prefijo no cambian nunca: otro es otra propuesta (20).
  - Estados: `pending`, `approved`, `rejected`, `withdrawn` (quitada antes de decidir) y `removing` (quitada después de aprobar: su rol y sus documentos se borran en 7b y 7c).
- **El chequeo del bucket (precisa (10)):**
  - se hace al proponer y otra vez al aprobar;
  - se rechaza todo bucket `mango-*`, de esta instalación o de otra de la cuenta;
  - para saber que el bucket es de la cuenta se pide su cifrado (`GetBucketEncryption`) con `ExpectedBucketOwner`, y no `HeadBucket`. `HeadBucket` exige `s3:ListBucket`, que dejaría a `mango-api` listar cualquier bucket de la cuenta. Así `mango-api` solo tiene `s3:GetEncryptionConfiguration`, solo para buckets de la cuenta (`s3:ResourceAccount`), y no lee ni lista objetos;
  - se aceptan SSE-S3 (el cifrado por defecto de todo bucket) y la llave `aws/s3`; una llave propia se rechaza (17);
  - si S3 no responde, no se propone ni se aprueba (503).
- **Auditoría:** `kb.source_propose`, `kb.source_approve`, `kb.source_reject` y `kb.source_remove`, antes y después de escribir, con el ARN (20). Cuentan en el límite de cambios de las KBs.
- **Pendiente:** el rol de la fuente (7b), la copia y la frecuencia (7c), y la tarjeta de Aprobaciones y la Bandeja (diseño). Hasta el 7b, una fuente aprobada no se lee.

**(39) Estado de lo construido: el rol de cada fuente (2026-10-22).** Construido con tests, sin ver en una instalación. Es el PR 7b del plan. El código está en `functions/knowledge-sources`, la función `Mango-<ns>-KnowledgeSources` que eligió (38). Lo que precisa de (10), propuesto por un agente:

- **Quién la invoca:** solo `mango-api`, de forma síncrona y con los ids de la KB y de la fuente:
  - al aprobar una fuente (`ensure`);
  - al quitar una aprobada (`delete`).

  El bucket y el prefijo los lee la función del registro, nunca del evento. Solo crea el rol de una fuente `approved` y solo borra el de una `removing`.
- **El rol** `Mango-<ns>-kbsrc-<src_id>`:
  - lleva el boundary `Mango-<ns>-kbsrc-boundary`;
  - su política tiene `s3:ListBucket` sobre ese bucket, condicionado a claves bajo el prefijo, y `s3:GetObject` bajo ese prefijo, nada más;
  - solo lo asume `Mango-<ns>-KnowledgeSync`, por `aws:PrincipalArn`, y solo con `SourceIdentity` (regla 5);
  - lleva las etiquetas `mango:kb` y `mango:source`.

  Un rol que ya existe se usa solo si conserva ese boundary y esa confianza; si alguien lo cambió, la función falla y no lo repara. Al terminar, la función anota el ARN del rol en la fuente (`role_ready` en la API).
- **El rol de la función:** escribe solo roles `Mango-<ns>-kbsrc-*` con el boundary, como condición de IAM en crear, poner y quitar la política y borrar (el patrón del provisioner de packs y de D48 (7)). Además lee los roles y los etiqueta, y lee y marca las fuentes en el registro. No tiene `PassRole`, ni cambios de boundary o de confianza, ni nada de S3.
- **Auditoría:** `mango-api` audita `kb.source_role` antes y después de invocar la función, con el resultado.
  - Si la función falla, la aprobación o la baja se mantienen, la fuente queda sin rol (`role_ready` falso) y el fallo queda auditado con su código.
  - El siguiente intento llega con la sincronización de la fuente (7c). Mientras no haya rol, nadie lee la fuente.
- **Desinstalación:** la guarda de desinstalación (D58) borra también los roles `Mango-<ns>-kbsrc-*` que llevan su boundary.
- **Riesgo que queda:** IAM no puede condicionar la política de confianza de un rol que se crea. Que solo confíe en la sincronización lo garantiza el código de la función, que la construye desde su configuración y la verifica en cada llamada, como en el provisioner de packs. El boundary limita lo que ese rol lee, no quién lo asume. Anotado en el modelo de amenazas (TM-K7).

**(40) Estado de lo construido: la copia de las fuentes (2026-10-22).** Construida con tests, sin ver en una instalación. Es el PR 7c del plan. El código está en `functions/knowledge-sync/src/mango_knowledge_sync/sources.py`, con un paso nuevo, `copy`, en `Mango-<ns>-KnowledgeSync`.

El agente que lanzó el trabajo eligió dos precisiones ese día por menú, las dos recomendadas:
- la frecuencia con EventBridge Scheduler va en un PR aparte (7d);
- una sincronización por horario lee ella misma el límite de presupuesto del dueño en la tabla Settings (7d).

Lo demás de este punto lo propuso un agente:

- **Cuándo:** el paso `copy` corre después del lock y antes del plan, en cada sincronización de una KB con fuentes. `mango-api` arranca una al aprobar una fuente que ya tiene su rol (la primera copia, a nombre de quien aprobó, (24)) y otra al quitar una aprobada (la limpieza).
- **Quién lee:**
  - el rol de la fuente (39), asumido con el `SourceIdentity` de quien sincroniza;
  - escribe en `kb/<kb_id>/docs/<doc_id>` el rol de la sincronización, que nunca lee la fuente. El rol de la fuente nunca escribe en Mango;
  - una sincronización de solo borrados (la del barrido) no copia nada.
- **Qué se copia:**
  - los mismos documentos que una subida, con las reglas en `mango_core.knowledge_files`, compartidas con `mango-api`: tipo por extensión, bytes de acuerdo, hasta 50 MB;
  - dentro de los topes de la KB (1.000 documentos y 5 GB, ahora en `mango_core.knowledge`).
  - Un objeto que no cumple queda `failed`, con su motivo (`unsupported_type`, `type_mismatch`, `empty`, `too_large`, `size_mismatch`), no se copia y no ocupa bytes. Uno que el rol no puede leer queda `failed` con `protected`: por ejemplo, uno cifrado con una llave propia.
  - El documento guarda la clave y el ETag de la fuente (`source_key`, `source_etag`).
- **Cambios en la fuente:**
  - una clave nueva se copia;
  - una con otro ETag se copia como documento nuevo y la copia vieja se borra;
  - una que ya no está se borra.

  Los borrados son los de la sincronización, verificados (16).
- **Por pasos:** hasta 3 minutos o 300 MB por paso, y la máquina repite el paso mientras quede algo, hasta 20 pasos por ejecución. El estado no lleva claves ni nombres: cada paso vuelve a listar la fuente.
- **El rol, otra vez:**
  - una fuente aprobada sin rol pide el rol de nuevo a `Mango-<ns>-KnowledgeSources`; es el reintento del que habla (39);
  - una fuente quitada pierde primero sus documentos, después su rol y por último su registro.
- **El rol de la sincronización gana:**
  - `s3:PutObject` bajo `kb/*/docs/` y `kms:GenerateDataKey` de la llave de documentos, a través de S3;
  - `sts:AssumeRole` y `sts:SetSourceIdentity` sobre `Mango-<ns>-kbsrc-*`;
  - `lambda:InvokeFunction` sobre `Mango-<ns>-KnowledgeSources`.

  Su memoria pasa a 1 GB, porque un documento de 50 MB se copia en memoria.
- **Pendiente de ver en la instalación:**
  - si leer un bucket cifrado con `aws/s3` necesita que el rol de la fuente tenga `kms:Decrypt`, que su boundary no da. Si lo necesita, esos documentos quedarán `protected`;
  - la copia de un bucket de prueba del cliente, con su OK;
  - el borrado de lo que se quita en el origen.

**(41) Estado de lo construido: la frecuencia de las fuentes (2026-10-22).** Construida con tests, sin ver en una instalación. Es el PR 7d del plan y cierra el PR 7. Lo que precisa de (11) y (24), propuesto por un agente:

- **Un horario por KB:**
  - se llama `kb-<kb_id>` y vive en el grupo `Mango-<ns>-knowledge`, que nace con `Core`;
  - lo crea, cambia y borra `mango-api`, por SDK (D25);
  - existe mientras la KB tenga una fuente aprobada, una frecuencia distinta de `manual` y no se esté borrando. Las subidas se indexan al guardarse y no necesitan horario.
  - `6h`, `daily` y `weekly` son `rate(6 hours)`, `rate(1 day)` y `rate(7 days)`, con una ventana flexible de 15 minutos.
- **Cuándo cambia:**
  - al aprobar una fuente;
  - al cambiar la frecuencia de la KB;
  - al quitar la última fuente aprobada;
  - al borrar la KB.

  Cada cambio se audita como `kb.schedule`, con el resultado. Si Scheduler falla, el cambio de la KB se mantiene, el fallo queda auditado y el próximo cambio lo pide de nuevo.
- **Qué arranca:** la máquina `Mango-<ns>-KnowledgeSync` en su modo `scheduled`, con solo el id de la KB. Ese modo es una ejecución corta: lee el dueño de la KB y su límite de presupuesto, arranca una sincronización normal a su nombre (24) y termina.
  - El límite es el que lee `mango-api`: el propio de esa persona o el de la instalación, en la tabla Settings. Así lo eligió el agente que lanzó el trabajo, en (40).
  - Si no puede leer el límite, no arranca nada.
  - Si ya corre una sincronización de esa KB, la deja: sincroniza el próximo horario.
- **IAM:**
  - el rol de los horarios, `Mango-<ns>-KnowledgeScheduler`, solo arranca esa máquina y solo lo asume Scheduler para horarios de ese grupo en esta cuenta (el patrón de las tareas, D78);
  - `mango-api` gestiona solo los horarios de ese grupo y pasa solo ese rol;
  - la sincronización lee de Settings solo la partición `BUDGETS`.
- **Pendiente de ver en la instalación:** que un horario arranque una sincronización a nombre del dueño y copie lo nuevo de la fuente.

**(42) Una sola manera de traer documentos por KB, y la nota de cada decisión de un bucket (2026-10-22).** Lo decidió el dueño por menú, para alinear el servidor con el diseño de la ronda 17 (Claude Design, `kb-core.jsx`, `knowledge.jsx`, `kb-source.jsx`). Precisa (9), (10) y (20):

- **El origen, al crear y para siempre:** `origin` es `upload` (archivos subidos desde Mango) o `bucket` (un bucket que ya existe). Es obligatorio al crear la KB, no se edita y no se mezcla:
  - una KB de archivos no acepta fuentes y una de bucket no acepta subidas (409 `knowledge_base_origin`);
  - un registro anterior sin `origin` se lee como `upload`.

  Para combinar las dos, se crean dos KBs y se asocian al mismo agente (hasta 5, (15)).
- **Un bucket por KB:** una KB de bucket lee una sola fuente aprobada. Cambiar el bucket o el prefijo es una propuesta nueva, y solo puede haber una pendiente a la vez (409 `source_pending`). Mientras se decide, la KB sigue leyendo la aprobada. Al aprobarse el cambio, la anterior pasa a `removing` (se audita `kb.source_remove` con `replaced_by`), pierde su rol, y la sincronización saca lo que ya no está en la nueva. El tope de 5 fuentes activas sigue, por las que se están quitando.
- **La nota de la decisión:** aprobar lleva una nota opcional y rechazar una obligatoria (422 `note_required`), de hasta 500 caracteres, sin caracteres de control ni credenciales (D26). Se guarda en la fuente con el correo de quien decidió. La leen los administradores, el dueño de la KB y quien propuso, que son quienes ya ven los correos. La auditoría registra `note_chars`, nunca el texto.

**(43) Lo que la pantalla lee de cada KB (2026-10-22).** Lo pidió el dueño por menú antes de construir la pantalla de la ronda 17: «PR de servidor antes». El detalle lo propuso un agente. `KnowledgeBaseOut`, en la lista y en el detalle, suma:

- **El cierre de la última sincronización:** la sincronización guarda en la KB `last_attempt_at` (cuándo cerró la última) y `last_synced_at` (cuándo terminó la última sin motivo). También `status_reason`, si la última no terminó como se pidió:
  - `budget`: no empezó por presupuesto, con `budget_estimate_usd`, lo que costarían sus embeddings;
  - `error`: falló;
  - `full`: una fuente pasa los topes de la KB y se copió hasta ellos. No es un error, y el estado sale de sus documentos.

  Una sincronización que termina borra el motivo anterior.
- **`can_search`:** ve sus documentos y está en sus grupos, las dos acciones de «Probar búsqueda» (37), sin depender de un 403.
- **`sources`**, en una KB de bucket: las fuentes activas y, si no hay una pendiente, la última decidida (rechazada o retirada). Así la lista dice «Pendiente de aprobación», «Bucket rechazado» o «Sin bucket» sin leer cada fuente.
  - La ubicación `s3://…` solo va para quien ve sus documentos, como en `GET …/sources`.
  - Una KB de archivos devuelve `[]`, y una que no se pudo leer, `None`.
- **`agents`:** los agentes cuyas versiones la sirven (las mismas que bloquean su borrado, (15)), uno por agente y de su versión más reciente. Cada uno trae `groups_without_access`, la alerta de D26 «Acceso parcial», solo para quien ve sus documentos; para los demás, `None`.
  - La alerta no mira a las personas compartidas una por una, como en (35).
  - Si los agentes no se pueden leer, `agents` es `None` y la respuesta sigue.

**(44) Las citas del chat: solo metadatos (2026-10-22).** El dueño eligió por menú «Ahora, solo metadatos (Recomendada)» para esta ronda. El diseño de la ronda 17 muestra bajo la respuesta el paso «Buscó en … · N fragmentos» y las fuentes («Fuentes», documento y página). Lo decidido:

- **Qué va en el stream:** después de cada respuesta de `knowledge___retrieve`, `mango-api` manda el evento `knowledge` con el nombre de cada KB que respondió, el conteo de fragmentos y, por cada fuente, solo el documento y la página. **Nunca el texto del fragmento:** lo lee el modelo y no sale de `mango-api`, ni en el stream ni en el mensaje guardado.
- **Todo en texto plano, sin HTML:** los nombres salen del registro (el de la KB y el del archivo, escritos por personas). `mango-api` quita los caracteres de control y de formato (también los bidireccionales), junta los saltos de línea y corta cada nombre a 200 caracteres. Solo guarda una página entera y plausible. La web los muestra como texto.
- **De dónde:** de la respuesta de la tool en el stream del harness. Solo cuenta la tool del target `knowledge` y solo si la versión la tiene: el nombre de la llamada lo escribe el modelo (TM-LP1). Una respuesta de error, de otra forma o de más de 64 KiB no da citas.
- **En el mensaje:** la respuesta guarda sus fuentes (`citations`), cada una una vez, hasta 24 por mensaje. Así se ven al volver a abrir la conversación. `GET /api/conversations/{id}` las devuelve en cada mensaje.
- **Lo que no cambia:** la tool, su respuesta al modelo, su auditoría `kb.retrieve` y el costo del turno. Una tarea (D78) no muestra citas: no tiene chat.
- **Pendiente:** la web dibuja el paso y las fuentes en el PR de las citas de esta ronda. El diseño despliega el texto del fragmento al tocar una fuente, y eso queda fuera: va en el brief de la próxima ronda.

**(45) Estado de lo construido: la pantalla, primera parte (2026-10-22).** Construida con tests (Vitest y Playwright contra el mock), sin ver en una instalación. Es la ronda de diseño 17 (D24): `apps/web/src/pages/knowledge/`.

- **Qué hay:**
  - la lista, con sus indicadores, la búsqueda, los filtros por estado y por fuente, y la insignia «Acceso parcial»;
  - el alta de una KB de archivos o de un bucket (crear y proponer su bucket);
  - el panel con «Resumen» y «Acceso» («Acceso y sync» en una de bucket): grupos, frecuencia, proponer, cambiar o retirar el bucket, «Sincronizar ahora» y borrar.

  La lista se vuelve a leer mientras una KB se sincroniza o se borra.
- **Lo que llega en el PR siguiente:** las pestañas «Documentos» (con la subida) y «Probar búsqueda», y el aviso del resumen con los documentos que no se indexaron («Ver cuáles» lleva a «Documentos»).
- **Quién la ve en el menú:** creadores y administradores, como dicen el diseño («Quién ve qué») y `ViewKnowledgeBase`. FinOps central sin ser creador ya no la ve: la lista le respondería 403.
- **Una diferencia con el diseño, elegida por el dueño ese día, por menú: «Pantalla con el texto exacto (Recomendada)».** Cuando una fuente pasa los topes (`status_reason: full`, (43)), la sincronización copió hasta el tope y la KB se usa. El diseño dice «No empezó · supera el tope»; la pantalla muestra «Con avisos» y «Se copió hasta el tope: el bucket tiene más de 1.000 documentos o 5 GB. Acota el prefijo o reparte los documentos en varias knowledge bases.». Va en el brief del 2026-10-23 para que Claude Design la corrija.
- **Lo que el servidor no tiene y la pantalla muestra con «—»:** los tokens y los fragmentos de una KB. El indicador de documentos suma los bytes en vez de los tokens, y «Consultas · 30 días» sigue «Próximamente».
- **Textos que el diseño no trae:** los errores del servidor al proponer un bucket que no existe o que no se pudo comprobar, una propuesta ya pendiente, un bucket que ya es fuente y una KB que se creó sin poder enviar su bucket. Van en el brief.

**(46) Estado de lo construido: la pantalla, segunda parte (2026-10-23).** Construida con tests (Vitest y Playwright contra el mock), sin ver en una instalación. Completa la pantalla de (45).

- **«Documentos»:** los no indexados con su motivo, los que están en curso y los indexados (20 y «Mostrar más»), los topes, y «Quitar» con confirmación en la fila, solo en una KB de archivos. En una KB de bucket dice de dónde vienen. Quien no ve los documentos recibe el estado bloqueado del diseño. La lista se vuelve a leer mientras haya documentos en curso. El resumen cuenta los no indexados y «Ver cuáles» lleva a esta pestaña.
- **La subida (D88 (30)):**
  - el navegador rechaza lo que el servidor rechazaría, con sus números (50 MiB por archivo, 1.000 documentos y 5 GiB por KB, 20 por vez);
  - pide la firma de los demás y sube cada uno con su POST prefirmado, con su progreso;
  - al guardar, lo que el servidor rechaza se queda en la lista con su motivo;
  - salir con archivos subidos sin guardar pide confirmar, como en el diseño;
  - una KB de archivos recién creada se abre en su subida.
- **El POST va solo a una URL https** (el bucket, que nombra la CSP) o a este mismo origen (el mock), nunca con cookies ni con el token. Es un `XMLHttpRequest`, porque `fetch` no informa el progreso de una subida.
- **«Probar búsqueda» (D88 (37)):** sus tres estados bloqueados (no ve los documentos; no está en sus grupos, diciendo si haberla creado o ser administrador no basta; nada indexado). Los fragmentos, con documento, página y puntaje, se muestran como texto plano.
- **Diferencias con el diseño, para el brief del 2026-10-23:**
  - el servidor no da las páginas de un documento;
  - los motivos que el servidor da y el diseño no nombra tienen un texto propio («El tamaño no es el que se subió», «No se terminó de subir», «Está vacío», «No se pudo guardar», «La knowledge base llegó a su tope», «No se pudo indexar»);
  - «PDF protegido con contraseña» se dice «Protegido con contraseña», porque también vale para DOCX y XLSX;
  - el tipo que no coincide lo responde el servidor al guardar, no al terminar de subir;
  - la web no tiene el ícono de subida del diseño y usa el de documento.

**(47) Estado de lo construido: las KBs en el Agent Builder y en la revisión (2026-10-23).** Construido con tests (Vitest y Playwright contra el mock), sin ver en una instalación. Es la parte de pantalla de (35).

- **Builder, sección «Knowledge bases»** (entre Tools y Límites):
  - ofrece solo las que su autor puede usar, en sus grupos y sin estar borrándose, con su fuente, su tamaño, sus grupos y su estado si no está al día;
  - permite hasta 5 y desactiva las demás con «Máximo 5 por agente»;
  - las que la versión ya tenía y el autor no puede usar se conservan y dicen por qué («Ya no existe», «Se está borrando», «No estás en sus grupos · se conserva»), con «Quitar»;
  - la alerta de D26 se calcula con los grupos elegidos.

  Es parte de la versión: cuenta en el contador de cambios. Los dos códigos del servidor tienen el texto del diseño y llevan a la sección. Un modelo sin tools tampoco puede tener KBs, como en el servidor. Antes de enviar, una KB que ya no existe o se está borrando bloquea.
- **Revisión:** «knowledge bases · n» o «n agregadas, m quitadas», después de las tools, con el estado de cada una, «Ya no existe» y la alerta de D26 que da la versión. Una quitada se nombra con la lista de KBs que ve quien revisa. Ya no van a «otros cambios».
- **Lo que el diseño no trae, para el brief del 2026-10-23:**
  - el texto de los dos códigos de KB en la revisión (la revisión tiene su propio texto por regla);
  - el aviso de la sección cuando la lista de KBs no se pudo leer.

**(48) Las propuestas de bucket en Aprobaciones: lo propio y lo decidido (2026-10-23).** El diseño de la ronda 17 muestra las propuestas en Aprobaciones y en la Bandeja:
- a los administradores, todas, también las decididas («Hechas»);
- a quien propuso, las suyas, con «Retirar propuesta».

`GET /api/knowledge-sources/pending` (38) solo da las pendientes que quien mira puede firmar. El dueño eligió por menú, ese día, «PR de servidor antes». El detalle lo propuso un agente:

- **`GET /api/knowledge-sources`:** para quien ve la lista de KBs (`ViewKnowledgeBase`):
  - las pendientes que puede firmar (`ApproveKbSource` sobre su KB) y las que propuso él, que nunca firma (20);
  - las decididas de los últimos 30 días (aprobadas, rechazadas o retiradas), si las puede firmar o las propuso. Como mucho 50, las más recientes primero.
  - Nunca las de una KB que se está borrando.
- **Qué trae cada una, además de lo de una fuente:** el nombre, los grupos y la frecuencia de su KB, y en una pendiente que cambia el bucket, el que lee ahora (`replaces`). La nota y los correos siguen la regla de (42): administradores, el dueño de la KB y quien propuso.
- **Cómo:** al dejar `pending`, la fuente no sale del índice `All`: pasa a `all_pk = SRC_DECIDED`, con `created_at` el momento de la decisión. Las decididas antes de este cambio no aparecen en «Hechas». También guarda cuándo se retiró (`removed_at`, que ya escribía).
- `…/pending` sigue igual.
