# Mango Hub — Almacenamiento vectorial / RAG (investigación, 2026-09-28)

> Alcance: cómo resuelve RAG `aws-samples/bedrock-chat` (commit `4419d62`), qué se puede reutilizar y qué alternativas vectoriales hay en AWS a septiembre de 2026, con precios verificados en la web (us-east-1) y una recomendación para Mango.
> Las rutas `ruta:línea` son relativas a la raíz del repo clonado. Los precios salen de páginas oficiales de AWS salvo que se indique otra cosa. Las estimaciones propias van marcadas como **(est.)**.

---

## 0. TL;DR

1. **bedrock-chat** usa **Bedrock Knowledge Bases (customer-managed) + OpenSearch Serverless (AOSS)**. Crea **una colección AOSS y un stack de CloudFormation por bot** (modo `dedicated`), o **una KB compartida por cada combinación única de configuración** (modo `shared`), con aislamiento por metadata `tenants: ["BOT#<id>"]`. No hace reranking. Hybrid search solo funciona porque el backend es AOSS. Hay que aprovisionar vía **CodeBuild + `cdk deploy` por bot**, lo que no escala para un marketplace.
2. **Cambios de 2026 que pesan en la decisión** (todos verificados):
   - **S3 Vectors** es GA desde dic-2025: 2.000 M de vectores por índice, 10.000 índices por bucket, ~100 ms en consultas frecuentes y <1 s en infrecuentes. Almacenamiento a **$0.06/GB-mes** y consultas a **$2.50/M**. Es un vector store nativo de Bedrock KB, pero **sin hybrid search**.
   - **Bedrock Managed Knowledge Base** es GA desde el 17-jun-2026. Bedrock gestiona el vector store, el parsing, los embeddings, el hybrid search, el reranking, la *agentic retrieval*, 6–7 conectores (incluido Google Drive) y el **filtrado ACL por usuario**. Cuesta **$5/GB de datos crudos al mes + $1 por 1.000 Retrieve**.
   - **OpenSearch Serverless NextGen** es GA desde el 28-may-2026, con **scale-to-zero** (10 min de inactividad, arranque en frío de 10–30 s) y *collection groups* (feb-2026). No confirmé que Bedrock KB lo soporte como backend.
   - **Aurora Serverless v2 escala a 0 ACU**, con reanudación en ~15 s.
3. **Recomendación:**
   - **Por defecto (tier Standard):** Bedrock KB customer-managed sobre **S3 Vectors**, con un modelo *pooled*. El aislamiento por tenant, KB y rol va en metadata filtrable, y el filtro lo inyecta siempre el backend de Mango. El reranker es opcional. Coste casi nulo en idle: < $1/mes en el escenario chico.
   - **Tier Premium/Enterprise:** **Bedrock Managed KB** cuando se necesitan conectores con ACL nativa (Drive, SharePoint, Confluence), hybrid search y agentic retrieval. El coste se traslada al cliente.
   - **Tier "baja latencia / hybrid avanzado"** (opcional): OpenSearch (NextGen o managed) con motor S3 Vectors.
   - GraphRAG con Neptune Analytics solo como add-on por agente.
   - Descartados como vector store principal: AOSS Classic, Kendra, MemoryDB/ElastiCache.

---

## 1. Cómo hace RAG bedrock-chat (análisis del código)

### 1.1 Topología: una colección por bot, o una KB compartida por "hash de configuración"

