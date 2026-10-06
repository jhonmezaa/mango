# AGENTS.md — Mango Hub

Instrucciones para agentes de código (Claude Code, Codex, etc.) que trabajen en este repositorio.

## Qué es Mango

Plataforma empresarial de orquestación de agentes de IA, 100 % sobre AWS. Se **instala en la cuenta AWS de cada cliente** (single-tenant) y opera sobre todas las cuentas de su AWS Organization/Control Tower mediante roles. Ofrece a usuarios no técnicos un marketplace de agentes con chat, bajo gobernanza: RBAC, budgets, aprobaciones human-in-the-loop y audit trail.

**Fuente de verdad de la arquitectura:** [`docs/architecture/reference-architecture.md`](docs/architecture/reference-architecture.md). Su §8 es el registro de decisiones (D1…Dn).
- Antes de proponer algo que contradiga una decisión registrada, señálalo explícitamente y pide confirmación. No lo cambies en silencio.
- Cuando se tome una decisión nueva, regístrala en §8 con fecha.

## Stack

| Capa | Tecnología |
|---|---|
| Backend / plano de control | Python 3.13, FastAPI, Pydantic v2, `uv`. Servicio `mango-api` en ECS Fargate |
| Agentes | Amazon Bedrock AgentCore (harness por defecto; Strands Agents code-defined para casos avanzados). Tools vía MCP detrás de AgentCore Gateway |
| Frontend | React + TypeScript + Vite + Tailwind. Cliente de API **generado** desde el OpenAPI de FastAPI |
| IaC | AWS CDK v2 en TypeScript, distribuido como plantillas CloudFormation pre-sintetizadas |
| Datos | DynamoDB (on-demand), S3, Bedrock KB sobre S3 Vectors |

## Estructura del repositorio (D12)

Monorepo políglota por dominio. El árbol completo y sus reglas están en `docs/architecture/reference-architecture.md` §4.14.
- `apps/`: `api`, `web`.
- `packages/py/`: `mango-core`, `mango-governance`, `mango-aws`, `mango-packs` (formato de MCP packs y verificación de firma), `mango-pack-runtime` (punto de entrada común de los packs de datos de cuentas; viaja dentro de su zip).
- `packages/ts/`: `api-client`, **generado, no se edita a mano**.
- `packs/`: MCP packs de la release (manifiesto, lock con hashes y punto de entrada); ver `packs/README.md`.
- `functions/`, `connectors/`, `agents/`, `policies/`, `infra/`, `deployment/` (incluye `pack-builder`, el pipeline de packs), `tests/`.

Herramientas: `uv` (Python), `pnpm` (TypeScript) y `mise` (versiones y tareas: `mise run lint|test|synth|dist`).

Respeta las reglas de dependencias:
- `connectors/` no importa `apps/api`.
- Solo `functions/approval-executor` usa la capacidad de escritura de `mango-aws`.

## Reglas de arquitectura (no negociables sin decisión registrada)

1. **Nada de build ni `cdk deploy` en runtime (D25).** La aplicación nunca ejecuta `cdk deploy`, CodeBuild ni compila o descarga código. Por defecto, agentes, KBs, guardrails y targets del Gateway se crean **por API/SDK** (Step Functions o Lambda). Solo el provisioner puede crear stacks de CloudFormation, y **solo desde plantillas pre-sintetizadas de la release**, con un rol de ejecución acotado y permissions boundary, cuando un recurso compuesto lo justifique.
2. **Sin CodeBuild en la cuenta del cliente.** Instalar y actualizar = `CreateStack`/`UpdateStack` sobre plantillas versionadas (§4.9, §4.12).
3. **Toda tool pasa por AgentCore Gateway** (policy, identidad, guardrails, auditoría). Ningún agente llama sistemas externos directamente.
4. **Gobernanza preventiva:** autorizar (Cedar) y reservar budget **antes** de invocar un modelo o una tool. El reporte a posteriori es solo para reconciliar.
5. **Identidad del usuario hasta el destino.** Nunca usar el rol del runtime para acceder a datos en nombre de un usuario. Usar OBO/3LO (AgentCore Identity) o `AssumeRole` con `SourceIdentity` + session tags.
6. **`Namespace` en todo nombre global** (roles, StackSets, KMS alias, SSM, log groups): `Mango-<ns>-…`.
7. **Catálogo de modelos y precios como configuración**, nunca hard-coded ni como `Literal` duplicado entre backend y frontend.
8. **Personalizaciones del cliente solo por parámetros de stack o configuración de la app.** Nunca builds distintos por cliente.

