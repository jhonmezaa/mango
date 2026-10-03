# Mango Hub: evaluación del runtime de agentes

> Fecha de corte: **2026-09-28**. Todo lo que aparece como "estado actual" se verificó en la web en esta fecha (URLs en §9). Las cifras de costo que no son precios publicados se marcan como **[supuesto]**.
> Repo de referencia: `aws-samples/bedrock-chat` @ `4419d62`. Rutas relativas a `bedrock-chat/`.

---

## 0. TL;DR

1. **AgentCore cubre el *plano de ejecución* de Mango casi entero (~80%)**: runtime aislado por sesión (microVM), harness gestionado (agente = configuración), Gateway MCP (convierte APIs, Lambdas, OpenAPI y servidores MCP en tools), Identity (OAuth 3LO/OBO), Memory, Policy (Cedar + Guardrails), Evaluations, Observability, Registry (catálogo de agentes, tools, skills y MCP) y **Agent Skills nativas** en el harness.
2. **No cubre el *plano de control* del producto Mango**, que igual habría que construir: el marketplace (UX y ciclo de publicación), el RBAC de usuarios y tenants de negocio, los **presupuestos en dólares** por usuario/equipo/agente (AgentCore solo trae límites de TPM/RPS y topes por invocación), la bandeja de aprobaciones HITL, el audit trail de negocio, el historial de conversaciones para la UI y el **router** que decide qué agente atiende.
3. **Bedrock Agents "Classic" queda descartado.** Desde el 30-jul-2026 está en *maintenance mode*, cerrado a cuentas nuevas y con el catálogo de modelos congelado.
4. **Recomendación:** usar **AgentCore harness** por defecto (agentes de marketplace definidos por configuración) y **AgentCore Runtime con Strands** solo para agentes complejos. Todas las tools pasan por **un único AgentCore Gateway** con Policy. El router y el BFF de streaming van en **ECS Fargate**. EKS no se adopta por ahora; Lambda se usa solo para tools y tareas asíncronas.
5. El **costo de cómputo del runtime es marginal** frente al de tokens (≈3–8% en nuestro escenario de referencia, §4.1). La palanca de costo real son los modelos, así que los budgets deben medir tokens y dólares, no vCPU.

---

## 1. Cómo ejecuta agentes hoy bedrock-chat (qué se reutiliza y qué no)

### 1.1 Flujo actual

```
Browser ──WS──► API GW WebSocket ──► Lambda "HandlerV2" (Python 3.13, 512 MB, 15 min)
                                      └─ usecases.chat.chat()
                                           └─ converse_with_strands()   (in-process)
                                                └─ strands.Agent(BedrockModel, tools=[...])
                                                     └─ tools: internet_search, bedrock_agent (Classic), KB search
```

- **Entrada WebSocket.** Una sola Lambda atiende `$connect` y `$default` (`cdk/lib/constructs/websocket.ts:107-155`), con `timeout: Duration.minutes(15)` y `memorySize: 512` (`websocket.ts:115-116`). Como API GW WebSocket tiene un límite de **32 KB por mensaje**, el cliente trocea el input y lo reensambla en DynamoDB (`backend/app/websocket.py:286-296`).
- **Streaming de tokens.** Un hilo `NotificationSender` hace `post_to_connection` por cada token (`websocket.py:42-114`, arranca en `websocket.py:280`).
- **Selección de motor.** Se elige Strands o el legado con el flag `USE_STRANDS` (`backend/app/usecases/chat.py:332-351`).
- **Construcción del agente.** Se crea un `strands.Agent` nuevo por request, en el mismo proceso (`backend/app/strands_integration/agent/factory.py:44-57`), con guardrails y prompt caching mapeados a `BedrockModel` (`strands_integration/agent/config.py:60-93`).
- **Tools.** Salen de un **registro fijo en código** (`strands_integration/utils.py:17-30`): internet search y `bedrock_agent`, que invoca Bedrock Agents Classic con `invoke_agent` (`strands_integration/tools/bedrock_agent.py:49`). Además está la KB search (`utils.py:67-73`). **No hay MCP, ni skills, ni tools por usuario.**
- **Costo.** Se calcula por respuesta a partir de las métricas de Strands (`chat_strands.py:151-163` → `app/bedrock.py:1326`) y se acumula en `conversation.total_price` (`usecases/chat.py:530`).
- **Ruta asíncrona.** La API publicada usa SQS → Lambda (`backend/app/sqs_consumer.py:8-27`).

### 1.2 Limitaciones frente a lo que necesita Mango

| Limitación | Evidencia | Impacto en Mango |
|---|---|---|
| Sin aislamiento por sesión: todos los bots corren con **el mismo rol IAM** (`handlerRole`) | `websocket.ts:101-104` | Un agente FinOps y uno de SAP comparten permisos, lo que no es aceptable para la gobernanza |
| Tope de 15 min por turno y límite de 32 KB por mensaje | `websocket.ts:116`, `websocket.py:286` | Los agentes largos (DevOps, investigaciones) no caben |
| Tools en duro y sin MCP | `utils.py:17-30` | No sirve para un marketplace de agentes con tools corporativas |
| Multiagente vía Bedrock Agents Classic | `tools/bedrock_agent.py:49` | Camino muerto: Classic está en maintenance mode (§3.6) |
| Sin sandbox de código ni filesystem | — | Las skills con `scripts/` no se pueden ejecutar de forma segura |

