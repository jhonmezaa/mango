# Propuesta de hoja de ruta: agentes proactivos y conexiones gobernadas

**Estado:** propuesta del 2026-10-03, sin aprobar. Nada de esto está decidido ni construido. Las decisiones de la sección 6 se registran en §8 de `docs/architecture/reference-architecture.md` solo cuando el usuario las tome.

**Origen:** análisis de AWS FinOps Agent (preview) y AWS DevOps Agent (GA) frente a Mango, con fuentes por afirmación en `~/.config/mango/lab/reports/aws-agents/` (`aws-finops-agent.md`, `aws-devops-agent.md`).

## 1. Por qué

- **Público:** Mango sirve a equipos técnicos (plataforma, DevOps, FinOps) y a equipos no técnicos. Un equipo FinOps técnico va a comparar el agente FinOps de Mango con el de AWS, que hoy es gratis.
- **Dónde Mango ya es mejor:** alcance por usuario y por área, least privilege fijado por release (37 acciones exactas frente a 132 sobre `*`), presupuesto preventivo, aprobaciones con token ligado a `hash(tool, args)`, alta de cuentas por StackSet, datos y conversaciones en la cuenta del cliente, tools ampliables con packs firmados.
- **Dónde AWS va por delante:** sus agentes trabajan solos (por horario y por evento), explican la causa de un cambio de costo con CloudTrail, entregan reportes, aprenden contexto del cliente y se dejan usar desde otras herramientas.

Esta hoja de ruta cierra esas brechas sin ceder en lo que diferencia a Mango.

## 2. Lo que no cambia

1. Identidad del usuario hasta el destino (regla 5). Ninguna ola introduce un rol compartido que lea por todos.
2. Toda tool pasa por el Gateway; autorizar y reservar presupuesto antes de invocar (reglas 3 y 4).
3. Sin CodeBuild ni `cdk deploy` en la cuenta del cliente (D25).
4. Packs firmados de la release; no se admiten servidores MCP arbitrarios del cliente.
5. Las tools de escritura requieren aprobación (D27, D56). No se adoptan las aprobaciones preautorizadas de AWS.
6. Claude Design es la fuente de verdad del UI (D24): cada pantalla nueva empieza por un brief.
7. Cada componente nuevo pasa por `security-threat-model` antes de construirse.

## 3. Olas

Tamaños: S (días), M (una a dos semanas), L (más de dos semanas). Son estimaciones de orden de magnitud, no compromisos.

### Ola 0 · Cerrar la prueba «one-click» (ya en curso)

Requisito de todo lo demás: sin instalación y desinstalación limpias no hay base para crecer.

| # | Qué | Tamaño |
|---|---|---|
| 0.1 | Parte 2: reinstalar como cliente desde las plantillas de la release y correr la batería completa | M |
| 0.2 | El agente de la release (FinOps) se va con el stack: harness, endpoint y rol como recursos de CloudFormation, o borrado en el `Delete` del custom resource | S |
| 0.3 | Un stack por pack habilitado, desde plantilla de la release (D25). Los tipos `AWS::BedrockAgentCore::Runtime`, `RuntimeEndpoint` y `GatewayTarget` existen; falta probarlos con Runtime en VPC y zip firmado | M |
| 0.4 | Paso «preparar desinstalación» y runbook completo (Object Lock, log groups de AgentCore, llaves KMS, tablas `RETAIN`) | S |

### Ola 1 · FinOps proactivo

Cierra la brecha más visible frente a AWS FinOps Agent.

| # | Qué | Qué hay hoy | Qué falta | Tamaño |
|---|---|---|---|---|
| 1.1 | **Tareas:** ejecuciones de un agente sin chat, a pedido, por horario o por evento, con cola, estados e historial | Solo conversación; Step Functions y EventBridge ya están en la instalación | Modelo `Task` y `Automation`, planificador (EventBridge Scheduler), ejecución con presupuesto reservado, pantalla de tareas | L |
| 1.2 | **Investigación de anomalías por evento** | `ce:GetAnomalies` y `ce:GetCostComparisonDrivers` ya están en `Mango-<ns>-BillingReader` (D52); solo se usan a pedido | Regla de EventBridge en la pagadora para eventos de Cost Anomaly Detection, que cree una tarea (1.1) | M |
| 1.3 | **Causa del cambio con CloudTrail** («quién cambió qué y cuándo») | Sin acceso a CloudTrail | Pack de lectura con `cloudtrail:LookupEvents` (Event History, sin crear trails), en cadena `payer` y `member` | M |
| 1.4 | **Tarifa frente a uso** al explicar un cambio | Las acciones ya existen en el rol | Skill del agente FinOps y preguntas nuevas en la evaluación | S |
| 1.5 | **Reportes entregables** (HTML y PDF con gráficos) como artefactos descargables, ligados a su tarea | Respuesta en el chat | Almacén de artefactos en S3 con RLS, generación sin HTML crudo del modelo, descarga firmada | M |

