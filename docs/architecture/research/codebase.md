# Análisis de código: aws-samples/bedrock-chat (commit `4419d62`) → reutilización para Mango Hub

> Fecha: 2026-09-28 · Alcance: `backend/` y `frontend/` (y la parte de `cdk/` que afecta directamente al código de aplicación).
> Todas las rutas son relativas a la raíz del repo clonado (`scratchpad/bedrock-chat`). Solo lectura: no se modificó nada.

---

## 0. TL;DR

- **Backend**: Python 3.13 + FastAPI empaquetado en **Lambda** (REST vía Lambda Web Adapter; WebSocket vía handler Lambda nativo), con arquitectura por capas `routes → usecases → repositories → models (pydantic v2)`. Persistencia en **DynamoDB** (2 tablas principales + 1 de sesiones WebSocket) y **S3** para conversaciones grandes.
- **El agente ya NO está hecho a mano**: desde v3 el camino por defecto es **Strands Agents** (`USE_STRANDS=true`, `backend/app/usecases/chat.py:332`). El bucle manual de tool-use con Converse (`converse_legacy`, `chat.py:384-510`) sigue ahí pero está marcado `@deprecated`. Sin embargo, la versión fijada de Strands es vieja (`strands-agents` 1.9.0 en `poetry.lock:3028`; la última es la **1.57.1, del 25-sep-2026**, según [PyPI](https://pypi.org/project/strands-agents/)) y se usa `strands.experimental.hooks`.
- **Tools**: registro estático y pequeño (internet search con DuckDuckGo/Firecrawl, invocación de Bedrock Agent y búsqueda en Knowledge Base). **No hay MCP**: `grep -i mcp` sobre `backend/app`, `frontend/src` y `cdk/lib` no devuelve nada. Tampoco hay memoria de largo plazo, human-in-the-loop, budgets ni audit trail de acciones de agente.
- **RBAC**: tres grupos de Cognito fijos en el código (`Admin`, `CreatingBotAllowed`, `PublishAllowed`), más una ACL por bot (`private | partial | all` con usuarios/grupos permitidos).
- **Dependencia de OpenSearch Serverless**: bot store, búsqueda de conversaciones y KB "dedicated" (una colección OSS **por bot**). Es justo lo que Mango no puede pagar: el mínimo es de ~175–350 USD/mes por colección clásica ([pricing](https://aws.amazon.com/opensearch-service/pricing/)).
- **Frontend**: React 18 + Vite 6 + Tailwind 3 + Amplify v6 (Cognito/OIDC) + zustand/immer + SWR + XState v5 para el streaming, i18n con 17 idiomas (incluye `es`). El código es reutilizable en buena parte: los componentes de chat, el renderizado markdown/mermaid/katex, la máquina de streaming y la UI de tools.
- **Veredicto para Mango**: reutilizar los **patrones** de dominio (árbol de mensajes, repositorios DDB con row-level security, protocolo de eventos de streaming, integración Strands con hooks, UI de chat) y **reescribir** runtime de agentes (→ AgentCore Runtime + Strands actual), tools (→ MCP vía AgentCore Gateway), RBAC (→ modelo org/equipo + Cedar/Verified Permissions o AgentCore Policy), RAG (→ KB compartida sobre **S3 Vectors**), marketplace (→ DynamoDB, sin OSS), budgets, HITL y auditoría (inexistentes).

---

## 1. Mapa de módulos

### 1.1 Backend (`backend/`, ~23k líneas Python incluyendo tests)

| Módulo | Responsabilidad | Referencias clave |
|---|---|---|
| `app/main.py` | App FastAPI. Monta routers según el modo (API normal o *Published API*), CORS, mapea excepciones de dominio a HTTP y tiene un middleware que resuelve el usuario a partir del JWT. | `main.py:61-70` (routers), `main.py:91-100` (excepciones→HTTP), `main.py:103-129` (usuario actual) |
| `app/auth.py`, `app/dependencies.py` | Verificación del JWT de Cognito (python-jose) y dependencias `check_admin`, `check_creating_bot_allowed` y `check_publish_allowed`. | `dependencies.py:11-50` |
| `app/user.py` | Modelo `User` con los grupos y los predicados de rol. | `user.py:28-35`, `user.py:47-56` |
| `app/websocket.py` | Handler Lambda de API Gateway WebSocket: protocolo por trozos (START / partes / END), `NotificationSender` con un hilo y una cola que hace `post_to_connection`. | `websocket.py:42-189`, `websocket.py:256-404` |
| `app/routes/*` | Controladores HTTP finos: `conversation`, `bot`, `bot_store`, `api_publication`, `published_api`, `admin`, `user`, `global_config`. Los esquemas de E/S están en `routes/schemas/*` (pydantic, camelCase con `pyhumps`). | `routes/bot.py:41-163`, `routes/conversation.py:36-162`, `routes/admin.py:25-145` |
| `app/usecases/chat.py` | Orquestación de un turno: prepara la conversación (árbol de mensajes), arma instrucciones y RAG, delega en Strands o en el camino legacy y post-procesa (precio, persistencia, estadísticas). | `chat.py:65-178`, `chat.py:211-380`, `chat.py:513-597` |
| `app/usecases/bot.py` | CRUD de bots, alias de bots compartidos, estrella/pin y permisos. | `usecases/bot.py:349-375` (`fetch_bot`) |
| `app/usecases/publication.py` | Publica un bot como API independiente: lanza **CodeBuild**, que despliega un stack CDK por bot con API GW, usage plan y throttling. | `publication.py:56-80` |
| `app/usecases/global_config.py` | Modelos disponibles, modelo por defecto y modelo para títulos, leídos de variables de entorno. | `global_config.py:16-61` |
| `app/strands_integration/` | Adaptador a Strands: `agent/factory.py` (crea el `Agent`), `agent/config.py` (Converse→`BedrockModel`: guardrails, caching, reasoning), `converters/*` (mensajes y tools entre modelo propio y Strands), `handlers/*` (callback de streaming y hook de tools), `tools/*` (tools `@tool`). | `factory.py:23-58`, `config.py:21-100`, `utils.py:17-80`, `handlers/tool_result_capture.py:24-72` |
| `app/agents/tools/*` | Implementación **legacy** de tools (clase `AgentTool` propia), marcada como deprecated. | `agents/utils.py:19-95` |
| `app/bedrock.py` (1431 líneas) | Catálogo de modelos (IDs base, inference profiles globales/regionales), matriz de capacidades por modelo (tool use, caching, reasoning, top_k...), construcción de argumentos Converse y cálculo de precio. | `bedrock.py:59`, `:94`, `:270` (mapas), `:558-670` (capabilities), `:1183-1310`, `:1326-1366` (`calculate_price`) |
| `app/config.py` | Parámetros de generación por defecto y **tabla de precios hardcodeada** (el comentario dice "based on 2024-03-07"). | `config.py:21-33`, `config.py:60-64` |
| `app/stream.py` | `ConverseApiStreamHandler` (legacy) y los tipos `OnStopInput`/`OnThinking`, que comparten ambos caminos. | `stream.py:36`, `:46`, `:137` |
| `app/vector_search.py` | `Retrieve` contra Bedrock Knowledge Bases (semantic/hybrid), filtro por tenant en KB compartida y extracción de la fuente (S3/Web/Confluence/SharePoint/Salesforce/Kendra). | `vector_search.py:50-195`, filtro `:86-94` |
| `app/repositories/*` | Acceso a DynamoDB, S3, OpenSearch y Athena. `common.py` compone las claves y crea clientes con **row-level security por STS session policy**. | `common.py:41-79`, `common.py:82-141` |
| `app/repositories/models/*` | Modelos de persistencia pydantic con validadores de invariantes y (de)serialización `from_dynamo_item`/`to_output`. | `models/custom_bot.py:357-540`, `models/conversation.py:56-830` |
| `app/sqs_consumer.py` | Consumidor SQS de la Published API: ejecuta `chat()` en asíncrono. | `sqs_consumer.py:8-27` |
| `app/bot_remove.py` | Limpieza al borrar un bot (stack CFN de la KB y archivos en S3), disparada por DynamoDB Streams. | `bot_remove.py:20-40` |
| `embedding_statemachine/bedrock_knowledge_base/*` | Lambdas de una Step Function: bootstrap, lock, sync del data source, finalize y actualización de `SyncStatus`. | p. ej. `synchronize_data_source.py`, `lock.py` |
| `s3_exporter/index.py` | Exportación **incremental** horaria de DDB a S3 (PITR) para analítica con Athena. | `s3_exporter/index.py:12-45` |
| `auth/*` | Triggers de Cognito: añadir usuario a grupos y restringir dominios de email en el self sign-up. | `auth/add_user_to_groups/`, `auth/check_email_domain/` |
| `tests/` | 26 ficheros pytest (unittest + mocks). Algunos llaman a AWS real. | `tests/test_usecases/test_chat.py` (1048 líneas) |

**Empaquetado y runtime** (según CDK): `PythonFunction`, 1024 MB y 15 min para la API (`cdk/lib/constructs/api.ts:241-291`); 512 MB y 15 min para el WebSocket (`cdk/lib/constructs/websocket.ts:107-136`); SnapStart opcional. `backend/Dockerfile` usa Lambda Web Adapter 0.7.0 para desarrollo o contenedor, y `lambda.Dockerfile` apunta a `app.websocket.handler`. La API HTTP usa `HttpUserPoolAuthorizer` (`api.ts:333-350`).

### 1.2 Frontend (`frontend/`)

| Área | Detalle | Referencias |
|---|---|---|
| Stack | React 18, Vite 6, TypeScript 5, Tailwind 3 (+typography, scrollbar), Headless UI, react-router 7, **Amplify v6** (`aws-amplify`, `@aws-amplify/ui-react`), axios + **SWR**, **zustand** + **immer**, **XState v5** (y v4 como alias `xstate-v4`), i18next, react-markdown + remark-gfm/math + rehype-katex/**mermaid**, PWA, Ladle para stories y Vitest. | `frontend/package.json` |
| Auth | `Amplify.configure` con Cognito y OAuth code flow. Dos modos: Authenticator de Amplify (con proveedores sociales) o `AuthCustom` (IdP OIDC, p. ej. Entra ID). | `src/App.tsx:30-64` |
| HTTP | Interceptor de axios que añade el `idToken` como Bearer, y `useHttp` que envuelve SWR (get) y axios (mutaciones). | `src/hooks/useHttp.ts:6-20` |
| Streaming | `usePostMessageStreaming`: **abre un WebSocket nuevo por mensaje**, parte el payload en trozos de 32 KB e implementa el protocolo START/BODY/END. Los eventos del servidor se convierten en eventos de la máquina XState. | `src/hooks/usePostMessageStreaming.ts:8-9`, `:24-28`, `:41-87`, `:92-177` |
| Máquina de streaming | `streamingStateMachine` (sleeping/streaming/leaving) que acumula reasoning, texto, tools y documentos relacionados. | `src/hooks/xstates/streaming.ts:1-80+` |
| Estado de chat | `useChat` (744 líneas): store zustand con `chats[conversationId] = MessageMap`, edición, regeneración y *continue generate*. | `src/hooks/useChat.ts:61-250`, `:511-600` |
| Features | `features/agent` (UI de tools: ToolCard, AvailableTools, FirecrawlConfig, BedrockAgentConfig), `features/knowledgeBase` (`BotKbEditPage`), `features/discover` (bot store), `features/reasoning`. | `src/features/*` |
| Páginas y rutas | Chat, historial, mis bots, recientes, favoritos, discover, edición de bot, ajustes de API y 3 páginas de admin. | `src/routes.tsx:25-81`, `src/pages/*` |
| i18n | 17 idiomas (`de, en, es, fr, id, it, ja, ko, ms, nb, pl, pt-br, th, vi, zh-hans, zh-hant`). | `src/i18n/index.ts` |
| Calidad | ESLint `--max-warnings 0`, Prettier con el plugin de Tailwind, **un solo test unitario** (`src/utils/__tests__/MessageUtils.test.ts`) y muchas stories de Ladle. | `lefthook.yml`, `.github/workflows/frontend.yml` |

---

## 2. Flujo end-to-end de una conversación (WebSocket + Strands)

```mermaid
sequenceDiagram
    autonumber
    actor U as Usuario (SPA React)
    participant AMP as Amplify/Cognito
    participant WS as API GW WebSocket
    participant L as Lambda websocket.handler
    participant SDDB as DDB WebsocketSession (TTL 2 min)
    participant UC as usecases.chat.chat()
    participant BDB as DDB BotTable
    participant CDB as DDB ConversationTable (+S3 si >300KB)
    participant ST as Strands Agent (BedrockModel)
    participant BR as Bedrock Converse Stream
    participant KB as Bedrock KB Retrieve / tools

    U->>AMP: fetchAuthSession() → idToken
    U->>WS: new WebSocket() + {step:START, token}
    WS->>L: route $default
    L->>L: verify_token(JWT)
    L->>SDDB: put(ConnectionId, part 0, UserId)
    L-->>U: "Session started."
    loop por cada trozo de 32KB
      U->>WS: {step:BODY, index, part}
      L->>SDDB: put(ConnectionId, index+1, part)
      L-->>U: "Message part received."
    end
    U->>WS: {step:END, token}
    L->>SDDB: query partes y concatenar
    L->>UC: chat(user, ChatInput, callbacks)
    UC->>CDB: find_conversation_by_id (GSI SKIndex)
    alt conversación nueva con bot
      UC->>BDB: find_bot_by_id (GSI BotIdIndex) + is_accessible_by_user
      Note over UC: si no es dueño → store_alias
    end
    UC->>UC: trace_to_root(message_map) → historial lineal
    UC->>ST: create_strands_agent(model, tools, hooks, system_prompt)
    ST->>BR: ConverseStream (guardrails, cachePoint, reasoning)
    BR-->>ST: deltas de texto/reasoning
    ST-->>L: callback(data) → on_stream
    L-->>U: {status:STREAMING, completion}
    opt tool use
      ST->>L: BeforeToolInvocation → on_thinking
      L-->>U: {status:AGENT_THINKING, log}
      ST->>KB: tool (knowledge_base_tool / internet_search / bedrock_agent)
      KB-->>ST: resultados
      ST->>L: AfterToolInvocation → on_tool_result (+source_id para citas)
      L-->>U: AGENT_TOOL_RESULT + AGENT_RELATED_DOCUMENT*
      ST->>BR: siguiente iteración
    end
    ST-->>UC: AgentResult (stop_reason, message, métricas de tokens)
    UC->>UC: calculate_price(tabla estática)
    UC->>CDB: store_conversation (+ related documents)
    UC-->>L: on_stop
    L-->>U: {status:STREAMING_END, token_count, price}
    UC->>BDB: update last_used_time + usage_stats
    U->>U: ws.close(); SWR revalida la conversación
```

Notas:
- La conversación se guarda **antes** de emitir `STREAMING_END` para que el front no reciba un 404 al revalidar (`chat.py:576-587`).
- El título se genera aparte (`propose_conversation_title`, `chat.py:~637`) con el modelo de títulos.
- En la **Published API**, `POST /conversation` solo encola en SQS (`routes/published_api.py:29-72`). `sqs_consumer.handler` ejecuta `chat()` sin callbacks y el cliente consulta después con `GET /conversation/{id}/{messageId}`.

---

## 3. Modelo de datos

### 3.1 Tablas DynamoDB (`cdk/lib/constructs/database.ts:28-105`)

**ConversationTable** (PK/SK, on-demand, Streams NEW_IMAGE, GSI `SKIndex` por SK)

| Item | PK | SK | Atributos |
|---|---|---|---|
| Conversación | `user_id` | `{user_id}#CONV#{conv_id}` | `Title`, `CreateTime`, `TotalPrice`, `LastMessageId`, `BotId`, `ShouldContinue`, **`MessageMap` (JSON de todo el árbol)** o `IsLargeMessage` + `LargeMessagePath` en S3 (`repositories/conversation.py:32-90`) |
| Documento relacionado (cita) | `user_id` | `{user_id}#RELATED_DOCUMENT#{conv_id}#{source_id}` | contenido, `source_name`, `source_link`, `page_number` |

La SK lleva el `user_id` como prefijo para cumplir la condición `dynamodb:LeadingKeys` de la session policy (`common.py:41-56`, `:123-127`).

**BotTable** (PK/SK, Streams, PITR para zero-ETL)

| Item | PK | SK | Notas |
|---|---|---|---|
| Bot | `owner_user_id` | `BOT#{bot_id}` | `ItemType={user}#BOT`, `BotId`, `Instruction`, `AgentData`, `Knowledge`, `GenerationParams`, `BedrockKnowledgeBase`, `GuardrailsParams`, `SharedScope`/`SharedStatus` (**sparse**), `IsStarred` (**sparse**), `AllowedCognitoGroups/Users`, `ActiveModels`, `UsageStats`, `SyncStatus`, `ApiPublishment*` (`repositories/custom_bot.py:48-99`) |
| Alias (bot compartido "adoptado") | `user_id` | `ALIAS#{bot_id}` | copia desnormalizada de título/descripción/quick starters + `IsOriginAccessible` |

Índices: LSI `StarredIndex` y `LastUsedTimeIndex`; GSI `BotIdIndex`, `SharedScopeIndex (SharedScope, SharedStatus)`, `ItemTypeIndex` y `SyncStatusIndex`.

**WebsocketSessionTable**: `ConnectionId` / `MessagePartId` (número) con TTL `expire` de 2 minutos.

**Fuera de DynamoDB**
- S3: conversaciones grandes, documentos de la KB por bot (`{user}/{bot}/...`) y exportaciones para Athena.
- OpenSearch Serverless: índices `bot` y `conversation`, alimentados por **OSIS** (zero-ETL desde DDB Streams/PITR) (`cdk/lib/constructs/bot-store.ts:46-300`). Los usan `repositories/bot_store.py` y `repositories/conversation_search.py`.
- Secrets Manager: API keys de tools (Firecrawl), guardadas y cargadas con validadores pydantic (`models/custom_bot.py:122-161`).
- Bedrock KB: una KB y una colección OSS **por bot** en modo "dedicated" (`cdk/lib/bedrock-custom-bot-stack.ts:85-125`), o una KB compartida con filtro de metadatos `tenants=BOT#{id}` (`vector_search.py:86-94` y `cdk/lambda/knowledge-base-custom-transformation`).

### 3.2 Modelo conversacional (`repositories/models/conversation.py`)

- `ConversationModel.message_map: dict[str, MessageModel]` forma un **árbol**. Los nodos raíz son sintéticos: `system` e `instruction` (el prompt del bot) (`chat.py:91-132`). Cada `MessageModel` tiene `parent`, `children`, `model`, `feedback`, `used_chunks` y **`thinking_log`** (los pares toolUse/toolResult intermedios) (`conversation.py:708-793`).
- Los contenidos son una unión discriminada por `content_type`: `text | image | attachment | toolUse | toolResult | reasoning` (`conversation.py:56-676`). Los resultados de tool pueden ser text, json, image o document.
- `trace_to_root` convierte el árbol en el historial lineal que ve el modelo e intercala el `thinking_log` (`chat.py:181-208`). Esto soporta de forma natural **editar y regenerar ramas** y el *continue generate* cuando se alcanza `max_tokens` (`chat.py:531-562`).

### 3.3 Bot (`models/custom_bot.py:357-540`)

- `AgentModel.tools: list[PlainTool | InternetTool | BedrockAgentTool]` (discriminado por `tool_type`), más `KnowledgeModel` (URLs, sitemaps, archivos y S3), `BedrockKnowledgeBaseModel` (chunking, embeddings, parsing, search params), `BedrockGuardrailsModel`, `GenerationParamsModel` (incluye `reasoning_params.budget_tokens`), `ActiveModels` (modelo pydantic **dinámico** con un booleano por modelo, `custom_bot.py:53-68`) y `ConversationQuickStarterModel`.
- Invariantes con `model_validator`: coherencia entre scope y status, limpieza del KB id si no hay fuentes y limpieza del ARN del guardrail si está desactivado (`custom_bot.py:418-483`).

---

## 4. Invocación de Bedrock, agente y tools

1. **Selección de modelo**: `type_model_name` es un `Literal` con 29 modelos (`routes/schemas/conversation.py:8`), duplicado en el front (`src/@types/conversation.d.ts`). `get_model_id` elige el inference profile global, regional o el modelo base según los flags `ENABLE_BEDROCK_GLOBAL_INFERENCE` y `ENABLE_BEDROCK_CROSS_REGION_INFERENCE` (`bedrock.py:50-58`, `:1369-1431`).
2. **Configuración**: `generation_params_to_converse_configuration` normaliza los parámetros por familia (Claude, Nova, Llama, Mistral, DeepSeek, gpt-oss), el reasoning (`additionalModelRequestFields`) y los guardrails (`bedrock.py:692-1181`). `get_bedrock_model_config` lo traduce a `BedrockModel.BedrockConfig` de Strands, con `cache_prompt` y `cache_tools` si el modelo lo soporta (`strands_integration/agent/config.py:21-100`).
3. **Agente**: `create_strands_agent` une las instrucciones en un único `system_prompt` porque Strands no admite una lista (`factory.py:49-57`). Las tools se construyen como **closures `@tool` que capturan el bot** (`strands_integration/tools/knowledge_search.py:32-99`, `internet_search.py:187-262`, `bedrock_agent.py`). El registro está hardcodeado (`strands_integration/utils.py:17-30`). La KB se añade como tool si el bot tiene conocimiento (`utils.py:66-73`).
4. **Streaming**: `CallbackHandler` enruta `data`, `reasoning` y `message` hacia los callbacks (`handlers/callback_handler.py:13-42`). `ToolResultCapture` (HookProvider) emite `on_thinking` y `on_tool_result` y **reescribe el resultado de la tool** para inyectar `source_id`, lo que permite las citas (`handlers/tool_result_capture.py:39-72`).
5. **Uso y coste**: se toman los tokens de `metrics.accumulated_usage` (input, output, cacheRead, cacheWrite) (`chat_strands.py:150-163`). El precio sale de `calculate_price` con la tabla estática `BEDROCK_PRICING` (`bedrock.py:1326-1366`, `config.py:64`). Se acumula en `conversation.total_price` y se envía al cliente en `STREAMING_END`. El análisis por bot o usuario se hace con **Athena sobre la exportación incremental de DDB** (`repositories/usage_analysis.py:107-362`, `s3_exporter/index.py`). **No hay límites ni cortes**: el coste solo se registra, no se controla.
6. **Bedrock Agents**: una tool invoca `InvokeAgent` con `enableTrace` y convierte las trazas en "documentos" citables (`strands_integration/tools/bedrock_agent.py:38-120`).
7. **Knowledge Bases**: `Retrieve` con `overrideSearchType` (se omite para Kendra) y filtro `listContains tenants` en la KB compartida (`vector_search.py:57-122`). La ingesta la orquesta una Step Function y, en modo dedicated, un **stack CFN por bot desplegado con CodeBuild**.

---

## 5. Permisos (bots privados, compartidos y públicos) y grupos Cognito

| Capacidad | Implementación |
|---|---|
| Roles globales | Grupos Cognito `Admin`, `CreatingBotAllowed` y `PublishAllowed` creados en CDK (`cdk/lib/constructs/auth.ts:188-206`) y evaluados en `user.py:28-35` y `dependencies.py:29-50`. Un trigger post-confirmation añade usuarios a grupos por defecto (`backend/auth/add_user_to_groups`). |
| ACL por bot | `shared_scope ∈ {private, partial, all}` + `allowed_cognito_users/groups`. `is_accessible_by_user` para leer y `is_editable_by_user` (solo el dueño o Admin) para modificar (`models/custom_bot.py:507-534`). |
| Pin o "promoción" en el store | `shared_status = pinned@NNN`, solo lo gestiona Admin (`routes/admin.py:140-148`) y se consulta por `SharedScopeIndex` (`repositories/custom_bot.py:727-746`). |
| Alias | Cuando un usuario usa un bot ajeno se crea `ALIAS#{bot}`. Si pierde el acceso, el alias se marca `IsOriginAccessible=false` (`usecases/bot.py:349-375`). |
| Row-level security | Cada acceso a ConversationTable **asume un rol con una session policy** `dynamodb:LeadingKeys = {user_id}*` (`repositories/common.py:82-141`). BotTable **no** tiene RLS (`common.py:167-173`). |
| Published API | Un bot con scope `all` se puede publicar como API con API keys y usage plan (throttle/quota) mediante un stack CDK por bot (`usecases/publication.py`, `cdk/lib/api-publishment-stack.ts`). Dentro, el "usuario" es `PUBLISHED_API#{bot}` **con grupo Admin** (`user.py:47-56`; el propio código admite que habría que refinarlo). |

---

## 6. Patrones y buenas prácticas reutilizables

1. **Capas limpias** `routes` (DTO camelCase) → `usecases` → `repositories` → `models`, con excepciones de dominio (`RecordNotFoundError`, `RecordAccessNotAllowedError`, `ResourceConflictError`) mapeadas centralmente a HTTP (`main.py:82-100`).
2. **Pydantic como guardián de invariantes** (`model_validator`), uniones discriminadas para contenidos y tools, y carga perezosa de secretos desde Secrets Manager en el validador (`custom_bot.py:122-161`). Las API keys nunca se guardan en claro en DDB.
3. **Árbol de mensajes** con `thinking_log`: edición, ramas, regeneración, continue y auditoría de tool calls por mensaje en una sola estructura.
4. **Row-level security en DynamoDB con STS session policies + `LeadingKeys`**: defensa en profundidad real para datos por usuario. Se puede reutilizar tal cual, cambiando el prefijo a `tenant#user`.
5. **Índices sparse** (`SharedScope`, `IsStarred`) para listados baratos sin scans (`custom_bot.py:83-92`).
6. **Offload a S3 de items grandes** (>300 KB) para esquivar el límite de 400 KB de DDB (`conversation.py:59-84`).
7. **Protocolo de eventos de streaming** estable y agnóstico del framework: `STREAMING`, `REASONING`, `AGENT_THINKING`, `AGENT_TOOL_RESULT`, `AGENT_RELATED_DOCUMENT`, `STREAMING_END{token_count, price}` y `ERROR` (`websocket.py:105-189`). Encaja muy bien con la máquina XState del front.
8. **Integración con Strands mediante hooks** (Before/AfterToolInvocation) para telemetría, UI y enriquecimiento del resultado (citas). Es el mismo punto de extensión que Mango necesita para **aprobaciones HITL, policy checks y auditoría**.
9. **Citas con `source_id`** que enlazan el texto del modelo con los documentos RAG o los resultados de tools, más un visor de documentos (`RelatedDocumentViewer.tsx`).
10. **Matriz de capacidades por modelo** (`bedrock.py:558-670`) y adaptación de parámetros por familia. La idea es buena; la implementación hardcodeada no.
11. **Prompt caching** de system y tools condicionado por modelo (`agent/config.py:76-93`).
12. **Frontend**: interceptor de token, SWR, store zustand+immer, máquina XState para el streaming, markdown con mermaid/katex/gfm, i18n con español incluido, soporte de IdP OIDC corporativo y stories de Ladle como catálogo de componentes.
13. **Hooks de pre-commit** (black, mypy, prettier, eslint) con `lefthook.yml` y CI que valida el tipado y el arranque de uvicorn.

---

## 7. Deuda técnica y limitaciones

| # | Problema | Evidencia | Impacto para Mango |
|---|---|---|---|
| 1 | **Sin MCP**, registro de tools estático (3 tools) y sin tools custom por bot (las "plain tools" son solo metadatos). | `strands_integration/utils.py:17-30` | Bloqueante: Mango necesita agentes FinOps, DevOps, SAP y Drive vía MCP. |
| 2 | **Strands antiguo** (1.9.0 frente a 1.57.1) y uso de `strands.experimental.hooks`. Sin session manager, sin multi-agente (graph/swarm/A2A) y sin interrupts. | `poetry.lock:3028`, `tool_result_capture.py:15` | La actualización rompe APIs; mejor reescribir la capa de adaptación. |
| 3 | **Runtime del agente en Lambda WebSocket** (15 min, 512 MB) con un hilo de notificaciones. No hay aislamiento de sesión ni ejecuciones largas o asíncronas con aprobación humana. | `websocket.ts:107-136`, `websocket.py:280-284` | Los flujos con HITL (esperar horas una aprobación) no caben. |
| 4 | **Un WebSocket por mensaje** y un protocolo de trozos persistidos en DDB para esquivar el límite de 32 KB de API GW. | `usePostMessageStreaming.ts:9,41`, `websocket.py:286-388` | Latencia extra y complejidad. |
| 5 | **Dependencia de OpenSearch Serverless** (store, búsqueda de conversaciones, KB dedicada por bot con una colección OSS por bot). | `repositories/bot_store.py`, `conversation_search.py`, `bedrock-custom-bot-stack.ts:90` | Coste prohibitivo: 2 OCU × 0,24 USD/h ≈ **350 USD/mes por colección** con redundancia, o ~175 USD en dev-test ([pricing](https://aws.amazon.com/opensearch-service/pricing/)). AWS anuncia colecciones *NextGen* que escalan a cero, pero la hybrid search de las KB depende de OSS. |
| 6 | **Un stack CFN por bot vía CodeBuild** para la KB y la Published API. | `usecases/publication.py`, `bedrock-custom-bot-stack.ts` | Lento (minutos), frágil y con límites de stacks; no escala para un marketplace. |
| 7 | **Precios hardcodeados** y sin enforcement de budgets. | `config.py:60-64`, `bedrock.py:1326` | Falta el pilar de gobernanza: no hay cuotas ni cortes antes de invocar. |
| 8 | **RBAC mínimo**: 3 grupos fijos, sin tenant, organización ni equipos, sin permisos por agente, tool o acción. `is_accessible_by_user` llama a `AdminListGroupsForUser` en **cada** check aunque los grupos ya vienen en el token. | `user.py:28-35`, `utils.py:185-200`, `custom_bot.py:522-524` | Latencia, throttling de Cognito y modelo insuficiente. |
| 9 | **La Published API opera como Admin.** | `user.py:47-56` | Escalada de privilegios si se reutiliza. |
| 10 | **Fugas en logs**: se registran las cabeceras completas (incluido `Authorization`) y el evento WebSocket entero (con el `token` en el body). | `main.py:134-139`, `websocket.py:257` | Riesgo de compliance. |
| 11 | **Bypass de autenticación fuera de Lambda**: sin cabecera se crea un `test_user`. | `main.py:117-126` | Riesgo si se ejecuta en contenedores (ECS/AgentCore) sin `AWS_LAMBDA_*`. |
| 12 | **Conversación = un único item** con todo el `MessageMap` en JSON, reescrito en cada turno. | `conversation.py:39-90` | Coste de WCU creciente, contención y límites en sesiones de agente largas. |
| 13 | **Catálogo de modelos como `Literal`** duplicado en backend y frontend. | `schemas/conversation.py:8`, `bedrock.py:59-525` | Cada modelo nuevo exige un release. |
| 14 | Coexisten el código legacy (`agents/tools/*`, `converse_legacy`, `stream.py`) y el de Strands. | `chat.py:383-510`, `agents/utils.py` | Duplicación. |
| 15 | **Tests**: pytest **no corre en CI** (solo mypy, black y arranque de uvicorn); algunos tests dependen de AWS real; `mypy.ini` usa `ignore_missing_imports` y excluye los tests; el frontend tiene 1 solo test. | `.github/workflows/backend.yml`, `backend/mypy.ini` | Poca red de seguridad para un refactor. |
| 16 | Sin memoria de largo plazo, sin HITL, sin audit trail de acciones (solo el `thinking_log` por mensaje) y sin observabilidad OTel explícita. | — | Son pilares de Mango que habría que construir desde cero. |
| 17 | La búsqueda en internet usa DuckDuckGo (scraping no oficial). | `strands_integration/tools/internet_search.py` | No apto para entornos enterprise. |

¿Agente hecho a mano o framework? **Híbrido en transición.** El bucle ReAct propio (Converse + `tool_use` → ejecutar → reinyectar) existe en `chat.py:425-510`, pero el camino por defecto es **Strands**. Lo "hecho a mano" que queda es la orquestación alrededor del agente: árbol de mensajes, persistencia, conversión de formatos (`strands_integration/converters/*`, ~680 líneas) y cálculo de coste.

---

## 8. Estado actual del ecosistema (verificado el 2026-09-28)

- **Strands Agents** 1.57.1 (25-sep-2026) con cliente MCP nativo, extra `a2a` y multi-agente ([PyPI](https://pypi.org/project/strands-agents/)). Se despliega de forma nativa en AgentCore Runtime ([docs Strands](https://strandsagents.com/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/)).
- **Amazon Bedrock AgentCore** ([pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)):
  - En GA: Runtime (0,0895 USD/vCPU-h y 0,00945 USD/GB-h, CPU gratis durante la espera de I/O), Gateway (0,005 USD/1k invocaciones; búsqueda 0,025 USD/1k), Identity (gratis a través de Runtime o Gateway), Memory (0,25 USD/1k eventos de corto plazo; 0,75 USD/1k registros de largo plazo; 0,50 USD/1k recuperaciones), Policy (0,000025 USD por autorización), Browser y Code Interpreter.
  - En preview: Observability, Evaluations y Agent Registry.
  - Runtime ya soporta MCP con estado ([What's New 2026-03](https://aws.amazon.com/about-aws/whats-new/2026/03/amazon-bedrock-agentcore-runtime-stateful-mcp)). Policy y Evaluations se anunciaron en [2025-12](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-bedrock-agentcore-policy-evaluations-preview).
- **S3 Vectors** en GA desde el 2-dic-2025 y disponible como vector store de Bedrock KB ([What's New](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-vectors-generally-available/), [docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html)).
  - Precios en us-east-1: 0,06 USD/GB-mes; PUT 0,20 USD/GB; 2,5 USD por millón de queries más el volumen procesado ([S3 pricing](https://aws.amazon.com/s3/pricing/)).
  - Limitaciones: **no hay hybrid search** (solo semántica) y los metadatos filtrables tienen un tope de 2 KB por vector ([blog vector stores](https://aws.amazon.com/blogs/machine-learning/selecting-a-vector-store-for-amazon-bedrock-knowledge-bases/), [re:Post](https://repost.aws/questions/QUf3kvqg40QjKl-O_bGN-7mQ/s3-vectors-in-bedrock-knowledge-base)).
- **OpenSearch Serverless**: 0,24 USD/OCU-h. Las colecciones clásicas tienen un mínimo de 1–2 OCU; las *NextGen* anuncian escalado a cero tras 10 minutos de inactividad ([pricing](https://aws.amazon.com/opensearch-service/pricing/)).
- **bedrock-chat** v3: el README sigue exigiendo OSS e Ingestion para bots y KB, y no menciona MCP ni AgentCore ([repo](https://github.com/aws-samples/bedrock-chat)).

---

## 9. Qué reutilizar y qué reescribir

| Pieza | Decisión | Detalle |
|---|---|---|
| Estructura de capas y excepciones del backend | **Reutilizar** (patrón) | Replicar `routes/usecases/repositories/models` y el mapeo central de errores. |
| Modelos pydantic de conversación (contenidos discriminados, `thinking_log`, árbol) | **Reutilizar con cambios** | Mantener el árbol, pero guardar **un item por mensaje** (`PK=TENANT#t#USER#u#CONV#c`, `SK=MSG#ulid`) en lugar del `MessageMap` monolítico. |
| RLS con STS + `LeadingKeys` | **Reutilizar** | Extender con el prefijo de tenant. Cachear las credenciales asumidas por invocación. |
| Índices sparse y alias de bot | **Reutilizar** | El alias equivale a la "instalación" del agente del marketplace por parte del usuario. |
| Protocolo de eventos de streaming + XState + componentes de chat | **Reutilizar** | Añadir eventos `APPROVAL_REQUIRED`, `APPROVAL_RESOLVED`, `BUDGET_WARNING` y `POLICY_DENIED`. |
| Adaptador Strands (factory, config, hooks, callback) | **Reescribir sobre Strands actual** | Mismo diseño con la API estable de hooks y *interrupts*, `MCPClient`, session manager y OTel. |
| Registro de tools | **Reescribir** | Pasar a un catálogo en DDB de "Agent Definitions" y "Tool Bindings" apuntando a **targets MCP de AgentCore Gateway**, con credenciales OAuth salientes vía **AgentCore Identity** (Google Drive, SAP). |
| Runtime de agente (Lambda WebSocket de 15 min) | **Reescribir** | Llevarlo a **AgentCore Runtime**: sesiones aisladas en microVM, ejecuciones largas y streaming. El front-door (API GW WebSocket o HTTP streaming) queda como proxy fino. |
| Memoria | **Nuevo** | AgentCore Memory (corto plazo = sesión; largo plazo = preferencias y hechos por usuario o tenant). |
| RAG / KB | **Reescribir** | Una **KB compartida por tenant o dominio sobre S3 Vectors** con filtro de metadatos (reutilizando el patrón `tenants` de `vector_search.py:86-94`), creada **por API y no con CFN por bot**. Reutilizar `vector_search.py` casi entero (extracción de fuentes y page_number). |
| Bot store y búsqueda de conversaciones (OSS + OSIS) | **Eliminar** | Marketplace interno con GSIs de DDB (`CATEGORY`, `VISIBILITY#ORG`) y filtrado por permisos. Para la búsqueda semántica de agentes, embeddings de las descripciones en S3 Vectors o, en preview, AWS Agent Registry. La búsqueda de conversaciones puede ser por título con un GSI, o eliminarse. |
| RBAC | **Reescribir** | Modelo `Tenant → Org/Team → Role → Permission` con decisiones en **Amazon Verified Permissions (Cedar)** en la API y **AgentCore Policy** en las tool calls. Los grupos Cognito (o los grupos del IdP corporativo vía OIDC) solo aportan atributos. Nunca llamar a `AdminListGroupsForUser` por request. |
| Coste y budgets | **Reescribir** | Precios en config o tabla (fuente: AWS Price List API). **Pre-check** del budget (DDB, contador atómico por usuario, equipo o agente y periodo) antes de cada invocación, y **post-commit** con los tokens reales. Añadir alertas y corte, y conciliar con CUR/Cost Explorer usando tags de aplicación/inference profiles. |
| HITL | **Nuevo** | Hook `BeforeToolInvocation` que consulta la política; si la acción requiere aprobación, crea el item `APPROVAL#…`, interrumpe el agente (interrupts de Strands o la sesión de Runtime) y reanuda al aprobar (EventBridge o Step Functions con `waitForTaskToken`). |
| Audit trail | **Nuevo** | Evento inmutable por tool call, decisión de política y aprobación: DDB Streams → Firehose → S3 (Object Lock) + Athena. Reutilizar el patrón `s3_exporter` para la analítica. |
| Published API | **Reescribir o posponer** | Una sola API multi-agente con API keys y usage plans, o exponer AgentCore Runtime directamente con autorización JWT. Nada de stacks por bot. |
| Catálogo de modelos | **Reescribir** | Catálogo dinámico (tabla y config global) con la matriz de capacidades como datos. Reutilizar la **lógica** de `bedrock.py:558-1181` como punto de partida. |
| Frontend | **Reutilizar ~60%** | Mantener auth (Amplify/OIDC), `useHttp`, la máquina de streaming, `ChatMessage*`, `InputChatContent`, `RelatedDocumentViewer`, los componentes base, i18n y Ladle. Rehacer el editor de bots (→ "Agent Builder" con MCP y skills), el discover/store (→ marketplace gobernado), las páginas de admin (→ budgets, aprobaciones, auditoría) y el transporte WebSocket (conexión persistente, sin trozos). |
| Calidad | **Endurecer** | pytest en CI con moto o DynamoDB Local, mypy `strict` por módulos, ruff, Vitest y Playwright para el flujo de chat, y quitar el logging de cabeceras y tokens. |

---

## 10. Recomendación para Mango

### Decisiones

1. **No hacer fork de bedrock-chat.** Usarlo como **fuente de patrones y de componentes copiables**: modelos de conversación, RLS en DDB, protocolo de streaming, UI de chat, conversores y matriz de modelos. Su esqueleto de despliegue (stacks por bot, OSS, CodeBuild) está en contra de nuestros requisitos de coste y gobernanza.
2. **Framework de agente: Strands Agents (≥1.57) sobre Amazon Bedrock AgentCore Runtime.** Cada agente del marketplace es una *Agent Definition* declarativa en DynamoDB (prompt, modelo, tools MCP, skills, KB, límites, política de aprobación) que un único runtime Strands instancia por sesión. No habrá un despliegue por agente salvo en casos especiales.
3. **Tools = MCP detrás de AgentCore Gateway**, con credenciales salientes en AgentCore Identity. Los agentes FinOps (Cost Explorer), DevOps (CloudWatch), SAP y Google Drive se modelan como targets MCP. Así el acceso a tools pasa por un solo punto donde también se aplica la política.
4. **Gobernanza en dos puntos de control**:
   - (a) la API de Mango, con Verified Permissions/Cedar para "quién puede usar, crear o publicar qué agente";
   - (b) los hooks de Strands junto con AgentCore Policy, para "qué tool o acción se permite, con qué budget y si requiere aprobación".
   - Cada decisión deja un evento de auditoría.
5. **Budgets aplicados antes de invocar** (reserva estimada → consumo real), con precios como datos y conciliación con Cost Explorer. El `total_price` de bedrock-chat es solo informativo.
6. **RAG sin OpenSearch**: Bedrock KB sobre **S3 Vectors**, compartida y con filtro de metadatos por tenant o agente. Si algún caso exige hybrid search o keyword, evaluar después Aurora Serverless v2 con pgvector o OSS NextGen, pero no al inicio.
7. **Marketplace interno** en DynamoDB, con visibilidad `private | team | org` evaluada por RBAC y la "instalación" modelada como el alias de bedrock-chat. Sin OSIS ni OSS.
8. **Memoria**: AgentCore Memory en lugar de reinyectar todo el árbol en cada turno. La conversación se guarda como items por mensaje.
9. **Frontend**: partir del frontend de bedrock-chat (React/Vite/Tailwind/Amplify/XState/i18n `es`), extraer los componentes de chat y streaming y reescribir la navegación y las páginas de gobierno.

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Churn de APIs de Strands (en 12 meses pasó de 1.9 a 1.57) y de AgentCore (varios componentes siguen en preview: Observability, Evaluations y Registry). | Encapsular Strands tras un puerto propio (`AgentRunner`), fijar versiones y hacer tests de contrato. No depender de funciones en preview para el MVP. |
| **S3 Vectors sin hybrid search** y con límite de metadatos filtrables (2 KB por vector, 35 claves). | Diseñar pocos metadatos (tenant, agente, clasificación), usar reranking y dejar la puerta abierta a pgvector. |
| El coste de AgentCore Runtime se factura por sesión (la memoria se cobra hasta el timeout de inactividad) más Gateway, Memory y Policy por request. | Ajustar el idle timeout, medir con un piloto y considerar Lambda para agentes simples sin estado. |
| El HITL con esperas largas complica el ciclo de vida de la sesión del agente. | Persistir el estado (session manager y Memory) y reanudar en una sesión nueva, sin mantener microVMs vivas esperando. |
| Copiar código de bedrock-chat arrastra su deuda: logs con tokens, bypass de auth en local, Published API como Admin, llamadas a Cognito en cada request. | Checklist de seguridad para cada módulo importado (ver la tabla del §7, filas 8–11). |
| Licencia y soporte: es un *sample* de AWS (MIT-0) sin SLA, y v3 ya rompió la compatibilidad con v2. | Tratarlo como código propio a partir del copy; no hacer merges upstream. |
| Precisión del coste: la tabla estática se queda obsoleta y hay descuentos por inference profiles o caching. | Precios como datos más conciliación diaria con CUR y Cost Explorer; el budget "duro" usa una estimación conservadora. |

### Fuentes
- [PyPI strands-agents](https://pypi.org/project/strands-agents/) · [Strands → AgentCore](https://strandsagents.com/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/)
- [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) · [AgentCore overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html) · [AgentCore Policy/Evaluations (2025-12)](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-bedrock-agentcore-policy-evaluations-preview) · [AgentCore Runtime stateful MCP (2026-03)](https://aws.amazon.com/about-aws/whats-new/2026/03/amazon-bedrock-agentcore-runtime-stateful-mcp)
- [S3 Vectors GA](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-vectors-generally-available/) · [S3 Vectors + Bedrock KB](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html) · [S3 pricing](https://aws.amazon.com/s3/pricing/) · [Selecting a vector store for Bedrock KB](https://aws.amazon.com/blogs/machine-learning/selecting-a-vector-store-for-amazon-bedrock-knowledge-bases/) · [re:Post S3 Vectors en KB](https://repost.aws/questions/QUf3kvqg40QjKl-O_bGN-7mQ/s3-vectors-in-bedrock-knowledge-base)
- [OpenSearch Serverless pricing](https://aws.amazon.com/opensearch-service/pricing/)
- [aws-samples/bedrock-chat](https://github.com/aws-samples/bedrock-chat)