### 1.3 Qué sí reutilizar

- Los **converters** de mensajes Strands ↔ modelo propio (`strands_integration/converters/*`) y el patrón `CallbackHandler` + `ToolResultCapture` para separar el stream de la persistencia (`chat_strands.py:56-113`, `handlers/callback_handler.py:13-42`). Sirven para mapear eventos de `InvokeHarness`/Strands a nuestro protocolo de UI.
- `calculate_price()` y la tabla de precios por modelo (`app/bedrock.py:1326`): base para el **metering de budgets**.
- El mapeo de Guardrails y prompt caching (`agent/config.py:60-93`), cuando el agente sea code-defined con Strands.
- El patrón de ingesta asíncrona SQS (`sqs_consumer.py`) para "agentes como API" y jobs batch.
- **No reutilizar:** el despacho en proceso dentro de la Lambda WebSocket, ni el tool `bedrock_agent`.

---

## 2. Estado actual de Amazon Bedrock AgentCore (sep-2026)

AgentCore está en GA desde oct-2025. Desde entonces ha cambiado mucho, así que no conviene fiarse de guías de 2025.

| Componente | Estado | Qué aporta a Mango | Notas y límites clave |
|---|---|---|---|
| **Runtime** (microVM) | GA; **Runtime v2 GA el 18-sep-2026** | Cada sesión corre en su propia microVM con aislamiento a nivel de hardware; soporta cualquier framework (Strands, LangGraph, Claude Agent SDK, OpenAI Agents, ADK) y protocolos HTTP, MCP, A2A y AG-UI | v2: *cold start* P75 de ~2 s con imágenes de 200 MB a 2 GB (v1: 5,4–30 s). v2 solo está en us-east-1, us-east-2, us-west-2, eu-west-1 y ap-northeast-1. Máximo **2 vCPU/8 GB por sesión**, imagen ≤2 GB, sesión de **8 h máx.** (configurable con `maxLifetime`), *idle* de 15 min (configurable), request síncrono de 15 min, streaming ≤60 min, jobs asíncronos ≤8 h, payload de 100 MB |
| **Runtime "Instances"** | GA (ago-2026) | EC2 gestionado en tu cuenta, **sesiones de hasta 14 días** y hasta 20 agentes por sesión de capacity provider | Precio: EC2 + 12% de fee (7,8% en GPU). Para agentes "residentes" o que necesiten hardware grande |
| **Harness** (agente declarativo) | Preview abr-2026 → **GA jul-2026** | Un agente se define como modelo + prompt + tools + skills + memoria, **sin código ni contenedor**. Permite overrides por invocación, cambio de modelo a mitad de sesión, *lifecycle hooks* (Lambda allow/deny), shells interactivos, S3 Files/EFS, integración nativa con **Step Functions** y exportación a código Strands | Sin cargo propio (se paga Runtime y lo demás). Tools: `remote_mcp`, `agentcore_gateway`, Browser, Code Interpreter, `inline_function` (return-of-control / HITL), más `shell` y `file_operations` por defecto (~900 tokens extra por request; restringir con `allowedTools`) |
| **Skills** (AgentSkills.io / `SKILL.md`) | GA en el harness | Fuentes: **S3**, Git (HTTPS, repos privados con PAT en Identity), path local o "AWS Skills". *Progressive disclosure* (~100 tokens de metadata). Se cargan una vez por sesión | Git fetch ≤60 s, skill ≤1 GB. Evaluations trae evaluadores específicos: `SkillSelectionAccuracy` y `SkillInstructionFollowing` (ago-2026) |
| **Gateway** | GA | Endpoint MCP único delante de targets de tipo Lambda, OpenAPI, Smithy, API Gateway, **servidores MCP** (incluido 3LO por usuario, GA abr-2026), **Runtime** (agent-as-tool, GA jul-2026), HTTP passthrough (A2A, MCP externos), inferencia (proxy de modelos con TPM), **Managed KB** y Web Search | MCP stateful: sesiones, SSE, *elicitation*, *sampling* y progreso (may-2026). **Rate limits configurables por JWT `sub`, tool, target o modelo, incluidos TPM** (ago-2026). Egress a VPC (abr-2026). Cuotas: 100 targets/gateway, 1000 tools/target, 200 TPS de tool-call, **search-based tool-call de 25 TPM** (bajo) |
| **Identity** | GA | Workload identity, inbound con JWT (Cognito/Entra/Okta), outbound OAuth2 M2M, **OBO token exchange** (abr-2026), 3LO con **Consent Portal** (sep-2026), Private Key JWT con KMS y referencias a Secrets Manager | 50 credential providers OAuth2 por defecto (ajustable) |
| **Memory** | GA | Corto plazo (eventos) y largo plazo (estrategias semantic, preferences, summary, episodic), namespaces flexibles, filtros por metadata, `IngestData`, payloads JSON y *record streaming* | 150 recursos por región, 6 estrategias por recurso, 150k TPM de extracción |
| **Code Interpreter** | GA | Sandbox para Python/JS/TS; Chrome policies y CA propia | 2 vCPU/8 GB, 10 GB de disco, 1000 sesiones concurrentes |
| **Browser** | GA | Chromium gestionado, perfiles, proxies, extensiones e interacción a nivel de SO | 1 vCPU/4 GB |
| **Policy** | **GA mar-2026** | Políticas **Cedar** sobre las llamadas de agente → tool en Gateway, autoría en lenguaje natural e **integración con Bedrock Guardrails** (jul-2026) | Schema Cedar ≤400 KB por engine, ≤1000 policies por engine. El construct CDK de Policy sigue en *alpha* |
| **Evaluations** | **GA mar-2026** | 13+ evaluadores built-in, evaluadores custom y de terceros (DeepEval), online y batch; soporta Strands, LangGraph, **Claude Agent SDK**, OpenAI Agents, ADK, LlamaIndex y Vercel AI SDK | 1 evaluador por evaluación on-demand |
| **Optimization** (Recommendations, A/B, Batch eval) | GA jul-2026 | Mejora continua de prompts y descripciones de tools | Máximo 1 A/B test por gateway |
| **Observability** | GA | OTel/ADOT → CloudWatch GenAI Observability; monitoreo cross-account; spans unificados por agente | Se paga al precio de CloudWatch |
| **AWS Agent Registry** | **GA ago-2026** | Catálogo privado de **agentes, tools, skills y servidores MCP**, con flujo de aprobación (`SubmitRegistryRecordForApproval`), endpoint MCP, auto-descubrimiento en la Organization, RAM y KMS | **Encaja como backend del marketplace**, pero no es la UI |
| Web Search | GA | Tool de búsqueda sin egress | $7 por 1000 consultas |
| Payments | Preview | Agentes que pagan x402/MPP | No aplica a Mango |
| Managed Knowledge Base | GA jul-2026 | RAG gestionado con conectores **S3, SharePoint, Confluence, Google Drive, OneDrive** y web, filtrado por permisos del documento y consulta vía Gateway (MCP) | Sin OpenSearch Serverless que administrar. Detalle de costos en el informe de RAG |