## Seguridad

### Skills a usar (instaladas globalmente)

| Momento | Skill | Cómo |
|---|---|---|
| Antes de construir un componente nuevo (servicio, conector, flujo de auth, agente con tools de escritura) | `security-threat-model` | Modelar amenazas del componente y guardar el resultado en `docs/security/threat-models/<componente>-threat-model.md` |
| **Siempre** que escribas o modifiques código FastAPI o React | `security-best-practices` | Cargar y aplicar `python-fastapi-web-server-security.md` y/o `javascript-typescript-react-web-frontend-security.md` (y `javascript-general-web-frontend-security.md`) en modo generación. No hace falta que el usuario lo pida |
| Antes de un release, al cerrar un hito o ante cambios en IAM, trusts, Gateway o auth | `security-audit` | Revisión enfocada (guidance mode) del diff. Auditoría completa solo si el usuario la pide |

**Las tres skills son obligatorias:**
- Todo trabajo que toque código, IaC, IAM o diseño de componentes pasa por la skill que corresponda según la tabla, sin esperar a que el usuario lo pida.
- Al terminar ese trabajo se reporta qué skill se aplicó y con qué resultado.

**Excepciones: siempre se consultan antes.**
- Si una regla de estas skills no aplica o conviene no seguirla, **detente y pregunta al usuario**. Explica la regla, por qué no aplicaría y qué riesgo implica.
- Solo después de acordarla se registra en la tabla de excepciones de abajo, con la fecha.
- Nunca se aplica una excepción por cuenta propia, ni se ignora una regla en silencio.

### Reglas de código seguro (resumen obligatorio)

**Auth:**
- Validar **access tokens** de Cognito, nunca ID tokens.
- JWKS cacheado; validar `iss`, `aud`/`client_id`, `exp` y `token_use`.
- Nunca un usuario por defecto o de prueba fuera de tests.
- Login propio (D20): solo el flujo SRP de Cognito, nunca `USER_PASSWORD_AUTH`. El dominio del correo en el registro se valida en el servidor (Lambda *pre sign-up*), no solo en la UI. Sin revelar si un usuario existe.

**Authz:**
- Todo endpoint declara su dependencia de autorización.
- Autorización por objeto (L1 Verified Permissions). Deny por defecto.

**Datos:**
- DynamoDB con RLS vía session policy `dynamodb:LeadingKeys`.
- IDs públicos aleatorios (ULID/UUIDv4), nunca incrementales.
- `RETAIN` + `deletionProtection` + PITR en recursos con datos de producción.

**Secretos:**
- Solo en Secrets Manager o AgentCore Identity.
- Nunca en variables de entorno de plantillas, en logs, en el bundle del frontend ni en el contexto del LLM.

**Logging:**
- Prohibido loguear cabeceras `Authorization`, tokens, cuerpos de eventos crudos o prompts completos.
- El contenido de conversaciones va a audit/almacenamiento con retención propia, no a logs operativos.

**IAM:**
- Least privilege con ARNs concretos. Prohibido `bedrock:*`, `*:*` y `Resource: "*"` salvo donde la API no lo permita (documentarlo; p. ej. `ce:GetCostAndUsage`).
- Trusts cross-account: `AccountPrincipal` + `aws:PrincipalArn` (broker) + `aws:PrincipalOrgID` + `SourceIdentity` obligatorio.

**LLM/agentes:**
- Tratar como no confiables las salidas de tools, los documentos RAG y el contenido web (indirect prompt injection).
- Los filtros de RBAC en RAG los construye el backend desde el JWT verificado, **nunca el LLM**.
- Las tools de escritura requieren aprobación (approval token ligado a `hash(tool, args)`).