| Aspecto | Qué hace | Referencia |
|---|---|---|
| Modo `dedicated` (por defecto en la UI) | Por cada bot con documentos o URLs crea en un **stack CDK propio**: `VectorCollection` AOSS, `VectorIndex`, `VectorKnowledgeBase` y `S3DataSource` | `cdk/lib/bedrock-custom-bot-stack.ts:86-149`, default `frontend/src/features/knowledgeBase/constants/index.ts:51` |
| Índice | Nombre y campo fijos (`bedrock-knowledge-base-default-index` / `-vector`), `float`, distancia `l2`. `AMAZON_BEDROCK_TEXT_CHUNK` es filtrable y eso habilita el hybrid search | `cdk/lib/bedrock-custom-bot-stack.ts:96-118` |
| Réplicas | `standbyReplicas` según `enableRagReplicas`. **Default `true`** en el stack principal y `false` en los stacks por bot | `cdk/lib/utils/parameter-models.ts:99`, `:166-185`, `cdk/lib/bedrock-custom-bot-stack.ts:90-95` |
| KB existente (BYO) | Si el bot trae `existKnowledgeBaseId`, solo la referencia y **asume el tipo OpenSearch Serverless** | `cdk/lib/bedrock-custom-bot-stack.ts:184-211` |
| Modo `shared` | Stack `BrChatSharedKbStack` con **una KB + colección por cada configuración distinta** (hash MD5 de embeddings, chunking, parser, analyzer…) | `cdk/lib/bedrock-shared-knowledge-bases-stack.ts:40-58`, hash en `backend/app/repositories/models/custom_bot_kb.py:102-126` |
| Multi-tenancy en `shared` | Una Lambda de **custom transformation** lee la ruta S3 `/<userId>/<botId>/documents/<file>` e inyecta `fileMetadata.tenants = ["BOT#<botId>"]` | `cdk/lambda/knowledge-base-custom-transformation/index.ts:18-36`, cableado en `cdk/lib/bedrock-shared-knowledge-bases-stack.ts:118-155` |
| Filtro en consulta | `Retrieve` con `filter: {listContains: {key: "tenants", value: "BOT#<id>"}}` solo si la KB es shared | `backend/app/vector_search.py:86-94` |

**Implicación de costes:** en AOSS Classic las colecciones que comparten clave KMS comparten OCUs, así que el suelo no es por bot sino por cuenta/clave. Aun así el mínimo es **2 OCU (~$350/mes) con redundancia** o **1 OCU (~$175/mes) sin ella**, y el suelo se paga aunque no haya tráfico. El README lo documenta (`README.md:569-578`).

### 1.2 Ingestión, chunking, parsing, embeddings

- **Fuentes:** S3 (bucket propio con el prefijo `<user>/<bot>/documents/` o URLs `s3://` externas) y **Web Crawler** con scope y filtros include/exclude (`cdk/lib/bedrock-custom-bot-stack.ts:134-175`, `:349-387`).
- **Chunking:** `default | fixed_size | hierarchical | semantic | none`, con parámetros (`cdk/lib/utils/bedrock-knowledge-base-args.ts:122-165`; enum en `backend/app/routes/schemas/bot_kb.py:7-13`). Hierarchical tiene presets distintos para Titan y Cohere (`bedrock-knowledge-base-args.ts:149`).
- **Parsing:** es opcional mediante *foundation model parsing*, pero **solo con Claude 3 / 3.5**, que es un catálogo desfasado (`bedrock-knowledge-base-args.ts:64-80`, `bot_kb.py:16-21`). No usa Bedrock Data Automation.
- **Embeddings:** `titan_v2` (1024 dimensiones, el default) o `cohere_multilingual_v3` (`bedrock-knowledge-base-args.ts:48-62`, `bot_kb.py:14`). No hay Cohere Embed v4, Nova multimodal ni dimensiones reducidas.
- **Analyzer léxico:** configurable, orientado a japonés (kuromoji / ICU) (`bedrock-knowledge-base-args.ts:167-238`).
- **Orquestación de la sincronización:** una Step Functions `Embedding` (`cdk/lib/constructs/embedding.ts:247+`):
  1. Bootstrap.
  2. Lock distribuido con **escritura condicional en S3** (`backend/embedding_statemachine/bedrock_knowledge_base/lock.py:14-44`).
  3. **CodeBuild ejecuta `cdk deploy`** del stack del bot o de las KBs compartidas (`embedding.ts:290-300`, y `StartCustomBotBuild` más abajo).
  4. Map de ingestiones.
- **Ingestión incremental** (reutilizable): si hay diff de ficheros, usa `IngestKnowledgeBaseDocuments` / `DeleteKnowledgeBaseDocuments` en lotes de 10 en lugar de un `StartIngestionJob` completo (`backend/embedding_statemachine/bedrock_knowledge_base/synchronize_data_source.py:44-185`).

### 1.3 Recuperación

- La consulta sale de una tool del agente (Strands): `create_knowledge_search_tool`, que llama a `search_related_docs` (`backend/app/strands_integration/tools/knowledge_search.py:12-36`).
- `Retrieve` usa `numberOfResults` y `overrideSearchType` `HYBRID|SEMANTIC` (`backend/app/vector_search.py:57-85`). Si la KB es Kendra, quita el search type (`:109-119`).
- Extrae las citas por tipo de ubicación (S3, WEB, Confluence, Salesforce, SharePoint, Kendra) y el número de página de `x-amz-bedrock-kb-document-page-number` (`vector_search.py:124-185`).
- **No hay reranking, query decomposition, implicit filtering ni agentic retrieval.** Un grep de "rerank" en `backend/app` y `cdk/lib` no devuelve nada.
- **No hay RBAC fino.** El único filtro es por bot. No existe ACL por documento, grupo o rol.