Dependencias: 1.2 y 1.5 necesitan 1.1. 1.3 necesita la decisión A2.

### Ola 2 · Conexiones y tools gobernadas

Barata y refuerza lo que ya diferencia a Mango.

| # | Qué | Qué hay hoy | Qué falta | Tamaño |
|---|---|---|---|---|
| 2.1 | **Asociación con lista de tools por agente:** separar «el pack está instalado» de «este agente usa estas tools» | Un pack se habilita entero; `UseAgent` por datos (D33) | La asociación como entidad de Cedar; selector de tools en el Agent Builder | M |
| 2.2 | **Clasificación de tools en el manifiesto firmado:** `read`, `mutating`, `destructive`. Lo no clasificado se trata como escritura; `destructive` no se habilita nunca | Lectura por defecto, escritura declarada por tool | Campo en el manifiesto, validación en `mango-packs` y en el provisioner | S |
| 2.3 | **Estrechar al aprobar:** el aprobador reduce el alcance (nunca lo amplía) y ve impacto y pasos de reversa; se recalcula el hash | Token de un solo uso ligado a `hash(tool, args)` (D56) | Edición acotada de argumentos en la aprobación, nueva firma | M |
| 2.4 | **Salud de cada cuenta conectada:** `valid`, `invalid`, `pending`, probando el `AssumeRole` real de forma periódica, con alerta al topic | Prueba de conectividad a pedido (Conectividad › Cuentas miembro) | Comprobación programada en el reconciliador (D41), estado persistido | S |
| 2.5 | **Tres caminos para cada rol** en la instalación: lo crea Mango, usar uno existente, plantilla para el equipo de seguridad del cliente | Plantillas `Payer` y `OrgAccess` | Parámetros «rol existente» y validación del trust | S |

### Ola 3 · Conocimiento del cliente

| # | Qué | Qué hay hoy | Qué falta | Tamaño |
|---|---|---|---|---|
| 3.1 | **Instrucciones del cliente por agente**, siempre presentes, con límite de tamaño y versión revisada | System prompt del agente con revisión | Campo propio, separado del prompt de la release, que sobrevive a las actualizaciones | S |
| 3.2 | **Contexto derivado, no subido:** mapa cuenta → área → responsable, tomado de áreas, grupos y Organizations | Áreas y grupos de acceso (D35, D44) | Tool de contexto que respeta el alcance del usuario | M |
| 3.3 | **Memoria** de preferencias y correcciones, por usuario o por área, visible y borrable | Nada | AgentCore Memory con espacio por usuario; nunca compartida sin revisión | L |

### Ola 4 · Apertura a equipos técnicos

Es la que más cambia el alcance del producto; va al final.

| # | Qué | Tamaño |
|---|---|---|
| 4.1 | **Servidor MCP de Mango:** usar un agente publicado desde un IDE u otro agente, con la identidad, el presupuesto y la auditoría del usuario. Tokens de alcance limitado, con vencimiento, apagados por defecto | L |
| 4.2 | **Eventos de ciclo de vida a EventBridge** (agente publicado, aprobación pendiente, tarea terminada, presupuesto agotado), sin contenido de conversaciones | S |
| 4.3 | **Línea de tiempo de la investigación con guía en vivo:** extensión de D57; el usuario redirige al agente entre pasos | M |
| 4.4 | **Nivel de modelo por conversación** (rápido, balanceado, capaz), del catálogo de modelos, con su costo contra el presupuesto | S |
| 4.5 | **Agente «Operaciones»** de consulta sobre el pack de CloudWatch y, si se decide A2, CloudTrail | M |
| 4.6 | **Prueba técnica: AWS DevOps Agent como tool** detrás del Gateway, para clientes que ya lo tienen. Solo se construye si la llamada por SigV4 conserva el `SourceIdentity` del usuario | S (la prueba) |