**Entrada/salida HTTP:**
- Validación por esquema (Pydantic) y modelos de respuesta explícitos.
- CORS con orígenes explícitos, nunca `*`.
- Límites de tamaño de request.
- Protección SSRF en toda llamada saliente con URL variable.

**Frontend:**
- Nada de `dangerouslySetInnerHTML` con contenido no sanitizado.
- Markdown del LLM renderizado sin HTML crudo.
- Tokens fuera de `localStorage` cuando sea posible.
- CSP en CloudFront.

### Excepciones documentadas a las skills

| Regla | Excepción en Mango | Motivo | Acordada |
|---|---|---|---|
| `security-best-practices`: "avoid recommending HSTS" | **Sí** se usa HSTS en producción (CloudFront, dominio propio) | Despliegue enterprise siempre sobre TLS. En dev queda desactivado por configuración | 2026-09-28 |
| Cifrado en tránsito (TLS) en todos los tramos | **Solo PoC:** el tramo CloudFront → ALB interno (VPC origin, sin exposición a internet) va en HTTP. Desde D63 por ese tramo pasan también el refresh token (una vez por ingreso) y la cookie de sesión | Sin dominio propio no hay certificado para el ALB. En producción, HTTPS con certificado del dominio del cliente (D15) | 2026-09-28 (ampliada: 2026-10-03) |
| `security-best-practices`: no guardar datos sensibles en Web Storage | El `state` y el `code_verifier` de PKCE van en `sessionStorage` solo durante el redirect a Cognito; los tokens siguen únicamente en memoria | Práctica estándar de OAuth PKCE en SPAs: son de un solo uso, se borran al volver y el verifier sin el code no sirve | 2026-09-29 |
| cfn-guard `NO_UNRESTRICTED_ROUTE_TO_IGW` | **Solo PoC:** las subnets públicas tienen ruta a internet | Fargate sale a las APIs de AWS con IP pública, sin NAT ni VPC endpoints (D15) | 2026-09-29 |
| cfn-guard `LAMBDA_INSIDE_VPC` | Las Lambdas no van en la VPC | Solo llaman APIs de AWS; meterlas en la VPC exige NAT o endpoints sin beneficio de seguridad | 2026-09-29 |
| cfn-guard `IAM_NO_INLINE_POLICY_CHECK` | Roles con políticas inline de los custom resources de CDK | Los genera CDK; no los controlamos | 2026-09-29 |
| cfn-guard `S3_BUCKET_LOGGING_ENABLED` / `S3_BUCKET_VERSIONING_ENABLED` en los buckets de access logs | Los buckets que reciben logs no se loguean a sí mismos ni se versionan | Evita recursión y duplicar costo sin valor; expiran a los 90 días | 2026-09-29 |
| Checkov `CKV_AWS_116` (DLQ en Lambda) | Ninguna Lambda lleva DLQ | Todas se invocan de forma síncrona (Cognito, Gateway, mango-api, custom resources); la DLQ solo recibe invocaciones asíncronas. Una Lambda asíncrona nueva debe llevar DLQ | 2026-09-30 |
| Checkov `CKV_AWS_115` (concurrencia reservada) | Sin concurrencia reservada | Se instala en cuentas de clientes con cuotas desconocidas: reservar rompe el despliegue si la cuota es baja. El abuso lo limitan WAF (rate limit) y el Gateway | 2026-09-30 |
| Checkov `CKV_AWS_174` (TLS ≥ 1.2 en CloudFront) | **Solo PoC:** certificado por defecto `*.cloudfront.net` | Sin dominio propio no se puede fijar la versión mínima de TLS. En producción, certificado ACM del cliente con `TLSv1.2_2021` (D15). La supresión solo aplica sin certificado propio | 2026-09-30 |
| Checkov `CKV_AWS_107` (exposición de credenciales) | `ecr-public:GetAuthorizationToken` y `sts:GetServiceBearerToken` en el rol de ejecución del agente y en el permissions boundary de los roles de agente (`Mango-<ns>-agent-boundary`) | Los exige el harness gestionado de AgentCore para descargar su imagen; estas APIs no admiten scope por recurso. El boundary debe permitir lo que el rol necesita | 2026-09-30 (boundary: 2026-10-01) |
| Regla de auth "Sin revelar si un usuario existe" | Restablecer MFA (solo admins) responde que el correo no existe («Ese correo no está en el directorio») | El endpoint exige admin autenticado, con permiso y auditoría. Los admins ya ven los correos de los usuarios en Auditoría y Presupuestos. Ocultarlo dejaría solicitudes "pendientes" que nunca se aplican. La regla sigue vigente en login, registro y recuperación, que son públicos | 2026-09-30 |
| Regla de auth "Sin revelar si un usuario existe" | Agent Builder › Acceso › «Personas»: `POST /api/directory/users/resolve` responde qué correos están en el directorio (y el correo de un identificador de usuario), solo a creadores de agentes (`mango-agent-creator`) y admins («Ese correo no está en el directorio») | Compartir un agente con una persona exige encontrarla por correo. El endpoint exige sesión y el permiso de crear agentes, tiene límite de tasa por usuario (30 correos por minuto y 200 por día) y audita cada consulta (quién, cuántos correos, cuántos encontrados; nunca la lista de correos). La regla sigue vigente en login, registro y recuperación, que son públicos | 2026-10-02 |
| Regla de auth "Sin revelar si un usuario existe" | Ajustes › Personas: `POST /api/admin/people/search` lista el directorio (correo, estado, MFA, grupos, alta, con búsqueda por inicio del correo) y la invitación responde «Ese correo ya está en el directorio», solo a administradores | Gestionar el acceso de las personas exige verlas (D60). Las rutas exigen administrador autenticado y su permiso, tienen límite de tasa por administrador (120 lecturas por minuto, 20 invitaciones por hora), páginas de 20 sin exportación, y auditan cada lectura con conteos (nunca los correos ni el prefijo buscado). La regla sigue vigente en login, registro y recuperación, que son públicos | 2026-10-03 |
| Regla de auth "Sin revelar si un usuario existe" | Ajustes › Personas › «Cambios de personas»: `GET /api/admin/people/changes` dice si la persona de cada cambio sigue en el directorio («Ya no está en el directorio»), solo a administradores | La tarjeta de un cambio es historial y debe decir que su persona ya no existe (D66). Es el mismo público y el mismo dato que la búsqueda del directorio. La ruta exige administrador autenticado y su permiso, comparte el límite de 120 lecturas por minuto y audita cada lectura con conteos (cuántos cambios y cuántos sin persona; nunca correos). Se responde con la copia del directorio ya leída: como mucho 20 consultas a Cognito por lectura, y solo si el directorio no cabe en una. La regla sigue vigente en login, registro y recuperación, que son públicos | 2026-10-04 |
| Checkov `CKV_AWS_111` / `CKV_AWS_173` en el provider `BucketDeployment` | `cloudfront:CreateInvalidation` sobre `*` y variables de entorno sin CMK | Los genera aws-cdk-lib; no los controlamos. Solo invalida caché y el entorno no contiene secretos | 2026-09-30 |
| cdk-nag `AwsSolutions-ECR1` (acceso abierto al repositorio) | El repositorio de la imagen de `mango-api` en la cuenta del proveedor (`Mango-provider`) usa principal `*` con la condición `aws:PrincipalOrgID` | IAM no tiene principal de organización: leer por organización del cliente (D58) exige `*` más la condición. Solo pull (tres acciones), tags inmutables; un test fija la política y se comprobó desde la organización del cliente | 2026-10-03 |