**Cumplimiento:** SOC 1/2/3 (jul-2026), ISO y CSA STAR (feb-2026), además de GovCloud.

### 2.1 MCP, A2A y skills: cómo quedan

- **MCP como cliente:** el harness se conecta a MCP remotos por URL o a través del Gateway. En Strands y Claude Agent SDK, MCP es nativo.
- **MCP como servidor:** puedes **alojar servidores MCP en Runtime** (stateful desde mar-2026) y exponerlos detrás del Gateway. El Gateway **convierte Lambdas y OpenAPI en tools MCP** sin escribir un servidor.
- **A2A:** Runtime soporta A2A (JSON-RPC, Agent Cards) desde finales de 2025, y el Gateway acepta A2A por passthrough. La guía oficial de migración de Classic advierte que el multiagente tipo *routing* "no es directo" con el harness: solo soporta *agent-as-tool*, y la colaboración completa requiere código propio.
- **Skills** (estándar AgentSkills.io, el mismo formato que las skills de Anthropic):
  - **Harness:** el parámetro `skills` acepta S3, Git, path local o AWS Skills (ver arriba). Los `scripts/` se ejecutan con el tool `shell` **dentro de la microVM de la sesión**, que es el aislamiento que necesitamos.
  - **Strands:** el plugin `AgentSkills`/`SkillsPlugin` carga skills desde un path, una URL HTTPS o instancias `Skill`.
  - **Claude Agent SDK:** las skills son nativas (`.claude/skills/`). Para ejecutar sus scripts hay que desplegarlo en Runtime, porque necesita filesystem y shell.
  - **Recomendación para Mango:** guardar las skills en **S3 con versionado**, catalogarlas en **Agent Registry** y referenciarlas por agente en la definición del harness.

---

## 3. Alternativas

### 3.1 AgentCore Runtime + harness (gestionado)
- **A favor:** aislamiento por sesión sin ingeniería propia; *scale-to-zero*; la CPU en espera de I/O no se cobra; v2 reclama memoria ociosa tras 120 s. Trae de serie Identity, Policy, Memory, Evaluations y Registry, y el harness da el mejor *time-to-market* para agentes que son "configuración" (que es exactamente lo que genera un marketplace).
- **En contra:** lock-in en la API del harness (mitigable, ver §6); cuotas por cuenta (25 TPS de nuevas sesiones, 5000 sesiones activas en us-east-1/us-west-2 y 2500 en el resto); sesión máxima de 2 vCPU/8 GB; v2 solo en 5 regiones; producto joven (harness GA en jul-2026).

### 3.2 AgentCore Runtime con agentes code-defined (Strands, LangGraph o Claude Agent SDK)
El runtime y los beneficios son los mismos, pero el loop es tuyo. Es la opción para orquestaciones complejas (supervisor/routing multiagente, prompts por etapa) o para agentes estilo Claude Code (Claude Agent SDK + skills + filesystem). AWS lo documenta como camino soportado, con samples de Claude Agent SDK en AgentCore.