## 4. Orden recomendado

1. Ola 0 completa.
2. Ola 1 en este orden: 1.4, 1.1, 1.2, 1.5, 1.3. La 1.4 da valor en días y no depende de nada.
3. Ola 2, empezando por 2.2 y 2.4.
4. Ola 3, empezando por 3.1 y 3.2. La memoria (3.3) después de ver cómo se usan las tareas.
5. Ola 4, empezando por 4.2 y 4.4. El servidor MCP (4.1) al final.

## 5. Lo que no se adopta de AWS

| Qué hace AWS | Por qué no |
|---|---|
| Un rol compartido lee por todos los usuarios | Rompe la regla 5 y el alcance por área |
| Aprobaciones preautorizadas en automatizaciones; Slack sin aprobación | Toda escritura fuera de Mango pasa por aprobación (D27) |
| Servidores MCP arbitrarios del cliente | Solo packs firmados de la release (D36) |
| Uso de conversaciones para mejorar el servicio, con opt-out | Nada sale de la cuenta del cliente |
| Política de lectura con comodines que crece sola | Acciones exactas por release |
| Lo no clasificado se trata como lectura | En Mango se trata como escritura (2.2) |

## 6. Decisiones que hacen falta

Cada una con mi recomendación. Ninguna está tomada.

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| A1 | **Identidad de una tarea sin usuario presente** (1.1, 1.2) | (a) La de quien creó la automatización, con su alcance y su presupuesto, y se suspende si esa persona pierde acceso. (b) Una identidad de servicio por automatización, con alcance fijado al aprobarla | (a): conserva la regla 5 y la atribución en CloudTrail. Las automatizaciones pasan por revisión, como una versión de agente |
| A2 | **Leer CloudTrail Event History** (1.3). D55 excluye eventos de log | (a) Permitirlo solo a usuarios centrales. (b) También por cuenta miembro según alcance. (c) No leerlo | (a) primero: expone quién hizo qué, que es dato sensible; se amplía a (b) con un threat model propio |
| A3 | **Escrituras de una tarea automática** (crear presupuesto, publicar en un canal) | (a) Siempre quedan en espera de aprobación. (b) Preautorizadas por tool al aprobar la automatización | (a): coherente con D56 |
| A4 | **Entrega fuera de Mango** (Slack, Jira, correo) | (a) Solo dentro de Mango y por el topic de alertas. (b) Packs de salida con aprobación | (a) en la ola 1; (b) se evalúa después |
| A5 | **Alcance de la memoria** (3.3) | Por usuario, por área, o ambas | Por usuario primero |
| A6 | **Servidor MCP de Mango** (4.1): ¿entra en el producto? | Sí, apagado por defecto, o no | Sí, al final, con threat model |
| A7 | **Redacción del público** en `AGENTS.md` y en la arquitectura, que hoy dicen «usuarios no técnicos» | Corregir a «equipos técnicos y no técnicos» | Corregir |

## 7. Riesgos

- **Costo de las tareas automáticas:** cada investigación consume modelo y llamadas a Cost Explorer (USD 0,01 por solicitud). Las tareas reservan presupuesto como cualquier turno, y una automatización tiene tope propio.
- **Inyección por contenido no confiable:** los eventos de CloudTrail y los nombres de recursos los escribe cualquiera con acceso a la cuenta. Se tratan como salida de tool no confiable; una tarea automática nunca ejecuta escrituras sin aprobación (A3).
- **AWS acelera:** la política de FinOps Agent pasó de 73 a 132 acciones en cuatro meses y puede incluir escrituras en GA. Conviene revisar la comparación al salir de preview.
- **Tamaño de la ola 1:** el modelo de tareas (1.1) es el componente más grande; si se alarga, 1.4 y 1.3 se pueden entregar antes como mejoras del chat.

## 8. Lo que no se verificó

- No se probó ninguno de los dos agentes de AWS: el análisis es de documentación.
- Si AWS DevOps Agent conserva el `SourceIdentity` por SigV4 (4.6).
- Que un Runtime en VPC con zip firmado funcione igual creado por CloudFormation que por SDK (0.3).
- Los tamaños son estimaciones sin desglose de tareas.