Las supresiones de cfn-guard viven en `infra/lib/guard.ts` (una por recurso, con motivo). Además se suprimen dos falsos positivos del ruleset: `SUBNET_AUTO_ASSIGN_PUBLIC_IP_DISABLED` (exige que la propiedad no exista aunque valga `false`) y `S3_BUCKET_SSL_REQUESTS_ONLY` (exige `Resource: "*"` literal; se verifica que exista el deny por `aws:SecureTransport`). Un test impide suprimir reglas fuera de esta lista. Las supresiones de Checkov viven en `infra/lib/checkov.ts` con el mismo criterio (mismas excepciones de la tabla, más las de Checkov) y también las protege un test.

## Calidad y convenciones

**Python:**
- `uv`, `ruff` (lint + format), `mypy --strict` por módulo, `pytest` con `moto` o DynamoDB Local.
- Los tests no llaman a AWS real.
- Capas `routes → usecases → repositories → models`, con excepciones de dominio mapeadas centralmente a HTTP.

**TypeScript/CDK:**
- Parámetros validados con `zod`.
- Aspects para tags de costo obligatorios y retención de logs.
- `AwsSolutionsChecks` (cdk-nag) activo, con supresiones justificadas.
- Tests Jest/Vitest: snapshots normalizados + aserciones sobre IAM/trusts + tests de namespacing.
- `cfn-guard` (ruleset Well-Architected Security Pillar, en `policies/guard/`) sobre las plantillas finales: `mise run guard` y en CI.
- Checkov (versión fijada en `mise.toml`, configuración en `.checkov.yaml`) sobre las plantillas sintetizadas, los Dockerfiles y los workflows de GitHub Actions: `mise run checkov` y en CI. Complementa a cdk-nag y cfn-guard, no los reemplaza. Las supresiones se aplican desde CDK (`Metadata.checkov.skip`, en `infra/lib/checkov.ts`), una por recurso y con motivo; solo cubren excepciones ya acordadas y un test impide suprimir checks fuera de esa lista.