### 3.3 ECS Fargate (Strands o FastAPI propio)
- **A favor:** barato en baseline ($0,04048/vCPU-h y $0,004445/GB-h en us-east-1), sin límite de 15 min, sin cuotas de sesión de AgentCore, SSE/WebSocket vía ALB y máxima portabilidad.
- **En contra:** **no hay aislamiento por sesión**; múltiples tenants comparten proceso y rol IAM, como en bedrock-chat. Sandbox de código, memoria, identidad OBO/3LO, policy y evaluaciones corren por tu cuenta, y hay que pagar el cómputo siempre encendido y el autoscaling.
- **Rol en Mango:** ideal para el **BFF, el router y el plano de control**, no para ejecutar las tools o el código de los agentes.

### 3.4 EKS (Karpenter + kagent + agent-sandbox)
- **A favor:** kagent (CNCF Sandbox) modela agentes y MCPServers como CRDs con GitOps; `kubernetes-sigs/agent-sandbox` aporta una CRD `Sandbox` (gVisor/Kata). Portabilidad multicloud y costo marginal bajo a gran escala.
- **En contra:** control plane a $0,10/h (~$73/mes) más nodos, más **1–2 FTE de plataforma**. Aislamiento fuerte con gVisor/Kata, identidad por usuario, políticas de tools y evaluaciones se construyen e integran a mano. kagent está centrado en casos de operación de Kubernetes.
- **Veredicto:** solo tiene sentido si Mango ya opera EKS o si hay un requisito duro de multicloud u on-prem. **No es la opción inicial.**

### 3.5 AWS Lambda (+ Lambda durable functions)
- **Lambda:** 15 min por invocación, sin sesión ni filesystem persistente. Sirve para **tools** (targets del Gateway) y para el router si es síncrono y corto.
- **Durable functions** (GA dic-2025): workflows de hasta 1 año con *checkpoint/replay*; las esperas no se cobran. Cuestan $8 por millón de operaciones durables, $0,25/GB escrito y $0,15/GB-mes de retención. Encajan bien para **flujos HITL largos** (aprobación de un gasto o de una acción en SAP que tarda días), pero no para ejecutar el loop conversacional con streaming. Alternativa equivalente y más visual: Step Functions con la integración nativa del harness (jul-2026).

### 3.6 Bedrock Agents Classic
**Descartado.** Desde el **30-jul-2026** está en maintenance mode: las cuentas sin uso en los últimos 12 meses reciben `AccessDeniedException` en `CreateAgent`, el catálogo de modelos está congelado y no habrá features nuevas. AWS recomienda migrar al harness de AgentCore.

---

## 4. Matriz de decisión

Escala 1–5 (5 = mejor para Mango). Pesos según los pilares de Mango: gobernanza y multi-tenant pesan más.

| Criterio (peso) | AgentCore harness + Runtime | AgentCore Runtime code-defined | ECS Fargate propio | EKS + kagent/sandbox | Lambda (+durable) | Bedrock Agents Classic |
|---|---|---|---|---|---|---|
| Costo infra a nuestra escala (10%) | 4 | 4 | 4 | 2 | 5 | 4 |
| Ops / carga operativa (15%) | **5** | 4 | 3 | 1 | 4 | 4 |
| Time-to-market (15%) | **5** | 4 | 2 | 1 | 3 | 1 (no disponible para cuentas nuevas) |
| Lock-in (bajo = 5) (10%) | 2 | **4** (Strands/LangGraph/Claude SDK portables) | 5 | 5 | 3 | 1 |
| Gobernanza (Policy, audit, HITL, budgets) (20%) | **5** | 4 | 2 | 2 | 3 | 2 |
| MCP / skills / A2A (15%) | **5** | 5 | 3 | 4 | 2 | 1 |
| Aislamiento multi-tenant (15%) | **5** (microVM/sesión) | 5 | 2 | 4 (con Kata/gVisor) | 3 (por invocación, sin estado) | 3 |
| **Total ponderado** | **4,60** | **4,30** | 2,80 | 2,60 | 3,20 | 2,25 |

Cómo se calcularon las puntuaciones:
- La puntuación de lock-in del harness es baja a propósito: su API es propietaria, aunque MCP, skills, A2A y OTel son estándares y el harness permite **exportar a código Strands**.
- Costo: Lambda saca 5 solo como cómputo puro. Para ejecutar agentes aislados habría que añadir sandboxes.

### 4.1 Costo ilustrativo (escenario de referencia) [supuesto]

**Supuestos:** 300 usuarios activos, **20.000 conversaciones al mes**, 6 turnos por conversación, 45 s de CPU activa por conversación (1 vCPU), 0,5 GB de memoria real media durante ~8 min vivos, 3 tool calls por turno, 12 eventos de memoria por conversación y 6 recuperaciones de memoria de largo plazo por conversación.