### 1.4 Qué reutilizar y qué no

| Reutilizar | No reutilizar / rediseñar |
|---|---|
| Modelo Pydantic de configuración de KB y su hash (`custom_bot_kb.py`) como "perfil de indexación" | **Un stack CDK / CodeBuild por bot**: es lento (minutos), frágil y choca con cuotas. Mango debe crear KB e índices **por API** (`CreateKnowledgeBase`, `s3vectors:CreateIndex`) desde un servicio de control |
| Ingestión incremental por diff (`synchronize_data_source.py`) | Colecciones AOSS Classic (suelo fijo de coste) |
| Lock con escritura condicional en S3 (`lock.py`) | `listContains` sobre `tenants` como único mecanismo de aislamiento: hay que añadir tenant, KB y ACL como claves separadas y compatibles con S3 Vectors |
| Patrón de custom transformation Lambda para **inyectar metadata de tenant/ACL en la ingestión** (`index.ts`) | Catálogo de parsers y embeddings desfasado (Claude 3.x, Cohere v3) |
| Extracción de citas y páginas (`vector_search.py:124-185`) | Asumir que toda KB existente es OSS (`bedrock-custom-bot-stack.ts:208`) |

---

## 2. Estado actual de los servicios (sep-2026, verificado)

### 2.1 Amazon S3 Vectors
- **GA el 2-dic-2025.** Hasta 2.000 M de vectores por índice, 10.000 índices por bucket y 10.000 buckets por región. "Infrequent queries … under one second, more frequent queries … around 100 milliseconds or less". [AWS What's New](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-vectors-generally-available/), [feature page](https://aws.amazon.com/s3/features/vectors/). En marzo de 2026 se amplió a 17 regiones más ([What's New](https://aws.amazon.com/about-aws/whats-new/2026/03/s3-vectors-expands-17-regions)).
- **Límites** ([docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-limitations.html)):
  - Dimensiones de 1 a 4.096; top-K de hasta 10.000 (100 por página).
  - Metadata: 40 KB por vector, de los que **2 KB son filtrables**; 50 claves; 10 claves no filtrables por índice.
  - Escritura: 1.000 req/s y 2.500 vectores/s por índice.
- **Con Bedrock KB:** 1 KB de metadata custom y 35 claves por vector. Solo float32. No soporta `startsWith` ni `stringContains`. El chunking jerárquico con muchos tokens puede exceder la metadata no filtrable ([docs Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-setup.html), [kb-test-config](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html)).
- **Sin hybrid search en Bedrock KB:** "Hybrid search is only supported for Amazon RDS, Amazon OpenSearch Serverless, and MongoDB vector stores" ([kb-test-config](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html)). Para hybrid hay que ir a OpenSearch con motor S3 Vectors.
- **Precio** us-east-1 ([S3 pricing](https://aws.amazon.com/s3/pricing/)):

  | Concepto | Precio |
  |---|---|
  | Almacenamiento | $0.06/GB-mes |
  | PUT | $0.20/GB (mínimo 128 KB por PUT) |
  | Consulta | $2.50/M de consultas |
  | Datos procesados | $0.004/TB (primeros 100K vectores), $0.002/TB (100K–10M), $0.0004/TB (>10M) |
  | Datos devueltos | $0.01/GB (los primeros 512 KB por consulta, gratis) |

### 2.2 Bedrock Managed Knowledge Base (nuevo, GA 17-jun-2026)
- Bedrock gestiona el datastore, el parser multimodal, los embeddings, el reranker, el **hybrid search** y la **agentic retrieval** ([What's New](https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-managed-knowledge-base/), [docs](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html)).
- **Conectores:** S3, SharePoint, Confluence, Web Crawler, **Google Drive**, OneDrive y Custom. Se integra con AgentCore Gateway.
- **ACL-aware retrieval** ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-acl.html)):
  - Se pasa `userContext.userId` (email) en `Retrieve` ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-retrieve-acl.html)).
  - Verificación en tiempo real en SharePoint, OneDrive, Drive y Confluence. En S3 y Custom la ACL la define un fichero del cliente.
  - Falla cerrado: ante error no devuelve el documento.
  - AWS advierte que es **"filtering, not authorization"**: Mango debe autenticar al usuario.
  - Desde el 9-sep-2026 hay APIs para depurar ACLs ([What's New](https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-bedrock-knowledge-base-debugging-document-access-control/)).
- **Cuotas** ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-quotas.html)):
  - 10.000 KBs por cuenta y región (ajustable).
  - 200 data sources por KB.
  - 10 TB por KB.
  - **600 Retrieve RPM por KB** (ráfaga de 25 RPS, ajustable).
  - 300 AgenticRetrieve RPM por cuenta.
- **Precio** ([Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)):
  - **$5.00 por GB de datos crudos al mes.**
  - **$1.00 por 1.000 Retrieve.**
  - Agentic: $4 por 1.000 más $1 por 1.000 retrieves subyacentes.
  - Parsing, embeddings y reranker gestionados: $0.
- **Regiones:** us-east-1, us-west-2, Sydney, Tokyo, Dublin, Frankfurt, London y GovCloud.
- **Riesgo:** el soporte en CloudFormation/CDK va por detrás ([dev.to](https://dev.to/bijkler/aws-bedrock-managed-knowledge-bases-should-we-use-them-3119)).

### 2.3 Bedrock KB customer-managed (el modelo de bedrock-chat)
- **Vector stores soportados:** AOSS, OpenSearch managed, S3 Vectors, Aurora PostgreSQL, Neptune Analytics (GraphRAG), Pinecone, Redis Enterprise Cloud y MongoDB Atlas. **MemoryDB y ElastiCache no están** ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-setup.html)).
- **OpenSearch managed exige un dominio con *Public access***: "OpenSearch domains that are behind a VPC are not supported" (misma fuente).
- **Cuotas** ([AWS General Reference – Bedrock](https://docs.aws.amazon.com/general/latest/gr/bedrock.html)):
  - **100 KBs por cuenta, no ajustable.**
  - 5 data sources por KB.
  - **Retrieve: 20 req/s**.
  - 1 ingestion job concurrente por KB y 5 por cuenta.
  - IngestKnowledgeBaseDocuments: 5 RPS y 25 docs por llamada.
  
  Esto **impide el patrón "1 KB por bot/agente"** de bedrock-chat en un marketplace y obliga a un **modelo pooled con filtros de metadata**.
- **Reranking:** Cohere Rerank 3.5 cuesta **$2 por 1.000 consultas** ([Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)).
- **Filtros:** equals, in, notIn, rangos, andAll/orAll, listContains y stringContains. `in`, `notIn` y `listContains` están "best supported" en AOSS y Neptune. También hay implicit filtering con modelos Claude ([kb-test-config](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html)).
- **Embeddings:** Titan Text Embeddings V2 a **$0.02/M tokens**; Cohere Embed v4 a $0.12/M ([nOps](https://www.nops.io/blog/amazon-bedrock-pricing/), [LLMReference](https://www.llmreference.com/model/titan-text-embeddings-v2/aws-bedrock); fuentes de terceros, confirmar en la consola).

### 2.4 OpenSearch Serverless (AOSS)
- **Classic:** $0.24 por OCU-hora (indexación y búsqueda) y $0.024/GB-mes de almacenamiento.
  - Suelo de **2 OCU con redundancia (~$350/mes)**: "billed at least for a minimum of 2 OCUs (1 OCU [0.5 x 2] indexing … 1 OCU [0.5 x 2] search)".
  - Suelo de **1 OCU (~$175/mes) en modo dev/test sin standby** ([pricing](https://aws.amazon.com/opensearch-service/pricing/), `README.md:578`).
  - Los vectores HNSW deben caber en RAM.
- **NextGen**, GA el 28-may-2026 ([AWS blog](https://aws.amazon.com/blogs/big-data/the-next-generation-of-amazon-opensearch-serverless-built-from-the-ground-up-for-agents/)):
  - Sin mínimo de OCU. **Scale-to-zero tras 10 min** (no configurable), con **10–30 s en la primera petición** ([docs](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-scale-to-zero.html)).
  - Collection groups obligatorios. Standby replicas siempre habilitadas. Indexación HNSW acelerada con GPU.
  - Mismo precio por OCU. Caylent estima ~$107/mes para una carga "ráfagas en horario laboral" frente a ~$420 en Classic ([Caylent](https://caylent.com/blog/amazon-open-search-serverless-next-gen-whats-new)).
  - **No encontré documentación que confirme NextGen como backend de Bedrock KB** → verificar.
- **Collection groups** (10-feb-2026): comparten OCU entre colecciones con distintas claves KMS y admiten min/max de OCU ([What's New](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-opensearch-serverless-supports-collection-groups)).

### 2.5 Otros

| Servicio | Datos verificados |
|---|---|
| **Aurora PostgreSQL Serverless v2 + pgvector** | $0.12/ACU-h (Standard), $0.10/GB-mes y $0.20/M I/O ([pricing](https://aws.amazon.com/rds/aurora/pricing/)). **Escala a 0 ACU con auto-pause** (timeout de 300–86.400 s, reanudación en ~15 s) ([docs](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)). Soporta hybrid en Bedrock KB desde abr-2025 ([What's New](https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-bedrock-knowledge-bases-hybrid-search-aurora-postgresql-mongo-db-atlas-vector-stores)) y quick create ([What's New](https://aws.amazon.com/about-aws/whats-new/2024/12/amazon-aurora-quick-create-vector-store-bedrock-knowledge-bases/)). AWS recomienda `hnsw.iterative_scan` (pgvector ≥0.8) para no perder resultados con filtros selectivos ([docs Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-setup.html)). Latencia p50 de ~32 ms con HNSW en el benchmark de AWS ([blog, 17-sep-2026](https://aws.amazon.com/blogs/machine-learning/selecting-a-vector-store-for-amazon-bedrock-knowledge-bases/)) |
| **OpenSearch managed** | gp3 a $0.122/GB-mes ([pricing](https://aws.amazon.com/opensearch-service/pricing/)). t3.small.search ≈ $0.036/h y r7g.large.search ≈ $0.178/h ([Vantage](https://instances.vantage.sh/aws/opensearch/t3.small.search), terceros). Admite el motor S3 Vectors para hybrid sobre almacenamiento barato ([S3 Vectors integration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-integration.html)). Para Bedrock KB exige endpoint público |
| **Kendra GenAI Enterprise** | **$0.32/h (~$234/mes) por índice** con 20.000 docs o 200 MB de texto y 0,1 QPS. Storage units a $0.25/h, query units a $0.07/h y conectores a $30/mes. Se cobra desde que se crea el índice ([pricing](https://aws.amazon.com/kendra/pricing/)) |
| **Neptune Analytics (GraphRAG)** | Ejemplo oficial: **~$0.48/h con 16 m-NCU (~$350/mes)** ([AWS blog](https://aws.amazon.com/blogs/machine-learning/announcing-general-availability-of-amazon-bedrock-knowledge-bases-graphrag-with-amazon-neptune-analytics/)). En pausa se paga el 10% del cómputo ([pricing](https://aws.amazon.com/neptune/pricing/)). Database Savings Plans de hasta 35% desde mar-2026 ([usage.ai](https://www.usage.ai/blogs/aws/database-savings-plans/neptune-pricing/), terceros) |
| **ElastiCache (Valkey) / MemoryDB vector** | Vector search en ElastiCache GA desde el 13-oct-2025, con latencia de microsegundos ([What's New](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-elasticache-vector-search/)). Es memoria pura: en Serverless Valkey cuesta ~**$0.084/GB-hora ≈ $61/GB-mes** ([usage.ai](https://www.usage.ai/blogs/aws/database-savings-plans/elasticache/serverless-pricing/), terceros). MemoryDB cobra por nodo más $0.20/GB escrito ([pricing](https://aws.amazon.com/memorydb/pricing/)). **No es backend de Bedrock KB** |
| **No-AWS (referencia)** | Pinecone Serverless: mínimo de $50/mes, $0.33/GB-mes, $16/M RU; soportado por Bedrock KB ([Pinecone](https://www.pinecone.io/pricing/)). turbopuffer: mínimo de $16/mes ([pricing](https://turbopuffer.com/pricing)). MongoDB Atlas y Redis Cloud también son backends de KB. Ninguno aporta algo que Mango necesite y que no tenga dentro de AWS |

---

## 3. Escenarios y comparativa de costes

### 3.1 Supuestos **(est.)**

| | Chico | Mediano | Grande |
|---|---|---|---|
| KBs lógicas (agentes o colecciones) | 10 | 100 | 1.000 |
| Documentos crudos | 1 GB | 50 GB | 1 TB |
| Chunks (≈25% es texto extraíble, chunks de ~300 tokens con solape) | ~250 K | ~10 M | ~200 M |
| Tamaño de un vector de 1024 dimensiones float32 más texto y metadata | ~6 KB | idem | idem |
| Volumen vectorial | ~1,5 GB | ~60 GB | ~1,2 TB |
| Retrieves al mes | 50 K | 1 M | 10 M |
| Patrón | horario laboral, mucho idle | mixto | 24x7 |

**Embedding** (pago único por (re)indexación, con Titan V2 a $0.02/M tokens): ≈ $1,6 (chico), ≈ $80 (mediano), ≈ $1.600 (grande). Es igual para todas las opciones customer-managed y en Managed KB va incluido.

### 3.2 Coste mensual del vector store (us-east-1, sin LLM ni embeddings)

| Opción | Chico | Mediano | Grande | Notas del cálculo |
|---|---|---|---|---|
| **S3 Vectors (vía Bedrock KB)** | **≈ $0,3** (1,5 GB × $0,06 + 50K × $2,5/M, más procesado despreciable) | **≈ $8** ($3,6 + $2,5 + ~$1,7 de procesado con índices de ~100 K vectores) | **≈ $125** ($72 + $25 + ~$26) | Coste único de PUT: $0,3 / $12 / $240. Sin hybrid. Con **Cohere Rerank** en cada consulta se suman $100 / $2.000 / $20.000 |
| **Bedrock Managed KB** | **≈ $55** ($5 + $50) | **≈ $1.250** ($250 + $1.000) | **≈ $15.000** ($5.000 + $10.000) | Incluye parsing, embeddings, rerank, hybrid, conectores y ACL. **El coste por Retrieve domina** |
| **AOSS Classic** (sin/con redundancia) | $175 / $350 | ≈ $2.000–3.500 **(est.)**, 8–14 OCU con ~50 GB de HNSW en RAM | ≈ $6.000–25.000+ **(est.)**; hace falta cuantización o modo on-disk | Suelo fijo aunque no haya uso |
| **AOSS NextGen** (scale-to-zero) | ≈ $50–110 **(est.**, ref. Caylent $107) | ≈ $1.500–3.000 **(est.)** | igual que Classic en 24x7 | Arranque en frío de 10–30 s. **Soporte en Bedrock KB sin confirmar** |
| **Aurora Serverless v2 + pgvector** | ≈ $30–90 (0–1 ACU con auto-pause) | ≈ $1.400–2.800 **(est.**, 16–32 ACU para un índice HNSW de 25–50 GB en RAM, halfvec/fp32) | no recomendado (índice de ~1 TB) | Hybrid sí. Reanudación en ~15 s. Una tabla con filtro GIN por tenant |
| **OpenSearch managed** | ≈ $28 (1× t3.small, sin HA) / ≈ $400 (3× r7g.large, HA) | ≈ $800–1.200 **(est.**, 3× r7g.xlarge con fp16) | ≈ $2.500–5.000 **(est.**, on-disk/cuantizado o motor S3 Vectors) | Hybrid completo. En Bedrock KB **requiere endpoint público**. Operación de clúster a cargo de Mango |
| **Kendra GenAI** | ≈ $400 (base más 1 storage unit) + $30 por conector | > $5.000 **(est.)** | no viable | Se cobra por índice desde su creación |
| **Neptune Analytics (GraphRAG)** | ≈ $350 (16 m-NCU); ~$35 en pausa | ≈ $1.400–2.800 **(est.**, 64–128 m-NCU) | no viable como store general | Solo para agentes que necesitan grafo |
| **ElastiCache Valkey serverless** | ≈ $95 | ≈ $3.700 | ≈ $73.000 | En RAM a ~$61/GB-mes. Útil como semantic cache o memoria de agente, no para KB |
| Pinecone serverless (ref.) | $50 (mínimo) | ≈ $50–150 **(est.)** | ≈ $400–1.500 **(est.)** | Tercero. Implica egress y DPA adicionales |

### 3.3 Latencia, hybrid, filtros y madurez

| Opción | Latencia de retrieve | Hybrid en Bedrock KB | Filtros para tenant/RBAC | Límites relevantes | Madurez |
|---|---|---|---|---|---|
| S3 Vectors | ~100 ms (caliente), <1 s (frío) | **No** | equals, in, rangos. 2 KB filtrables, 35 claves con KB. Sin `startsWith`/`stringContains` | 1.000 escrituras/s por índice | GA desde dic-2025 |
| Managed KB | no publicado (hybrid + rerank; medir) | **Sí** | **ACL por usuario/grupo nativa**; data sources ACL y no-ACL mezclados | 600 RPM por KB, 10 TB por KB | GA desde jun-2026 (nuevo) |
| AOSS Classic / NextGen | <50 ms (AWS) | **Sí** | Todos los operadores (el mejor soporte) | RAM | Classic maduro; NextGen de 4 meses |
| Aurora pgvector | ~30–100 ms | **Sí** | JSONB + GIN; iterative scan | RAM por ACU (máx. 256 ACU) | Maduro |
| OpenSearch managed | <50 ms | **Sí** | Completo | Endpoint público para Bedrock KB | Maduro |
| Kendra GenAI | ~cientos de ms | n/a (búsqueda propia) | ACL por documento | 0,1 QPS base | Maduro, pero caro |
| Neptune Analytics | ~cientos de ms (grafo + vector) | No | Soporte bueno de `in`/`notIn` | m-NCU | GA desde 2025 |

---

## 4. Diseño de multi-tenancy y RBAC para RAG

1. **Modelo pooled por defecto.** El límite de **100 KBs customer-managed por cuenta, no ajustable**, hace inviable una KB por agente o cliente.
   - Se crea una KB por "perfil de indexación" (modelo de embeddings, dimensión, chunking), como el hash de bedrock-chat (`custom_bot_kb.py:102-126`), sobre un índice S3 Vectors.
   - En tenants grandes o regulados: **silo** con índice y KB propios. En casos extremos, una cuenta por tenant (patrón de [multi-tenant RAG de AWS](https://aws.amazon.com/blogs/machine-learning/multi-tenant-rag-with-amazon-bedrock-knowledge-bases/)).
2. **Metadata filtrable mínima por chunk:** `tenant_id`, `kb_id` (colección lógica del marketplace), `acl_groups` (lista de roles/grupos de Mango), `classification` y `doc_updated_epoch`.
   - Se inyecta en la ingestión con una **custom transformation Lambda** (patrón de `cdk/lambda/knowledge-base-custom-transformation/index.ts`) o con ficheros `.metadata.json`.
   - Hay que respetar 1 KB y 35 claves en S3 Vectors.
3. **Filtro obligatorio del lado servidor.** La tool o MCP server de retrieval de Mango construye `andAll[equals tenant_id, in kb_id ∈ permitidas, in acl_groups ∩ grupos del usuario]` a partir del **JWT verificado y de la política (Cedar / Verified Permissions)**. **Nunca lo construye el LLM.**
   - El implicit filtering, si se usa, siempre va combinado con `andAll` junto al filtro obligatorio.
   - Hay que validar en S3 Vectors qué operadores sobre listas funcionan de verdad (`in` frente a `listContains`) antes de fijar el esquema, porque bedrock-chat usa `listContains` (`backend/app/vector_search.py:88-93`), que AWS documenta como "best supported" en AOSS.
4. **Managed KB (premium):** se usa `userContext.userId` (email) y la ACL nativa de Drive, SharePoint y Confluence. Es "filtering, not authorization", así que Mango sigue siendo el que autentica. Hay que asegurar que el email corporativo coincide exactamente con el de la fuente.
5. **Auditoría y costes:** cada Retrieve se registra con usuario, agente, KB, filtros aplicados e IDs de chunk devueltos, para el audit trail. El coste de retrieve y rerank se imputa al *budget* del agente.

---

## Recomendación para Mango

### Decisiones

| # | Decisión | Detalle |
|---|---|---|
| D1 | **Vector store por defecto: Bedrock KB (customer-managed) + Amazon S3 Vectors** | Coste casi nulo en idle: ≈$0,3/mes chico, ≈$8 mediano, ≈$125 grande, frente a $175–350/mes de suelo en AOSS Classic. GA, nativo de Bedrock, y escala a 2.000 M de vectores por índice. Encaja con un marketplace de muchos agentes con poco tráfico individual |
| D2 | **Modelo pooled + silo opcional** | Una KB e índice por perfil de indexación y región, con aislamiento por metadata filtrable (`tenant_id`, `kb_id`, `acl_groups`) inyectada en la ingestión y **filtro impuesto por el backend**. Silo (índice/KB dedicado o cuenta dedicada) como opción enterprise |
| D3 | **Tier Premium: Bedrock Managed Knowledge Base** | Para clientes que conectan Google Drive, SharePoint, Confluence u OneDrive y necesitan ACL por usuario, hybrid, rerank y agentic retrieval sin operar nada. Se factura aparte: $5/GB-mes + $1 por 1K retrieves, o $4+$1 por 1K en agentic. Encaja con el agente de Google Drive del roadmap |
| D4 | **Calidad en el tier Standard sin hybrid** | Chunking jerárquico o semántico (cuidando el límite de metadata en S3 Vectors), Titan V2 1024 o Cohere Embed v4 si hay mucho contenido multilingüe, y **reranker bajo demanda** (Cohere Rerank 3.5, $2 por 1K) configurable por agente con su coste imputado al budget. Query rewriting en el orquestador |
| D5 | **Tier "Search+" (opcional, más adelante)** | Para agentes con búsqueda exacta de códigos (SAP: materiales, órdenes) o latencias <50 ms: **OpenSearch con motor S3 Vectors** o **AOSS NextGen** en un collection group con mínimo >0 en horario laboral. Solo tras confirmar que Bedrock KB soporta NextGen; si no, usar retrieval directo contra OpenSearch |
| D6 | **Aurora pgvector solo si Mango ya opera Aurora** para su dominio (catálogo, RBAC, budgets). Es una alternativa hybrid con escala a cero, válida en chico y mediano, pero no como default | |
| D7 | **GraphRAG (Neptune Analytics)** como add-on por agente, pausado fuera de uso. **No usar** Kendra, MemoryDB/ElastiCache (solo para semantic cache o memoria corta de agentes) ni AOSS Classic | |
| D8 | **Plano de control por API, no por CDK** | Sustituir el patrón CodeBuild + `cdk deploy` por bot (`cdk/lib/constructs/embedding.ts:290+`) por un servicio que llame a `CreateKnowledgeBase`, `CreateDataSource` y `s3vectors:CreateIndex`. Reutilizar la Step Functions, el lock S3 (`lock.py`) y la ingestión incremental (`synchronize_data_source.py:44-185`) |
| D9 | **Retrieval como tool/MCP gobernada** | Un único "knowledge-retrieve" MCP server que aplica el filtro RBAC, loguea en el audit trail, mide el coste y abstrae el backend (S3 Vectors, Managed KB u OpenSearch) para poder mover a un tenant de tier sin tocar agentes |

### Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Cuota de Retrieve de 20 req/s por cuenta en KB customer-managed (no ajustable según la General Reference)** | Cuello de botella con muchos usuarios concurrentes | Verificarlo en Service Quotas de la cuenta real. Cache semántico de resultados, reparto por cuentas o regiones, o migrar tenants intensivos a Managed KB (600 RPM por KB, ajustable) |
| **100 KBs por cuenta, no ajustable** | Impide una KB por agente | Modelo pooled (D2) y separación por cuentas para silos |
| S3 Vectors sin hybrid | Peor recall con términos exactos (IDs, SKUs) | Rerank, query rewriting y tier Search+ (D5) |
| Consultas frías en S3 Vectors (<1 s) | Latencia percibida en el chat | Aceptable dentro del loop de un agente. Medir p95 y, si hace falta, precalentar o subir de tier |
| Límites de metadata en S3 Vectors (1 KB y 35 claves con KB; 2 KB filtrables) | Listas `acl_groups` grandes no caben | Usar IDs de grupo cortos o hashes. Si un documento tiene muchas ACLs, silo o Managed KB |
| Operadores de lista (`listContains`/`in`) con soporte desigual por backend | Riesgo de fuga o de falsos negativos en RBAC | Tests automáticos de aislamiento por backend (tenant A nunca ve a B) en CI |
| Managed KB es nuevo (jun-2026): IaC inmaduro, regiones limitadas, precio por retrieve alto a escala | Coste imprevisto de $10K+/mes en grande | Tratarlo como premium con precio *pass-through* y budgets por agente. Custom resources para IaC |
| AOSS NextGen: soporte en Bedrock KB no confirmado; cold start de 10–30 s | Bloquea D5 | PoC antes de comprometerse. Mínimo de OCU >0 en horario laboral |
| ACL de Managed KB basada en email ("not authorization") | Suplantación si el backend pasa un email no verificado | El email sale solo del token IdP verificado. Auditar con `CheckIngestedDocumentAcl` |
| Estimaciones marcadas (est.) | Desvíos de ±50% | Hacer un PoC con corpus real (PDFs de FinOps/SAP) midiendo recall@k, p95 y $ |

### Siguientes pasos sugeridos
1. PoC de 2 semanas con S3 Vectors frente a Managed KB sobre 1 GB de documentos reales: recall@5 con y sin rerank, p50/p95 y coste real en Cost Explorer.
2. Confirmar en la cuenta de Mango las cuotas (Retrieve RPS, número de KBs) y si NextGen funciona como backend de Bedrock KB.
3. Definir el esquema de metadata (tenant, KB, ACL) y los tests de aislamiento antes de ingerir datos de clientes.