**Frontend:** ESLint sin warnings, Prettier, Vitest y Playwright para el flujo de chat.

**Diseño del UI (D24):** el proyecto de Claude Design (`Mango.html`) es la **fuente de verdad** de la interfaz.
- Se implementa tal cual: layout, textos, estados y tokens. Lo que no tiene backend se muestra como "Próximamente", sin datos de ejemplo.
- Nunca se cambia el diseño solo en el código. Si algo no cuadra, no es posible o choca con seguridad, se reporta **antes** para corregirlo primero en Claude Design.
- Las reglas de seguridad ganan sobre el diseño (p. ej. Markdown sin HTML crudo, nada de autorización en el cliente) y la diferencia se reporta.

**Idioma:** código, identificadores, comentarios y mensajes de commit en **inglés**; documentación de arquitectura y de producto en **español**.

**Cambios:** pequeños y enfocados. No mezclar refactors con features. No añadir dependencias sin justificarlas.

**Verificación:** no declarar algo terminado sin ejecutar lint, tipos y tests relevantes y reportar el resultado real.

**Preguntas al usuario:** si un agente necesita una decisión o está bloqueado, pregunta con la herramienta de preguntas de su entorno (en Claude Code, `AskUserQuestion`, con opciones concretas). Nunca deja las preguntas en prosa al final de un mensaje ni solo dentro de un informe: así el terminal no lo marca como bloqueado y nadie se entera de que está esperando.

**CI (`.github/workflows/ci.yml`):** en cada pull request y push a `main` corre lint, tipos y tests (Python, web, infra), `cdk synth` con cdk-nag, `cfn-guard`, Checkov, auditoría de dependencias (`mise run audit`) y búsqueda de secretos (gitleaks). Solo verifica: nunca despliega. No se hace merge a `main` con el CI en rojo. Las actions se fijan por SHA.

### Repositorio público (D59)

Este repositorio es público. Todo lo que se versiona, cada mensaje de commit y cada PR lo puede leer cualquiera, para siempre.

- **Nada real en archivos versionados, commits ni PR:** ids de cuentas de AWS, de organización u OU, ARNs, correos de personas, dominios o URLs de una instalación, ids de user pools o de llaves. Se usan marcadores (`111122223333`, `o-ejemplo`, `nombre@empresa.com`). Los valores reales de una instalación viven en una carpeta local fuera del repo.
- **Commits a nombre del dueño del repositorio,** con su correo `noreply` de GitHub, **sin líneas de atribución** (`Co-Authored-By`, enlaces de sesión). Tampoco en la descripción de los PR.
- **Las ramas salen de `main`** y entran por PR con el CI en verde. La integración se hace por fast-forward desde local (`git push <remoto> <rama>:main`), no con el botón de merge de GitHub, que firma el commit con el correo de la cuenta.
- **Firma y publicación** (`pack-signing`, `release`) corren solo desde `main`, en entornos protegidos que exigen la aprobación del dueño.
- **En los workflows, todo valor con id de cuenta, ARN o nombre de bucket va en secretos de entorno,** nunca en variables del repositorio: los logs son públicos y Actions imprime las variables (solo enmascara secretos). Lo que acaba en un artefacto tampoco se enmascara. Un test lo vigila (`deployment/pack-builder/tests/test_workflows.py`).
- Antes de subir una rama: búsqueda de secretos (`mise run secrets`) y revisión de que el diff no trae datos reales.