| Partida | Cálculo | USD/mes |
|---|---|---|
| Runtime v2, CPU | 20k × 45 s × $0,1276/3600 | ~$32 |
| Runtime v2, memoria | 20k × 0,5 GB × (8/60) h × $0,0169 | ~$23 |
| Gateway | 360k invocaciones × $0,005/1000 | ~$2 |
| Memory, corto plazo | 240k eventos × $0,25/1000 | ~$60 |
| Memory, largo plazo | ~50k registros × $0,75/1000 + 120k recuperaciones × $0,50/1000 | ~$98 |
| Policy | ~360k autorizaciones × $0,000025 | ~$9 |
| **AgentCore total** | | **~$225** |
| BFF + router en Fargate (2 tareas 1 vCPU/2 GB 24×7) | 2 × ($0,04048 + 2 × $0,004445) × 730 h | ~$72 + ALB |
| **Tokens LLM** (orden de magnitud) | 120k turnos × ~20k tokens de entrada con caching + salida; con un modelo de gama Sonnet a ~$3/M de entrada y ~$15/M de salida **[supuesto de precio]** | **$3.000–8.000** |

**Conclusión:** el runtime gestionado cuesta **~3–8% del gasto en tokens**. Ahorrar en cómputo migrando a EKS no compensa la carga operativa; **los budgets y el routing de modelos (Haiku para routing y tareas simples) son la palanca real.**

Dos matices:
- **Memory es la partida más cara de AgentCore.** Hay que activar la memoria de largo plazo solo en los agentes que la necesitan.
- **Cuidado con v1:** si una sesión queda ociosa, la memoria se cobra por el pico hasta que vence el *idle timeout* (15 min por defecto). Hay que usar v2 o bajar `idleRuntimeSessionTimeout`.

---

## 5. Arquitectura recomendada del plano de ejecución de agentes