### Entorno local

Los builds de packs, las síntesis de CDK y las pruebas e2e dejan mucho en disco y en carpetas temporales. Quien trabaje en el repo (persona o agente) lo limpia al terminar:

- **Caché de builds de Docker:** `docker builder prune -af` después de una ronda de builds de packs (`mise run pack`, el workflow local). Cada build deja capas; se acumulan decenas de GB.
- **Caché de uv:** `uv cache prune` de vez en cuando (`--force` si otro proceso de uv mantiene la caché ocupada). Los `uv run --with …` de las pruebas e2e crean un entorno por combinación de paquetes.
- **Worktrees y procesos:** al cerrar una rama de trabajo, borrar su worktree (`git worktree remove`) y cerrar los servidores que levantó (`pnpm … dev:mock`, Vite).
- **Tests de infra:** usan un directorio temporal propio que se borra al terminar (`infra/test/global-setup.ts`). Un script o test nuevo que sintetice CDK no debe dejar `cdk.out…` en el temporal del sistema.
- **Nada que haga falta después va en `/tmp`.** El sistema lo borra al reiniciar. Los informes, los archivos de estado de recursos temporales del laboratorio (ids de VPC, roles, buckets creados por una prueba) y los resultados de evaluaciones van en una carpeta local fuera del repo (por ejemplo `~/.config/mango/lab/`), nunca en el repo ni en `/tmp`. Los secretos, tampoco en el repo.
- **Recursos temporales del laboratorio:** quien los crea los borra en la misma tarea y deja escrito qué queda pendiente (con ids) si AWS no permite borrarlos todavía.

### Skills de desarrollo (instaladas globalmente)

Se usan igual que las de seguridad: sin esperar a que el usuario lo pida y reportando al final cuál se aplicó.

| Momento | Skill | Cómo |
|---|---|---|
| Al escribir, revisar o refactorizar código React (`apps/web`) | `vercel-react-best-practices` | Aplicar solo las reglas de cliente: re-renders, memoización, bundle, lazy loading, rendering y JS. **No aplican** las reglas de Next.js, Server Components ni `server-*` (`React.cache`, fetch en servidor), porque `apps/web` es una SPA |
| Al tocar el build o la configuración del frontend (`vite.config.ts`, plugins, variables de entorno, chunks, el mock de dev) | `vite` | Referencia de Vite 8 (Rolldown): la versión que usamos |
| Al crear o modificar skills para los agentes de Mango (skills del harness de AgentCore) o skills del propio repo | `skill-development` | Estructura `SKILL.md`, descripciones que disparan bien y divulgación progresiva de referencias |

**Precedencia:** si una regla de estas skills choca con `security-best-practices`, con la CSP de CloudFront o con estas reglas, **gana la seguridad**. Si la diferencia importa, se consulta con el usuario, igual que las excepciones. Ejemplos ya identificados:
- `rendering-hydration-no-flicker` propone un `<script>` inline con `dangerouslySetInnerHTML` para evitar el parpadeo del tema. Está prohibido (`script-src 'self'`, Trusted Types). El tema se aplica en `main.tsx`.
- Las reglas que guardan datos en `localStorage` solo aplican a preferencias de UI, a través de `src/preferences/storage.ts`. Nunca a tokens, sesión ni nada que decida autorización.

## Referencias

- Arquitectura: `docs/architecture/reference-architecture.md`
- Investigación base (bedrock-chat, AgentCore, RAG, gobernanza, multi-cuenta): `docs/architecture/research/`
- Proyecto de referencia (patrones, no fork): https://github.com/aws-samples/bedrock-chat
- Patrón de despliegue multi-cuenta: https://github.com/aws-solutions/innovation-sandbox-on-aws