```
                         ┌───────────────────────── PLANO DE CONTROL MANGO (nuestro) ─────────────────────────┐
 Usuario (web)           │  Cognito/IdP corporativo (OIDC, grupos→roles)                                       │
   │  SSE / AG-UI        │  Catálogo/Marketplace API ──► AWS Agent Registry (agentes, skills, MCP, aprobación) │
   ▼                     │  RBAC (Amazon Verified Permissions o tabla roles) · Budgets (DynamoDB contadores $)  │
 CloudFront+WAF          │  Audit (EventBridge → Firehose → S3 Object Lock) · Aprobaciones HITL (Step Fn/durable)│
   ▼                     └──────────────────────────────────────────────────────────────────────────────────────┘
 ALB ─► BFF + ROUTER (ECS Fargate)
         1. authN (JWT) + RBAC: ¿qué agentes puede usar este usuario?
         2. pre-check budget (usuario/equipo/agente) → deny/soft-limit
         3. Routing:
            a) el usuario eligió agente en el marketplace → directo
            b) modo "Asistente Mango": clasificador Haiku (structured output) sobre
               las Agent Cards permitidas (Registry) → agente destino (+confianza; si baja, pregunta)
         4. InvokeHarness / InvokeAgentRuntime (sessionId = conversación, actorId = usuario,
            header con tenant/rol) → re-stream al browser (AG-UI/SSE), persiste historial y usage
         │
         ▼
 ┌──────────────────── AMAZON BEDROCK AGENTCORE (cuenta "agents" por entorno) ──────────────────────┐
 │  Runtime v2 (microVM por sesión)                                                                 │
 │   ├─ Harness "finops"   : modelo, prompt, skills S3 [finops/*], tools → Gateway, memory on      │
 │   ├─ Harness "devops"   : skills [ops/*], Code Interpreter, tools → Gateway                     │
 │   ├─ Harness "sap"      : tools → Gateway (SAP), inline_function "solicitar_aprobacion"         │
 │   ├─ Harness "drive/docs": tools → Gateway (Managed KB + Drive MCP 3LO)                          │
 │   └─ Strands code-defined "supervisor" (solo casos multi-dominio; llama agentes como tools)       │
 │  Lifecycle hooks: before_invocation (budget) · before_tool_call (policy/HITL) → Lambda          │
 │                                                                                                  │
 │  Gateway MCP (único, con Policy Cedar + Guardrails + rate limits por jwt.sub/tool/TPM)          │
 │   ├─ target Lambda/OpenAPI: Cost Explorer (ce:GetCostAndUsage…, rol read-only por tenant)        │
 │   ├─ target MCP: CloudWatch/CloudTrail MCP (awslabs) alojado en Runtime                          │
 │   ├─ target OpenAPI/MCP vía VPC egress: SAP (BTP API Mgmt / OData, o MCP server de SAP)          │
 │   │     outbound OAuth2 OBO/3LO vía Identity (acciones con la identidad del usuario)             │
 │   ├─ target Managed Knowledge Base (Drive/SharePoint/S3 → RAG, filtros por permiso)              │
 │   ├─ target MCP Google Drive con 3LO (acciones: leer/crear docs como el usuario)                 │
 │   └─ target Runtime (agent-as-tool) para delegación entre agentes                                │
 │  Identity (JWT inbound = Cognito; token vault) · Memory (actor=usuario, namespace=tenant/agente) │
 │  Observability (ADOT→CloudWatch) · Evaluations online + batch · Registry                        │
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Decisiones de diseño

1. **Agente de marketplace = registro en Registry + un harness.** Publicar un agente significa crear o actualizar el harness (modelo, prompt, tools como referencias al Gateway, skills en S3 y política de memoria). El flujo de aprobación de Registry sirve como *gate* de publicación. Los agentes que no caben en el harness (supervisores, prompts por etapa, estilo Claude Code) se despliegan como Runtime code-defined, con Strands por defecto o Claude Agent SDK cuando haga falta filesystem y skills tipo Claude Code. **Ambos se invocan con el mismo contrato desde el BFF.**
2. **El router vive fuera de AgentCore, en el BFF de Fargate.**
   - Así la decisión es **auditable, barata** (Haiku con structured output y ~1–2k tokens) y **aplica RBAC antes** de gastar en el agente.
   - El orden es: primero la elección explícita del usuario (UX de marketplace) y después la clasificación automática, siempre filtrando a los agentes permitidos para el usuario y con umbral de confianza.
   - No se usa el Gateway con *semantic tool search* para esto: su cuota por defecto es de 25 tool-calls por minuto (ajustable).
   - La multi-delegación queda para un supervisor Strands que invoca a los otros agentes como tools (Runtime targets en Gateway, GA), o por A2A si llegan agentes externos.
3. **Todas las tools pasan por el Gateway**, sin MCP remotos "sueltos" en el harness salvo en desarrollo. Eso da un solo punto donde aplicar **Policy (Cedar)**, Guardrails, rate limits por usuario y modelo, credenciales y logs de auditoría. El RBAC de negocio de Mango se traduce a claims JWT (`groups`, `tenant`) y esos claims se usan en las políticas Cedar, por ejemplo: "solo `finops-approver` puede llamar `sap.create_purchase_order`".
4. **Conectores corporativos:**
   - **Cost Explorer:** usar una Lambda target (o el MCP de Cost Explorer de awslabs alojado en Runtime) con **rol read-only por cuenta o tenant** mediante AssumeRole con ExternalId. Cost Explorer cobra por request, así que conviene cachear.
   - **CloudWatch (DevOps):** servidor MCP de awslabs en Runtime, con acceso cross-account read-only. Las acciones mutantes van con HITL.
   - **SAP:**
     - **Opción recomendada:** exponer las APIs de SAP (BTP API Management / OData) como **target OpenAPI** o, si el cliente ya tiene el MCP de SAP, como **target MCP**, en ambos casos con **VPC egress** hacia la red privada o Direct Connect.
     - **Autenticación:** outbound con OAuth2 **OBO/3LO** vía Identity, para que SAP autorice con la identidad real del usuario.
     - **Escritura:** toda escritura pasa por `inline_function` o un hook `before_tool_call` que dispara la aprobación.
   - **Google Drive:**
     - **Lectura (RAG):** Managed Knowledge Base con conector de Drive y filtros por ACL. Evita por completo OpenSearch Serverless.
     - **Acciones:** MCP de Drive con **3LO por usuario**, usando el Consent Portal de Identity.
5. **HITL en dos niveles:**
   - **Aprobación síncrona en la conversación:** `inline_function` (el harness pausa y devuelve `tool_use` al BFF) y la UI muestra la tarjeta de aprobación.
   - **Aprobación asíncrona o larga:** un hook `before_tool_call` → Lambda devuelve `deny`, se registra la solicitud y se orquesta con **Step Functions** (`waitForTaskToken`, integración nativa del harness) o Lambda durable. Al aprobarse, se reanuda la sesión (hay *filesystem persistence* y sesiones de hasta 8 h, o 14 días con Instances).
6. **Budgets en dólares (no existen en AgentCore, los construimos nosotros):**
   - **Pre-check** en el BFF y en el hook `before_invocation`, contra contadores en DynamoDB por usuario, equipo y agente.
   - **Post-metering** a partir del usage de tokens del stream, reutilizando la lógica de `calculate_price` de bedrock-chat.
   - **Topes técnicos:** límites por invocación del harness (iteraciones, tokens, timeout) y **rate limits TPM del Gateway** en los targets de inferencia.
   - **Atribución exacta en CUR:** *application inference profiles* de Bedrock etiquetados por agente o tenant.
7. **Streaming al frontend:** BFF en Fargate con **SSE o protocolo AG-UI** (Runtime soporta AG-UI de forma nativa desde mar-2026). No se usa API GW WebSocket + Lambda, así evitamos el límite de 32 KB y los 15 min que sufre bedrock-chat. La conexión directa browser → Runtime por WebSocket con OAuth es posible, pero **se salta el plano de control** (budgets, auditoría y redacción). Solo tiene sentido para casos especiales, combinada con "enforce inbound from gateway".
8. **Multi-tenant:**
   - **Aislamiento de ejecución:** microVM por sesión.
   - **Datos:** `actorId` y namespace de Memory por tenant y usuario; Managed KB con filtros por documento.
   - **Permisos:** un rol de ejecución por agente, nunca un rol único como en `websocket.ts:101`.
   - **Tenants regulados:** si hace falta aislamiento duro, usar cuentas AWS separadas por tenant con Registry compartido por RAM y observabilidad cross-account.
9. **IaC:** constructs CDK `aws-bedrockagentcore` (estables desde CDK v2.255; Policy sigue en alpha) o la AgentCore CLI (que genera CDK). La definición de cada agente se versiona como JSON en Git y un pipeline la publica.

---

## 6. ¿Cubre AgentCore toda la necesidad? Brechas explícitas

| Necesidad Mango | ¿AgentCore la cubre? | Cómo cerrar la brecha |
|---|---|---|
| Ejecutar agentes aislados, escalables, con MCP, skills, memoria y sandbox | **Sí** | — |
| Catálogo y publicación de agentes | Parcial: Registry es el backend | UI del marketplace, reseñas, categorías y permisos de visibilidad en Mango |
| RBAC usuario → agente | Parcial: Policy decide agente → tool | RBAC en el BFF (Verified Permissions o tabla propia) + claims JWT → Cedar |
| Budgets de costo de IA en $ | **No** (solo TPM/RPS y topes por invocación) | Servicio de budgets propio (§5.1.6) |
| Aprobaciones HITL | Primitivas sí (inline functions, hooks) | Bandeja de aprobaciones, notificaciones y SLA en Mango (Step Functions) |
| Audit trail | Parcial: CloudTrail + trazas OTel | Evento de negocio inmutable por cada tool call y aprobación (EventBridge → S3 con Object Lock) |
| Historial de conversaciones en la UI | Parcial (Memory de corto plazo) | DynamoDB propio (patrón de bedrock-chat) |
| Router o orquestador | Parcial (supervisor en código; agent-as-tool) | Router en el BFF (§5.1.2) |
| RAG sin OpenSearch Serverless | **Sí**, con Managed KB (S3 Vectors por debajo) | Validar costo y latencia en la evaluación de RAG |

---

## 7. Recomendación para Mango

### Decisiones

1. **Runtime de agentes = Amazon Bedrock AgentCore**, en **Runtime v2**, en la región **us-east-1 o eu-west-1** según la residencia de datos. v2 está en ambas, pero todavía no en sa-east-1 ni ca-central-1.
2. **Harness por defecto** para todo agente de marketplace (agente = configuración). **Strands code-defined** en Runtime para supervisores y agentes complejos. **Claude Agent SDK** en Runtime solo para agentes de tipo "trabajador de archivos o código" que se beneficien de skills y filesystem estilo Claude Code.
3. **Un AgentCore Gateway por entorno** como única superficie de tools, con **Policy (Cedar) + Guardrails + rate limits por `jwt.sub`**. Conectores: Cost Explorer (Lambda/MCP read-only), CloudWatch (MCP de awslabs), SAP (OpenAPI/MCP + VPC egress + OAuth OBO) y Drive (Managed KB para RAG + MCP 3LO para acciones).
4. **Skills en S3 versionado**, catalogadas en **Agent Registry** y referenciadas por el harness, con los evaluadores de skills de Evaluations activados.
5. **Router, BFF de streaming (SSE/AG-UI) y plano de control en ECS Fargate.** El router es un clasificador Haiku con RBAC-first y elección explícita del usuario por delante.
6. **HITL:** `inline_function` para aprobaciones en la conversación; hooks + Step Functions o Lambda durable para aprobaciones largas.
7. **Budgets propios** (pre-check + metering con `calculate_price` + inference profiles etiquetados) y topes técnicos del harness y del Gateway.
8. **Descartados:** Bedrock Agents Classic (maintenance mode) y EKS/kagent por ahora (se revisa si surge un requisito multicloud u on-prem o si el gasto en runtime pasa de ~$5k/mes). Lambda queda para tools, jobs y flujos durables, no para el loop del agente.
9. **De bedrock-chat se reutilizan** los converters, el patrón callback/`ToolResultCapture`, `calculate_price`, el mapeo de guardrails y caching y el camino SQS. **Se descartan** el dispatch en la Lambda WebSocket, el registro de tools en duro y el tool `bedrock_agent`.

### Riesgos y mitigaciones

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| **Lock-in** con la API del harness y de AgentCore | Alta | Medio | Contrato interno `AgentInvoker` en el BFF. Tools como MCP estándar y skills en formato AgentSkills.io. Exportación del harness a Strands (portable a Fargate/EKS). Trazas OTel |
| **Madurez**: harness GA desde jul-2026 y Runtime v2 desde sep-2026; features que cambian mes a mes | Media | Medio | Fijar versiones de CLI y SDK, tests de contrato y un entorno canary. Plan B: Strands code-defined en Runtime v1 |
| **Cuotas**: 25 TPS de nuevas sesiones, 2500–5000 sesiones activas, 200 TPS de tool-call en Gateway, 25 TPM de search | Media | Alto en picos | Pedir aumentos antes del lanzamiento, reutilizar `sessionId` por conversación, cachear tools y hacer load test |
| **Límite de hardware** de 2 vCPU/8 GB por sesión | Baja | Medio | Delegar lo pesado a Code Interpreter, Batch o Glue, o usar Runtime Instances |
| **Costo de Memory** mayor que el de cómputo; *idle billing* en v1 | Media | Bajo–Medio | Memoria de largo plazo solo donde aporte, v2 y `idleRuntimeSessionTimeout` bajo |
| **Costo de tokens** descontrolado (loops de agente) | Alta | **Alto** | Budgets propios, límites de iteración y tokens del harness, TPM en Gateway, Haiku para routing y resúmenes, prompt caching |
| **Seguridad de skills y MCP de terceros** (prompt injection, exfiltración) | Media | Alto | Solo skills y MCP aprobados en Registry; `allowedTools` restrictivo (quitar `shell` si el agente no ejecuta scripts); Guardrails en Policy; egress controlado por VPC |
| **Regiones**: v2 y algunas tools (Web Search) no están en todas | Media | Medio | Elegir región al inicio y validar la lista de regiones de AgentCore |
| **Conectividad con SAP** (on-prem, auth corporativa) | Media | Alto | PoC temprana de VPC egress + OBO con el IdP del cliente; fallback con un servidor MCP propio en Runtime |
| El construct CDK de Policy sigue en alpha | Baja | Bajo | Fijar la versión o usar CloudFormation/SDK para Policy |

### Próximos pasos (2–3 semanas de PoC)
1. Montar un harness FinOps con Gateway → Cost Explorer (Lambda) + skill en S3, streaming AG-UI a través del BFF en Fargate.
2. Integrar el Gateway con SAP (sandbox) vía VPC egress + OBO, con Policy Cedar por grupo y aprobación HITL por `inline_function`.
3. Cargar un Managed KB con Drive y medir latencia, costo y respeto de ACLs.
4. Construir el router Haiku sobre 4 agentes y medir precisión con un set de 200 consultas etiquetadas.
5. Hacer un load test de 50 sesiones concurrentes; con eso se calibran las cuotas y el costo real por conversación.

---

## 8. Supuestos y cosas no verificadas
- Los precios de modelos en §4.1 son un **supuesto** de orden de magnitud; hay que confirmarlos en la página de precios de Bedrock para el modelo elegido.
- Las tarifas de Fargate salen de fuentes secundarias de 2026 que coinciden con la tarifa histórica; la página oficial no las mostró en el fetch.
- La cifra de ~$60/mes del Managed KB viene de una fuente secundaria (dev.to/Builder Center).
- El precio del committed baseline de Runtime v2 figura en la página de precios como disponible **a partir de octubre de 2026**.

## 9. Fuentes (consultadas el 2026-09-28)
- Precios de AgentCore (Runtime v1/v2, Gateway, Memory, Policy, Evaluations, Registry): https://aws.amazon.com/bedrock/agentcore/pricing/
- Cuotas de AgentCore: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html
- Release notes de AgentCore (jul-2025 → sep-2026): https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html
- Nuevo Runtime (v2) GA, 18-sep-2026: https://aws.amazon.com/about-aws/whats-new/2026/09/new-agentcore-runtime-generally-available/
- Blog del nuevo Runtime (cold start, memoria elástica): https://aws.amazon.com/blogs/machine-learning/the-new-agentcore-runtime-elastic-optimized-and-consistently-fast-starts/
- Harness, CLI y skills (abr-2026): https://aws.amazon.com/about-aws/whats-new/2026/04/agentcore-new-features-to-build-agents-faster/
- Skills del harness: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-skills.html
- Tools del harness (MCP, Gateway, inline functions): https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html
- Optimización (A/B, recomendaciones): https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-new-optimization-capabilities/
- Regiones nuevas (ago-2026): https://aws.amazon.com/about-aws/whats-new/2026/08/bedrock-agentcore-two-new-regions/
- A2A en Runtime: https://aws.amazon.com/blogs/machine-learning/introducing-agent-to-agent-protocol-support-in-amazon-bedrock-agentcore-runtime/
- Claude Agent SDK en AgentCore: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/supported-frameworks-claude-agent-sdk.html · https://github.com/aws-samples/sample-deploy-ClaudeAgentSDK-based-agents-to-AgentCore-Runtime
- Skills en Strands: https://strandsagents.com/docs/user-guide/concepts/plugins/skills/ · https://github.com/aws-samples/sample-strands-agents-agentskills
- Especificación de Agent Skills: https://agentskills.io/specification
- Maintenance mode de Bedrock Agents Classic: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html
- Managed KB como target de Gateway: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-managed-kb.html · https://dev.to/aws-builders/amazon-bedrock-managed-knowledge-base-what-developers-actually-need-to-know-3lnb
- Lambda durable functions: https://aws.amazon.com/lambda/lambda-durable-functions/ · https://aws.amazon.com/blogs/compute/building-fault-tolerant-multi-agent-ai-workflows-with-aws-lambda-durable-functions/ · precios: https://aws.amazon.com/lambda/pricing/
- Precios de Fargate: https://aws.amazon.com/fargate/pricing/ · https://www.vantage.sh/blog/fargate-pricing
- Precios de EKS: https://aws.amazon.com/eks/pricing/
- kagent: https://kagent.dev/ · https://www.cncf.io/projects/kagent/ · agent-sandbox: https://www.cncf.io/blog/2026/07/07/why-sandboxing-your-agent-is-not-enough/
- Facturación de Runtime por CPU activa (espera de I/O gratis): https://aws.amazon.com/blogs/machine-learning/securely-launch-and-scale-your-agents-and-tools-on-amazon-bedrock-agentcore-runtime/
