# Contrato de la API de la PoC (mango-api ↔ web)

> Fecha: 2026-09-28 (actualizado 2026-09-30: retiro de propuestas, audit log paginado, `GET /api/agents/{id}`, `Retry-After`) · Estado: v0 para la PoC FinOps. La fuente de verdad del backend será el OpenAPI generado por FastAPI; este documento fija el contrato mientras se construyen ambos lados.

## Configuración en runtime del frontend

La SPA descarga `GET /config.json` (servido desde S3 por CloudFront, generado por la IaC):

```json
{
  "region": "us-east-1",
  "cognitoDomain": "https://<prefix>.auth.us-east-1.amazoncognito.com",
  "userPoolId": "us-east-1_XXXX",
  "clientId": "xxxxxxxx",
  "apiBasePath": "/api",
  "signUpDomains": ["empresa.com"],
  "aiPolicyUrl": "https://intranet.empresa.com/politica-ia",
  "ssoProvider": "EntraID",
  "auth": { "installationType": "customer", "mfa": "required", "sessionHours": 12 }
}
```

- **Autenticación (D20, 2026-09-30):** login propio en la SPA contra la API pública de Cognito (`https://cognito-idp.<region>.amazonaws.com/`, sin Amplify ni AWS SDK): `InitiateAuth` con **`USER_SRP_AUTH`** + `RespondToAuthChallenge` (`PASSWORD_VERIFIER`, `SOFTWARE_TOKEN_MFA`, `MFA_SETUP`, `NEW_PASSWORD_REQUIRED`), alta de TOTP con `AssociateSoftwareToken`/`VerifySoftwareToken` usando la `Session` del reto, registro (`SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`), recuperación (`ForgotPassword`, `ConfirmForgotPassword`), refresh con `REFRESH_TOKEN_AUTH` y cierre con `RevokeToken`. Nunca `USER_PASSWORD_AUTH`.
- **`signUpDomains`:** dominios que el formulario de registro acepta (solo pista de UI; la Lambda *pre sign-up* los valida en el servidor).
- **`aiPolicyUrl` (opcional):** política de uso de IA de la empresa (parámetro de instalación `auth.aiPolicyUrl`, solo `https:`). Si existe, el registro pide aceptarla con un enlace que abre en una pestaña nueva (`noopener noreferrer`); si no, no hay casilla. La SPA la valida con zod y otra vez antes de usarla en un `href`.
- **`ssoProvider` (opcional):** nombre del IdP del cliente en el User Pool. Si existe, "Continuar con SSO" hace authorization code + **PKCE** contra el managed login con `identity_provider=<ssoProvider>`; `redirect_uri` es `window.location.origin + "/"` y el logout de esas sesiones va por `<cognitoDomain>/logout?client_id=…&logout_uri=<origin>/`.
- **`auth` (obligatorio, 2026-09-30):** política de autenticación de la instalación, solo para mostrarla en Ajustes › Autenticación (la aplican Cognito y la instalación, no la SPA). `installationType` (`customer`|`lab`) y `mfa` (`required`|`off`) salen de los parámetros de instalación; `sessionHours` es la validez del refresh token del web client (`SESSION_HOURS` en `identity.ts`). Lo validan con zod `edge.ts` (con `.strict()`, en el synth) y `runtimeConfig.ts`. En instalaciones `customer`, MFA se muestra como «Fijo». El IdP se muestra a partir de `ssoProvider` («Sin IdP» si no existe). Sin secretos.
- **Tokens:** se guardan **en memoria**, nunca en Web Storage. Si se recarga la página, se pide login de nuevo. El access token no trae el scope `aws.cognito.signin.user.admin` (lo suprime el pre-token), así que no sirve para las APIs de autoservicio de Cognito.
- **Llamadas a la API:** `Authorization: Bearer <access_token>`. Se usa el access token, no el ID token.

## Endpoints

Todos van bajo `/api`, en JSON, y con Bearer obligatorio salvo `/api/health`.

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/api/health` | `{"status":"ok"}` |
| GET | `/api/me` | `{"user_id": str, "email": str\|null, "name": str\|null, "role": "finops-central"\|"bu-lead"\|null, "business_unit": str\|null, "is_admin": bool, "groups": [str], "can": {"create_agent": bool}}`. `email` y `name` son solo para mostrar (claims `mango_email` y `mango_name` del access token; `name` lo elige el usuario al registrarse); nunca se usan para autorizar. `groups` y `can` se describen en «Grupos (Marketplace v1, A1)». Un usuario **sin grupo** recibe **403 `no_group`** en esta y en todas las rutas (la SPA muestra "Todavía no tienes acceso") |
| GET | `/api/conversations` | `{"items": [{"conversation_id": str, "title": str, "updated_at": ISO8601, "agent_id": str}]}` (solo las del usuario). `agent_id` es el agente de la conversación; las guardadas antes de A5 devuelven el agente de la release (`finops`) |
| GET | `/api/conversations/{conversation_id}` | `{"conversation_id", "title", "agent_id", "messages": [{"message_id", "role": "user"\|"assistant", "content": str, "created_at", "tools": [{"name", "status"}]}]}` |
| POST | `/api/chat` | **SSE** (ver «Chat con varios agentes» y el formato de eventos más abajo). Body: `{"conversation_id": str \| null, "message": str (1..4000), "agent_id"?: str, "model"?: str}`. Cualquier otro campo → 422 |

`GET /api/agents/finops` ya no es una ruta aparte: FinOps es un agente más de la tabla `Agents` y responde `GET /api/agents/{id}` (ver «Agentes»), con la misma forma que cualquier otro.

### Chat con varios agentes (Marketplace v1, A5)

- **Agente.** `agent_id` elige el agente de una conversación **nueva**; si falta, es el agente de la release (`finops`). Una conversación conserva el agente de su primer turno: en los turnos siguientes `agent_id` se puede omitir, y si se envía otro distinto la respuesta es 409 `agent_mismatch`.
- **Modelo.** `model` debe ser uno de los `allowed_models` de la versión publicada (D22); si falta, se usa el modelo por defecto del agente. El modelo se elige por turno, no se guarda en la conversación.
- **Qué se ejecuta.** `mango-api` arma la invocación solo con la versión publicada del agente: prompt, límites y tools. La versión se lee del puntero `PUBLISHED#<id>` que escribe el provisioner y su contenido se verifica contra el hash desplegado (D40). Del cliente solo entran el mensaje, el agente y el modelo.
- **Autorización.** `UseAgent` sobre `Mango::Agent::<id>` con los grupos y usuarios de esa versión (D33). Un agente inexistente, sin publicar o sin permiso responde lo mismo: 403.
- **Presupuesto.** Se reserva antes de invocar, con el precio del modelo elegido en el catálogo de modelos (Brains), en los ámbitos `USER#<sub>` y `AGENT#<agent_id>`. Al terminar se cobra el uso real y se libera el resto. Si el final del turno no se conoce (el agente falló o `mango-api` dejó de leerlo), se cobra lo ya contado y el resto de la reserva queda retenido hasta que la función conciliadora lee lo que gastó el agente, unos minutos después (D73).
- **Auditoría.** `policy.decision`, `agent.invoke`, `agent.completed` y `budget.exceeded` llevan `agent`; los tres últimos también `version` y `model`. `agent.completed` dice además cómo quedó la reserva: `settlement` (`final`; `pending` si el resto quedó retenido; `reconciler` si la función conciliadora cerró el turno antes) y `held_usd`. Un turno retenido deja después un `budget.reconciled`, escrito por `system:budget-reconciler`, con lo cobrado (`cost_usd`), lo que ya se conocía, lo liberado, de dónde salió el dato (`basis`: `trace`, `partial`, `reservation`, `not_invoked`), el motivo y los tokens (D73).

| Estado | `error.code` | Cuándo |
|---|---|---|
| 403 | `forbidden` | Sin `UseAgent`, o el agente no existe o no está publicado |
| 404 | `not_found` | La conversación no existe para este usuario |
| 409 | `agent_mismatch` | `agent_id` distinto del agente de la conversación |
| 409 | `agent_retired` | El agente fue retirado: no recibe turnos, ni en conversaciones nuevas ni en las existentes (el historial se sigue leyendo) |
| 409 | `model_unavailable` | El modelo está deshabilitado o sin precio en el catálogo de modelos |
| 409 | `conversation_busy` | Otro turno de la misma conversación sigue en curso |
| 422 | `model_not_allowed` | `model` no está en los modelos permitidos de la versión publicada |
| 422 | `invalid_request` | Cuerpo inválido (campo desconocido, `agent_id` o `model` mal formados) |
| 402 | `budget_exceeded` | Presupuesto del usuario o del agente agotado |
| 503 | `agent_unavailable` | No se pudo establecer la versión publicada (tabla o catálogo ilegibles, contenido que no coincide con el hash desplegado). Fail-closed: no se usa una copia anterior |
| 503 | `budget_unavailable` | No se pudieron leer los límites o registrar la reserva |

- La versión publicada se cachea 15 s y el catálogo de modelos 30 s: una publicación, un retiro o deshabilitar un modelo tardan como mucho eso en aplicarse al chat.

### Admin v0 (D17)

Todos requieren `is_admin` y una acción de Verified Permissions: `ViewAdmin` para lecturas, `ManageBudgets`, `ProposeBusinessUnits` y `ApproveBusinessUnits`. Toda escritura:
- usa bloqueo optimista con `version` (si cambió → 409 `version_conflict`);
- emite un evento de auditoría con antes/después **antes** de escribir (`outcome: requested`) y otro al terminar (`applied` o `rejected` con el código de error). Si la auditoría no está disponible, no se escribe y responde 503 `audit_unavailable`;
- valida el cuerpo con `extra="forbid"`.

Límites del mapeo: como máximo **20 áreas × 15 OUs por área**, para que la propuesta más grande quepa en el límite de 32 KiB por request. Como máximo **10 propuestas pendientes** a la vez.

Montos en USD como string decimal (`"12.50"`).

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| GET | `/api/admin/budgets` | → `{"period": "2026-09", "version": int, "defaults": {"user_monthly_usd": str, "agent_monthly_usd": str}, "agents": [{"agent_id": str, "name": str\|null, "limit_usd": str, "spent_usd": str}], "users": [{"user_id": str, "email": str\|null, "limit_usd": str, "override": bool, "spent_usd": str}]}`. `users` incluye a quien tenga gasto en el período o un límite propio. `agents` incluye el agente de la release y todo agente con gasto en el período (el de la release primero, luego por nombre); `name` es el del agente publicado o retirado, o `null` si no se pudo leer |
| PUT | `/api/admin/budgets/defaults` | `{"version": int, "user_monthly_usd": str, "agent_monthly_usd": str}` → el mismo GET. Rango `0 < x ≤ 1000000` |
| PUT | `/api/admin/budgets/users/{user_id}` | `{"version": int, "limit_usd": str \| null}` (`null` quita el límite propio) → el mismo GET. **403 `self_edit`** si `user_id` es el propio admin |
| GET | `/api/admin/business-units` | → `{"version": int, "units": {"<área>": ["ou-…"]}, "pending": [{"change_id": str, "proposed_by": str, "proposed_by_email": str\|null, "created_at": ISO8601, "expires_at": ISO8601, "base_version": int, "units": {…}, "reason": str}]}` |
| POST | `/api/admin/business-units/changes` | `{"base_version": int, "units": {"<área>": ["ou-…"]}, "reason": str (1..500)}` → 201 `{"change_id": str}`. Áreas `^[a-z0-9-]{2,32}$`, OUs que existan en la organización (400 `unknown_ou`). **403 `self_edit`** si el cambio toca el área del admin; **409 `too_many_pending`** si ya hay 10 propuestas pendientes |
| POST | `/api/admin/business-units/changes/{change_id}/approve` | `{}` → el GET del mapeo. **403 `same_approver`** si lo aprueba quien lo propuso; **403 `self_edit`** si toca el área del aprobador; **409 `version_conflict`** si el mapeo cambió desde la propuesta; **410 `expired`** después de 7 días |
| POST | `/api/admin/business-units/changes/{change_id}/reject` | `{"reason": str (1..500)}` → el GET del mapeo. Acción `ApproveBusinessUnits`. **403 `self_edit`** si toca el área de quien rechaza; **403 `use_withdraw`** si quien rechaza es el proponente (usa `withdraw`) |
| POST | `/api/admin/business-units/changes/{change_id}/withdraw` | `{}` (sin motivo; cualquier campo → 422) → el GET del mapeo. Acción `ProposeBusinessUnits`. Solo el proponente (**403 `not_proposer`**; la condición de DynamoDB lo vuelve a comprobar). Audita `settings.bu_mapping.withdrawn` (`requested` → `applied`/`rejected`, fail-closed) con `change_id` y `proposed_by`. **409** si ya estaba cerrada |
| GET | `/api/admin/organization` | → `{"ous": [{"id": "ou-…", "name": str, "parent_id": str, "path": [str]}]}` (nombres), cacheado 1 min |
| POST | `/api/admin/connectivity-check` | `{}` → `{"checked_at": ISO8601, "checks": [{"name": "broker"\|"billing_reader"\|"organizations", "status": "ok"\|"error", "detail": str}]}`. Máximo 5 por minuto por admin (429 con `Retry-After`) |

### Grupos (Marketplace v1, A1)

Un usuario entra a Mango si pertenece al menos a un **grupo de Mango**. El rol FinOps es opcional.

- **Origen:** el claim `cognito:groups` del access token verificado, que escribe Cognito. Solo IaC o un administrador cambian la pertenencia. Nada viene del cliente ni del modelo.
- **Nombre de grupo:** `^[a-z0-9][a-z0-9-]{1,63}$`. Los demás nombres del claim se ignoran; por ejemplo, los grupos que Cognito crea para un IdP federado (`<pool>_<proveedor>`).
- **Sin grupo de Mango:** 403 `no_group` en todas las rutas, como antes. Un claim `cognito:groups` mal formado (no es lista o tiene más de 100 entradas) responde 401.
- **Rol FinOps:** sigue saliendo del claim `mango_role` (pre-token). `role` es `null` si el usuario no está en `finops-central` ni en `bu-lead`. Sin rol no hay `UseAgent` sobre FinOps (403) y el conector de Cost Explorer rechaza la llamada.
- **`groups`** en `/api/me`: los grupos de Mango del usuario, ordenados.
- **`can`**: pistas **solo para la UI**. No autorizan nada: cada endpoint comprueba su acción Cedar. `create_agent` es la decisión Cedar de `CreateAgent` para ese usuario (hoy: admins y miembros de `mango-agent-creator`). No se audita, porque no da acceso a nada. Si Verified Permissions falla, vale `false`.
- **Cedar L1:** la entidad `Mango::User` lleva `groups` (conjunto de strings; `mango-api` siempre lo envía) y `role` pasa a opcional. Las políticas comprueban `has` antes de leerlos.

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| GET | `/api/groups` | → `{"items": [{"id": str, "type": "central"\|"area"\|"general", "area": str\|null, "description": str}]}`, ordenado por `id`. Acción `ViewGroups` (admins y miembros de `mango-agent-creator`; 403 para el resto). La decisión se audita como lectura. **503 `groups_unavailable`** si el registro no se puede leer o tiene una entrada inválida (nunca una lista parcial) |

Registro de grupos de acceso (D26): tabla `Settings`, partición `GROUPS`, un ítem por grupo (`SK` = id) con `type`, `area` (solo en grupos de área; es un área del mapeo) y `description` (hasta 200 caracteres). Lo siembra IaC **una sola vez**, mientras la partición está vacía: `finops-central` (central), `bu-lead` (general), `bu-<área>` por cada área (de área) y los `accessGroups` de la configuración. Después la tabla manda, igual que en D17. `mango-admin` y `mango-agent-creator` dan permisos, no acceso a agentes, y no están en el registro. No hay endpoints de escritura: crear o cambiar grupos con doble aprobación llega con Ajustes › Grupos.

### Ajustes › Grupos (Marketplace v1, C1)

Cambios al registro de grupos de acceso con **doble aprobación** (D26, D35; TM-M13). Un administrador propone crear un grupo, cambiarle el tipo o el área, o eliminarlo; **otro** administrador lo aprueba. Solo la descripción la edita un único administrador.

- **Autorización:** todas las rutas exigen administrador. Acciones Cedar: `ViewAdmin` (leer), `ProposeGroups` (proponer, retirar y editar la descripción) y `ApproveGroups` (aprobar y rechazar).
- **Quién no puede:** quien propone no aprueba ni rechaza su propia solicitud (la retira). Nadie propone ni decide la creación o el cambio de tipo de un grupo al que pertenece (403 `self_edit`). Los intentos rechazados por estas dos reglas se auditan.
- **Cognito:** al aprobar una creación se crea el grupo en el User Pool (si ya existía, se adopta); al aprobar una eliminación se borra. La pertenencia nunca se toca desde Mango: los miembros se asignan en el directorio.
- **Nombres:** un grupo nuevo cumple `^[a-z0-9][a-z0-9-]{1,31}$`. `mango-*` está reservado. `finops-central` (central), `bu-lead` (general) y `bu-<área>` (de área, con esa área) solo existen con ese tipo, porque el pre-token los lee así; `finops-central` y `bu-lead` no se eliminan.
- **Reglas que el servidor comprueba al proponer y otra vez al aprobar:** el área existe en el mapeo de áreas; un grupo central no deja de serlo mientras un agente publicado, aprobado o en revisión lo use con tools de datos de cuentas; no se crea un grupo con un nombre que algún agente todavía usa.
- **Concurrencia:** una sola solicitud abierta por grupo; cada solicitud lleva la versión del grupo sobre la que se hizo y se aplica en una transacción condicional. Máximo 10 solicitudes pendientes y 20 propuestas por hora por administrador.
- **Vencimiento:** una solicitud que nadie aprueba en 72 h vence (`status: "expired"`) y deja de bloquear al grupo.
- **Auditoría (fail-closed):** `settings.groups.proposed`, `.approved`, `.rejected`, `.withdrawn` y `.description_updated`, con `outcome` `requested` → `applied` o `rejected`. Si no se puede auditar, no se escribe nada (503 `audit_unavailable`). La aprobación registra los dos `sub`, el antes y el después, y qué pasó en el directorio (`directory`: `created`, `adopted`, `deleted` o `absent`).
- **Claim `mango_central`:** el pre-token lo añade al access token y al ID token (`"true"`) cuando el usuario pertenece a un grupo de tipo `central` según el registro. Lo calcula en cada emisión; si no puede leer el registro, no lo añade (fail-closed). Un cambio de tipo se refleja en el siguiente token (como máximo 60 minutos después).

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| GET | `/api/admin/groups` | → `{"items": [Group], "changes": [Change]}`. Grupos ordenados por `id`; solicitudes de los últimos 30 días, de la más nueva a la más vieja |
| POST | `/api/admin/groups/changes` | `{"kind": "create"\|"update"\|"delete", "group_id": str, "type"?: "central"\|"area"\|"general", "area"?: str\|null, "description"?: str (≤200), "base_version"?: int, "reason": str (1..500)}` → 201 `{"change_id": str}`. `type` es obligatorio salvo en `delete`; `area` solo con `type: "area"`; `base_version` es obligatorio salvo en `create` |
| POST | `/api/admin/groups/changes/{change_id}/approve` | `{}` → lista actualizada |
| POST | `/api/admin/groups/changes/{change_id}/reject` | `{"reason": str (1..500)}` → lista actualizada |
| POST | `/api/admin/groups/changes/{change_id}/withdraw` | `{}` → lista actualizada. Solo quien propuso |
| PUT | `/api/admin/groups/{group_id}/description` | `{"version": int, "description": str (≤200)}` → lista actualizada. No se permite con una solicitud abierta sobre el grupo |

`Group`: `{"id", "type", "area": str\|null, "description", "version": int, "system": bool, "fixed_type": bool, "agents": [{"id", "name", "account_data": bool}]}`. `agents` son los agentes publicados que comparten con el grupo; `account_data` indica que usan tools reservadas a grupos centrales. El número de miembros no se devuelve: `mango-api` no lee la pertenencia del directorio.

`Change`: `{"change_id", "kind", "group_id", "status": "pending"\|"approved"\|"rejected"\|"withdrawn"\|"expired", "before": {"type", "area"}\|null, "after": {"type", "area", "description": str\|null}\|null, "agents": int, "proposed_by", "proposed_by_email", "reason", "created_at", "expires_at", "decided_by", "decided_by_email", "decided_at", "note"}`.

| Estado | `error.code` | Cuándo |
|---|---|---|
| 403 | `same_approver` · `use_withdraw` · `not_proposer` | Aprobar o rechazar la solicitud propia; retirar la de otro |
| 403 | `self_edit` | Proponer o decidir la creación o el cambio de tipo de un grupo propio |
| 404 | `not_found` | El grupo o la solicitud no existe |
| 409 | `group_exists` · `already_pending` · `too_many_pending` · `too_many_groups` | Nombre ya registrado; solicitud abierta sobre el grupo; demasiadas pendientes; registro lleno (100) |
| 409 | `central_in_use` · `group_referenced` | Con `agents: [id]` junto a `error`: agentes que lo impiden |
| 409 | `version_conflict` | El grupo o la solicitud cambió; hay que recargar |
| 410 | `expired` | La solicitud venció |
| 422 | `reserved_name` · `fixed_type` · `system_group` · `unknown_area` · `invalid_request` | Reglas de nombres, tipo, área y forma del cuerpo |
| 429 | `rate_limited` | Con `Retry-After`. Los límites compartidos entre tareas (D70) responden igual cuando su tabla no contesta: la llamada se rechaza, con `Retry-After: 5` como mucho |
| 502 | `upstream_error` | Cognito falló; la solicitud sigue pendiente y se puede reintentar |
| 503 | `audit_unavailable` · `groups_unavailable` · `agents_unavailable` · `settings_unavailable` | No se pudo auditar o leer lo necesario para decidir: no se aplica nada |

### Agentes (Marketplace v1, A3)

Ciclo de una versión de agente hasta `approved` (D18, D22, D30, D33). Publicar es del provisioner: `mango-api` solo lo inicia.

**Autorización (Cedar L1).** Las decisiones sobre un agente usan la entidad `Mango::Agent` con atributos que `mango-api` lee de la tabla `Agents`, nunca de la petición:

| Acción | Recurso | Quién |
|---|---|---|
| `UseAgent` | `Mango::Agent` con `groups` y `users` de la versión publicada | Quien esté en uno de esos grupos o en la lista de usuarios. Ni los admins ni el creador lo usan si no se compartió con ellos |
| `CreateAgent`, `ViewMcpCatalog` | `Mango::Platform` | Admins y miembros de `mango-agent-creator` |
| `EditAgent` | `Mango::Agent` con `creator` | Admins, y el creador del agente mientras siga en `mango-agent-creator` |
| `ApproveAgent` | `Mango::Agent` (decidir) o `Mango::Platform` (la cola) | Admins |
| `RetireAgent` | `Mango::Agent` | Admins |

- Un agente que no existe, que no está publicado o que el usuario no puede usar responde lo mismo: **403**. Solo quien sí tiene permiso (un admin) recibe 404.
- Las listas se filtran con la misma política `UseAgent`. Cada lista deja **una** `policy.decision` de solo lectura (`resource: "Mango::Agent::*"`, `scope`, `visible`), no una por agente.
- Los ids los genera el servidor: 16 caracteres `[a-z2-7]`. Las versiones se numeran desde 1 dentro del agente.

**Estados de una versión:** `draft`, `in_review`, `approved`, `published`, `failed`, `superseded`, `retired`. Un rechazo la devuelve a `draft` con `rejection_reason`; ese borrador sigue en el índice `ByStatus` (`VERSION#rejected`) para que el historial de revisión lo muestre.

Los correos `*_by_email` se guardan al decidir (aprobar, rechazar, retirar), igual que `created_by_email`. Son `null` en decisiones anteriores a este cambio y en las de la release.

**Definición** (`definition`, igual al entrar y al salir; cualquier otro campo → 422):

```json
{
  "name": "str (1..40)", "description": "str (0..140)", "category": "str (0..24)",
  "icon": "str", "color": 0,
  "reports_to": "platform | <id de agente> | null", "role": "str (0..40)",
  "model": "<id de modelo> | null", "allowed_models": ["<id de modelo>"],
  "system_prompt": "str (0..12000)",
  "tools": ["<conector>.<tool>"], "approval_tools": ["<conector>.<tool>"],
  "limits": {"max_tokens": 4096, "max_iterations": 8, "timeout_seconds": 120, "max_tokens_per_call": null, "temperature": null},
  "groups": ["<grupo>"], "users": ["<sub>"]
}
```

Un borrador solo tiene que cumplir este esquema. Las reglas completas se aplican al enviar y otra vez al aprobar.

**Versión** (`VersionOut`), respuesta de casi todas las rutas:

```json
{
  "agent_id": "str", "version": 1, "status": "draft", "revision": 1,
  "content_hash": "sha256 hex | null", "base_version": "int | null",
  "created_by": "<sub>", "created_by_email": "str | null", "created_at": "ISO8601", "updated_at": "ISO8601",
  "submitted_by": "<sub> | null", "submitted_at": "ISO8601 | null",
  "approved_by": "<sub> | null", "approved_by_email": "str | null", "approved_at": "ISO8601 | null",
  "rejected_by": "<sub> | null", "rejected_by_email": "str | null", "rejected_at": "ISO8601 | null", "rejection_reason": "str | null",
  "failed_step": "str | null", "failure": "str | null", "published_at": "ISO8601 | null",
  "is_author": true,
  "agent": {"status": "draft | published | retired", "lock_version": 1, "published_version": "int | null", "open_version": "int | null", "created_by": "<sub>"},
  "definition": {},
  "base": "definición publicada | null",
  "diff": {
    "is_new": false,
    "fields": [{"field": "name | … | limits.max_tokens", "before": "…", "after": "…"}],
    "sets": [{"field": "allowed_models | tools | approval_tools | groups | users", "added": ["…"], "removed": ["…"]}],
    "prompt": [{"op": "+ | - | (espacio)", "text": "línea"}],
    "changes": 0
  },
  "violations": [{"code": "str", "field": "str", "items": ["…"]}]
}
```

- `revision` es el bloqueo optimista del borrador. `content_hash` existe desde que se envía a revisión.
- `is_author`: quien llama escribió ese contenido (lo creó, lo editó o lo envió) y **no puede aprobarlo ni rechazarlo**. Es una pista; decide la API.
- `diff` lo calcula el servidor contra la versión **publicada ahora**. `prompt` es `null` si no cambió. Con más de 800 líneas por lado, el prompt se muestra como reemplazo completo. En un agente nuevo, `is_new` es `true` y `base` es `null`.
- `violations`: reglas de envío que el contenido incumple en este momento (`[]` si ninguna; `null` si no se pudieron evaluar). Son códigos: el texto lo pone la UI. Las que cuentan se evalúan al enviar y al aprobar.
- Nunca se devuelve la lista de editores.

| Método | Ruta | Acción | Cuerpo → respuesta |
|---|---|---|---|
| GET | `/api/agents` | `UseAgent` (filtrado) | → `{"items": [Agent]}`: agentes publicados y retirados que el usuario puede usar, por nombre. Una publicación hecha por el provisioner puede tardar hasta 15 s en aparecer (D70 (11)). Máximo 30 por minuto por persona, contadas junto con `GET /api/agents/org` (**429 `rate_limited`** con `Retry-After`) |
| GET | `/api/agents/{id}` | `UseAgent` | → `Agent` de la versión publicada (o retirada) |
| GET | `/api/agents/mine` | `CreateAgent` | → `{"items": [resumen], "quotas": {"drafts", "max_drafts": 20, "submissions_today", "max_submissions_per_day": 5}}`. Versiones propias en `draft`, `in_review`, `approved` o `failed`. Resumen: `agent_id`, `version`, `status`, `revision`, `base_version`, `name`, `description`, `category`, `icon`, `color`, `created_at`, `updated_at`, `submitted_at`, `rejected_at`, `rejection_reason`, `failed_step` |
| POST | `/api/agents` | `CreateAgent` | `{"definition": {…}}` → 201 `VersionOut` (versión 1, `draft`). **409 `too_many_drafts`** con 20 borradores |
| POST | `/api/agents/{id}/versions` | `EditAgent` | `{}` → 201 `VersionOut`: borrador nuevo con el contenido de la versión publicada. **409** si el agente no está publicado o ya tiene una versión abierta |
| GET | `/api/agents/{id}/versions/{v}` | `EditAgent` o `ApproveAgent` | → `VersionOut` |
| PUT | `/api/agents/{id}/versions/{v}` | `EditAgent` | `{"revision": int, "definition": {…}}` → `VersionOut`. Solo borradores. **409 `version_conflict`** si ya no es borrador o cambió la revisión |
| DELETE | `/api/agents/{id}/versions/{v}?revision=<int>` | `EditAgent` | → 204. Solo borradores. Un agente que nunca se publicó desaparece con su único borrador |
| POST | `…/versions/{v}/submit` | `EditAgent` | `{"revision": int}` → `VersionOut` (`in_review`, con `content_hash`). **422 `validation_failed`** con `violations`; **429 `submission_limit`** con `Retry-After` (segundos hasta el siguiente día UTC) |
| POST | `…/versions/{v}/reopen` | `EditAgent` | `{}` → `VersionOut`. Solo `failed`: vuelve a `draft` para corregirla |
| GET | `/api/agents/reviews` | `ApproveAgent` | → `{"queue": [revisión], "history": [revisión]}`. `queue`: versiones `in_review`, la más antigua primero, con `changes`. `history`: hasta 100 versiones `approved`, `failed`, `published` o `retired`, más los borradores que un revisor rechazó (`status: "draft"` con `rejection_reason`, hasta que su autor los reenvía o los descarta), la más reciente primero según `decided_at`. Revisión: `agent_id`, `version`, `status`, `kind` (`new`\|`change`), `name`, `description`, `category`, `icon`, `color`, `content_hash`, `created_by`, `created_by_email`, `submitted_at`, `approved_by`, `approved_by_email`, `approved_at`, `published_at`, `failed_step`, `rejected_by`, `rejected_by_email`, `rejected_at`, `rejection_reason`, `retired_by`, `retired_by_email`, `retired_at`, `retire_reason` (los cuatro de retiro solo en versiones `retired`), `decided_at`, `changes`, `retryable`, `is_author`. `changes` en `history` cuenta contra la versión de la que partió (`base_version`); es `null` si esa versión ya no se puede leer. `retryable`: `retry` se aceptaría ahora |
| POST | `…/versions/{v}/approve` | `ApproveAgent` | `{"content_hash": str}` → `VersionOut`. Vuelve a aplicar las reglas de envío. **403 `same_approver`** si quien aprueba escribió la versión; **409** si no está en revisión o el hash no es el guardado; **422 `validation_failed`**; **503 `provisioner_unavailable`** si la instalación aún no tiene provisioner (no se aprueba nada). Después inicia el provisioner con `{agent_id, version, content_hash}`; si no arranca, la versión queda `failed` con `failed_step: "start_provisioner"` |
| POST | `…/versions/{v}/reject` | `ApproveAgent` | `{"reason": str (1..500)}` → `VersionOut` (`draft`). **403 `same_approver`** para quien escribió la versión |
| POST | `…/versions/{v}/retry` | `ApproveAgent` | `{"content_hash": str}` → `VersionOut`. Con el mismo hash; conserva el aprobador. Acepta una versión `failed`, o una `approved` desde hace más de 45 minutos (la ejecución del provisioner vence a los 25 y su bloqueo a los 30: ya nada la está publicando). En ese caso primero pasa a `failed` con `failed_step: "publication_expired"` y luego se reintenta; antes de ese plazo responde **409** |
| POST | `/api/agents/{id}/retire` | `RetireAgent` | `{"lock_version": int, "reason": str (1..500)}` → `Agent` (`retired`). `lock_version` es `agent.lock_version`. **409** si cambió o no está publicado. Además inicia el borrado del harness y del rol del agente (D48); la respuesta no espera a ese borrado ni cambia si no arranca |
| GET | `/api/agents/org` | `UseAgent` (filtrado) | → `{"root": "platform", "nodes": [{"id", "version", "name", "role", "description", "category", "icon", "color", "reports_to", "can_use": bool, "groups": [str], "can_edit": bool}]}`. `version` es la versión publicada. Admins y creadores ven todos los agentes publicados; el resto, los que puede usar (D38). `reports_to` es `null` si el supervisor no es visible para quien llama o está retirado. `can_use` dice si quien llama puede usarlo (`UseAgent`); es solo para mostrar. `groups` son los grupos con los que se comparte la versión publicada y solo viene cuando `can_use` es `false` (en los demás nodos es `[]`); nunca las personas (D65). `can_edit` dice si quien llama puede editarlo (`EditAgent`: quien lo creó o un administrador, la misma regla que al abrir una versión); es solo para mostrar: el Agent Builder autoriza cada petición por su cuenta. La pantalla todavía no lo usa (espera a Claude Design). Comparte el límite de 30 por minuto por persona de `GET /api/agents` (**429 `rate_limited`** con `Retry-After`) |
| GET | `/api/mcp/catalog` | `ViewMcpCatalog` | Ver «Catálogo de MCP» más abajo |
| GET | `/api/models` | `CreateAgent` | → `{"version": int, "items": [{"id", "name", "provider", "supports_tools", "context_tokens": int\|null, "input_usd", "output_usd"}]}`: solo modelos habilitados; precios en USD por millón de tokens |

`Agent`: `{"id", "status": "published"|"retired", "version", "lock_version": int|null, "name", "description", "category", "icon", "color", "role", "reports_to", "model", "allowed_models", "tools", "unavailable_tools", "published_at", "retired_at", "retire_reason"}`. `unavailable_tools`: tools de la versión publicada que su MCP pack no sirve ahora (pack deshabilitado, o una versión instalada sin esa tool); el agente responde sin ellas hasta que se edite (D46). Siempre `[]` en un agente retirado. No incluye el prompt ni los grupos y usuarios con acceso. `lock_version` solo viene en el detalle.

**Reglas de envío** (`violations[].code`): `prompt_required`, `reports_to_required`, `role_required`, `groups_required`, `definition_too_large`, `secret_detected` (`items`: tipo de secreto, nunca el valor), `reports_to_cycle`, `reports_to_unknown`, `model_required`, `default_model_not_allowed`, `model_not_enabled`, `model_without_tools`, `tool_not_enabled`, `approval_tool_not_selected`, `write_tool_without_approval`, `group_unknown`, `account_data_for_non_central_group`, `account_data_for_users`. Al aprobar, la regla de ciclos cuenta también los cambios de «Reporta a» ya aprobados que aún no se publican.

**Errores propios de estas rutas:**
- 422 `validation_failed`: `{"error": {…}, "violations": [...]}`. El cliente web conserva `violations` en el error y las muestra sin volver a leer la versión.
- 422 `invalid_request`: nombra los campos inválidos, nunca su contenido. Un campo desconocido aparece como `?`.
- 409 `version_conflict`, 409 `too_many_drafts`, 429 `submission_limit`, 403 `same_approver`.
- 503 `models_unavailable`, `groups_unavailable` o `catalog_unavailable` si no se pueden evaluar las reglas al enviar o aprobar (no se envía ni se aprueba nada); 503 `provisioner_unavailable`.

**Auditoría.** Toda escritura registra `requested` antes de escribir (503 `audit_unavailable` y no se escribe si falla) y `applied` o `rejected` (con `error` y, si aplica, los códigos de `violations`) al terminar. Eventos: `agent.created`, `agent.version.created`, `agent.version.saved`, `agent.version.discarded`, `agent.version.submitted`, `agent.version.approved`, `agent.version.rejected`, `agent.version.retried`, `agent.version.reopened`, `agent.retired`. Además, sin `outcome`: `agent.provisioner.started` (`execution`), `agent.version.failed` (`failed_step`) y, tras un retiro, `agent.deprovisioner.started` (`execution`) o `agent.deprovisioner.start_failed`. El deprovisioner (`system:provisioner`) registra `agent.deprovision` con `outcome` `requested`, `applied` o `rejected` (`execution`, `harness`, `role` y, si falla, `failed_step` y `failure`). Llevan `agent`, `version`, los `sub` implicados (`created_by`, `submitted_by`, `approved_by`…) y `content_hash`; nunca la definición.

### Catálogo de MCP (Marketplace v1, B3)

Conectores de Mango y MCP packs de la release (spec §4.4, D19, D26, D36). `mango-api` solo registra decisiones e inicia el provisioner de packs con `{pack_id, pack_version, enablement_id}`: nunca crea el rol, el Runtime, el target ni las políticas.

- **Quién.** Leer: `ViewMcpCatalog` (admins y creadores). Pedir, reintentar y deshabilitar: `EnableMcp`. Aprobar y rechazar: `ApproveMcp`. Las dos últimas, solo `mango-admin`.
- **Doble aprobación.** Quien pide no aprueba ni rechaza (**403 `same_approver`** / **403 `use_withdraw`**); solo quien pidió retira su solicitud. Una solicitud pendiente por pack; vence a los 7 días (**410 `expired`**).
- **Qué se puede pedir.** Solo packs que nombra la release, con la versión y la declaración firmada de la release. El cuerpo nunca lleva versión, IAM ni ARNs. `config` solo admite claves del manifiesto con valores de su lista (**422 `invalid_config`**); lo que no se envía toma su valor por defecto.
- **Bloqueo optimista.** `version` es `pack.lock_version` del pack tal como lo vio quien llama (0 si nunca se pidió). **409 `version_conflict`** si cambió.
- **Mientras se decide o se instala, sigue lo instalado** (D26). `enabled` y `tools[].enabled` dicen lo que los agentes pueden usar ahora; salen del puntero que solo escribe el provisioner.
- Máximo 10 packs habilitados o instalándose (**409 `too_many_packs`**). Máximo 10 escrituras por minuto por admin (429 con `Retry-After`).

| Método | Ruta | Acción | Cuerpo → respuesta |
|---|---|---|---|
| GET | `/api/mcp/catalog` | `ViewMcpCatalog` | → `Catálogo` |
| POST | `/api/mcp/{pack}/enablements` | `EnableMcp` | `{"version": int, "config": {clave: valor}, "reason": str\|null (hasta 500)}` → 201 `Catálogo`. Pack `available` o `disabled`. **409 `invalid_state`**, **409 `pending_exists`**, **409 `pack_unsupported`** (solo tools de lectura, en packs `public` o de datos de cuentas en modo `central_only`) |
| POST | `/api/mcp/{pack}/params` | `EnableMcp` | `{"version": int, "config": {…}}` → 201 `Catálogo`. Pack instalado en la versión de la release. **422 `no_change`**; **409 `update_required`** si la release trae otra versión |
| POST | `/api/mcp/{pack}/update` | `EnableMcp` | `{"version": int, "config": {…}\|null}` → 201 `Catálogo`. Pack instalado en una versión distinta de la de la release. Sin `config` conserva los parámetros en uso. **409 `up_to_date`**, **409 `identity_mode_changed`** (la versión nueva cambia el modo de identidad: hay que deshabilitar el pack y habilitarlo de nuevo) |
| POST | `/api/mcp/{pack}/enablements/{id}/approve` | `ApproveMcp` | `{}` → `Catálogo`. Aprueba cualquier solicitud (habilitar, parámetros o actualización) e inicia el provisioner. **409 `release_changed`** si la release ya no nombra la declaración que se pidió; **409 `version_conflict`** si el pack cambió desde la solicitud; **503 `provisioner_unavailable`**: si la instalación no tiene provisioner no se aprueba nada; si la ejecución no arranca, la aprobación queda registrada y se reintenta con `retry` |
| POST | `/api/mcp/{pack}/enablements/{id}/reject` | `ApproveMcp` | `{"reason": str\|null}` → `Catálogo`. El motivo es obligatorio para habilitar y actualizar (**422 `reason_required`**), opcional para parámetros |
| POST | `/api/mcp/{pack}/enablements/{id}/withdraw` | `EnableMcp` | `{}` → `Catálogo`. Solo quien la pidió (**403 `not_requester`**) |
| POST | `/api/mcp/{pack}/retry` | `EnableMcp` | `{"version": int}` → `Catálogo`. Un solo admin: reinicia una instalación `error` con la misma solicitud, versión y parámetros. **409 `invalid_state`** si no hay nada que reintentar, **409 `busy`** si hay una ejecución en curso, **409 `release_changed`** si la release ya nombra otra versión (pedir `update`) |
| DELETE | `/api/mcp/{pack}` | `EnableMcp` | `{"version": int, "reason": str (1..500)}` → `Catálogo`. Un solo admin. Pack `enabled` o `error`; pasa a `disabling` e inicia el provisioner, que borra políticas, target, Runtime y rol. Cancela la solicitud pendiente del pack. Repetirlo en `disabling` vuelve a iniciar el borrado. **409 `busy`** / **409 `invalid_state`** |

`{pack}`: id del pack (minúsculas, números y guiones; hasta 24). `{id}`: 32 caracteres hexadecimales.

`Catálogo`:

```json
{
  "max_enabled_packs": 10,
  "items": [{
    "id": "str", "kind": "connector|pack", "name": "str", "description": "str", "provider": "str",
    "data_tier": "public|account_data|write", "identity_mode": "service|per_user|central_only|per_user_adapter",
    "enabled": true,
    "permissions": ["acción IAM"],
    "tools": [{"ref": "<id>.<tool>", "name": "str", "description": "str", "access": "read|write",
               "audience": "all|central", "central_groups_only": false, "enabled": true}],
    "agents": [{"id": "str", "name": "str", "category": "str"}],
    "pack": null
  }]
}
```

- `agents`: agentes **publicados** que usan tools de ese servidor. Es la lista de afectados al deshabilitar: conservan el resto de sus tools y dejan de tener las del pack. Cada uno lo refleja en `Agent.unavailable_tools`.
- Las tools de un pack no traen descripción (`""`): el manifiesto firmado solo lleva nombre y tipo de acceso.
- `pack` (solo `kind: pack`):

```json
{
  "status": "available|pending|installing|enabled|error|disabling|disabled",
  "version": "1.1.1-1", "installed_version": "1.1.1-1|null", "lock_version": 0,
  "params": [{"key": "str", "description": "str|null", "allowed": ["…"], "default": "str", "value": "str|null"}],
  "update": {"version": "str", "added_tools": ["…"], "removed_tools": ["…"],
             "added_permissions": ["…"], "removed_permissions": ["…"]},
  "pending": {"change_id": "str", "kind": "enable|params|update", "pack_version": "str", "config": {},
              "reason": "str|null", "requested_by": "sub", "requested_by_email": "str|null",
              "created_at": "ISO8601", "expires_at": "ISO8601", "own": false},
  "last_rejected": {"change_id": "str", "kind": "str", "decided_by": "sub", "decided_by_email": "str|null",
                    "decided_at": "ISO8601", "reason": "str|null"},
  "status_at": "ISO8601|null", "failed_step": "str|null", "failure": "str|null",
  "requested_by": "sub|null", "requested_by_email": "str|null", "requested_at": "ISO8601|null",
  "approved_by": "sub|null", "approved_by_email": "str|null", "approved_at": "ISO8601|null",
  "disabled_by": "sub|null", "disabled_by_email": "str|null", "disabled_at": "ISO8601|null", "disable_reason": "str|null"
}
```

- `version` es la de la release; `installed_version`, la que sirve ahora. Con `status: error` e `installed_version` distinto de `null`, falló una actualización o un cambio de parámetros y **sigue activa la versión anterior**.
- `update` es `null` salvo que el pack esté instalado en una versión distinta de la de la release; dice qué cambia.
- `status: error` también cubre una aprobación cuya ejecución no arrancó (`failure: "not_started"`, a los 2 minutos) o se cortó (`"interrupted"`, cuando vence su bloqueo de 45 minutos). `failure` es un código del provisioner, nunca un mensaje de AWS.
- `pending.own`: quien llama hizo la solicitud; puede retirarla, no aprobarla ni rechazarla.
- **Solo para administradores:** `pending`, `last_rejected` y todos los campos desde `status_at`. Un creador recibe `null` en ellos.

**Errores propios de estas rutas:** 404 `not_found` (el pack no está en la release, o la solicitud no existe), 409 (`version_conflict`, `invalid_state`, `busy`, `pending_exists`, `pack_unsupported`, `too_many_packs`, `update_required`, `up_to_date`, `identity_mode_changed`, `release_changed`), 410 `expired`, 422 (`invalid_config` con `keys`, `no_change`, `reason_required`), 503 (`catalog_unavailable` si no se pueden leer los packs o su estado, `agents_unavailable`, `packs_unavailable`, `provisioner_unavailable`, `audit_unavailable`).

**Auditoría.** Toda escritura registra `requested` antes de escribir (503 `audit_unavailable` y no se escribe si falla) y `applied` o `rejected` al terminar. Eventos: `mcp.pack.request.proposed`, `mcp.pack.request.approved`, `mcp.pack.request.rejected`, `mcp.pack.request.withdrawn`, `mcp.pack.retried` y `mcp.pack.disable.requested`. Llevan `pack`, `change_id`, `kind`, `pack_version`, `statement_sha256`, `config`, los `sub` implicados (`requested_by`, `approved_by`, `rejected_by`, `disabled_by`), `enablement_id` y el motivo. El provisioner escribe después `mcp.pack.enabled` y `mcp.pack.disabled` con el mismo `resource` (`mcp_pack`).

**Agentes y packs.** Una tool de pack se referencia como `<pack>.<tool>` y solo pasa las reglas de envío mientras el pack la sirve (`tool_not_enabled`). El provisioner de agentes la acepta con el target del Gateway igual al id del pack.

### Modelos: Brains (Marketplace v1, B5)

Catálogo de modelos administrable (spec §4.5, D38). Un solo admin habilita o deshabilita un modelo y confirma sus precios; no hay doble aprobación. Las tres rutas usan la acción Cedar `ManageModels` sobre `Mango::Platform` (solo admins) y además comprueban `is_admin` en proceso. La decisión se audita; el GET cuenta como lectura.

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| GET | `/api/admin/models` | → `{"version": int, "region": str, "refreshed_at": ISO8601\|null, "items": [Modelo]}`. `refreshed_at` es `null` hasta la primera consulta a Bedrock |
| PUT | `/api/admin/models/{model_id}` | Habilitar o cambiar precios: `{"version": int, "enabled": true, "input_usd": str, "output_usd": str}`. Deshabilitar: `{"version": int, "enabled": false, "reason": str\|null (hasta 500)}`. → el mismo GET |
| POST | `/api/admin/models/refresh` | `{}` → el mismo GET. Consulta Bedrock (`ListFoundationModels` y `ListInferenceProfiles`). Máximo 5 por minuto por admin (429 con `Retry-After`) |

**Modelo:** `{"id": str, "name": str, "provider": str, "status": "enabled"\|"available"\|"disabled"\|"noaccess", "is_default": bool, "supports_tools": bool, "supports_vision": bool, "context_tokens": int\|null, "input_usd": str\|null, "output_usd": str\|null, "list_input_usd": str\|null, "list_output_usd": str\|null, "confirmed_by": str\|null, "confirmed_at": ISO8601\|null, "disabled_by": str\|null, "disabled_at": ISO8601\|null, "disabled_reason": str\|null, "agents": [{"id": str, "name": str, "category": str}]}`.

- **`id`:** id del perfil de inferencia de Bedrock, `^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$`.
- **`status`:** `noaccess` si Bedrock no listó el modelo en la última consulta; `enabled` si está habilitado; `disabled` si un admin lo deshabilitó; `available` en el resto de casos.
- **Precios:** USD por millón de tokens, como string decimal mayor que 0, hasta 100000 y con cuatro decimales como máximo. `input_usd` y `output_usd` son `null` mientras el modelo no tenga precio. `list_*` es el precio de la configuración de la instalación (`modelPrices`), o `null` si no lo tiene.
- **`is_default`:** el modelo del agente de la release. No se puede deshabilitar.
- **`confirmed_by` y `disabled_by`:** correo del admin (o su `sub` si el token no trae correo). Solo los ven admins.
- **`agents`:** agentes publicados que pueden usar el modelo (su modelo por defecto o uno de sus modelos permitidos). El agente de la release es uno más: se siembra publicado (D34).
- **`supports_tools` y `context_tokens`:** capacidades de la release (`models/capabilities.json`, por id de modelo base). `context_tokens` es `null` si la release no lo conoce.

**Errores propios:**
- 404 `not_found`: el modelo no está en el catálogo.
- 409 `version_conflict`: el catálogo cambió; recargar y reintentar. También es condición de la escritura en DynamoDB.
- 409 `model_no_access`: habilitar un modelo `noaccess`.
- 409 `model_not_enabled`: deshabilitar un modelo que no está habilitado.
- 409 `default_model`: deshabilitar el modelo por defecto.
- 422 `invalid_request`: precios fuera de rango, precios al deshabilitar, motivo al habilitar o campos desconocidos.
- 502 `bedrock_unavailable`: Bedrock no respondió; el catálogo no cambia.
- 503 `capabilities_unavailable`: el archivo de capacidades de la release no se pudo leer; `refresh` no cambia nada.
- 503 `models_unavailable` (catálogo ilegible), `agents_unavailable` (no se pudo leer qué agentes usan cada modelo) o `audit_unavailable` (no se escribe nada).

**Consulta a Bedrock (`refresh`).** Solo lista: no invoca modelos ni guarda credenciales.
- Entran los perfiles de inferencia del sistema en estado `ACTIVE` que apuntan a un modelo con salida de texto de la región.
- Los modelos ya conocidos conservan su estado y sus precios. Se actualizan nombre, proveedor y visión, y se marca si Bedrock los listó.
- Bedrock no informa si un modelo admite tools ni su tamaño de contexto: salen de `models/capabilities.json`, que va dentro de la imagen. Un modelo listado ahí toma esas capacidades en cada consulta; uno que no está conserva las que tenía.
- Un modelo nuevo entra **deshabilitado** y sin precio, salvo que la configuración de la instalación tenga uno. Si la release no lo conoce, entra sin uso de tools (fail-closed) y sin tamaño de contexto.
- El catálogo guarda como máximo 100 modelos.

**Precios de caché.** La pantalla solo pide entrada y salida. Al cambiar precios, los de lectura y escritura de caché conservan su proporción con el precio de entrada. Si el modelo no tenía precio, valen lo mismo que la entrada.

**Auditoría.** Mismo patrón que Admin v0 (`requested` → `applied` o `rejected`, fail-closed). Eventos: `settings.model.enabled` y `settings.model.price_updated` (`model`, `before`, `after`), `settings.model.disabled` (`model`, `reason`, `affected_agents`, `affected_agent_count`) y `settings.models.refreshed` (`added`, `missing` y sus conteos). El recurso normalizado es `{type: "model", id}`.

**Datos.** Ítem `MODELS` / `CATALOG` de la tabla `Settings`: `models` (JSON), `version`, `updated_by`, `updated_at` y `refreshed_at`. `GET /api/models` (Agent Builder) sigue devolviendo solo los modelos habilitados.

### Directorio: personas con las que se comparte un agente (D33)

`POST /api/directory/users/resolve`. Una versión de agente guarda identificadores de usuario (`sub`), no correos. Quien puede crear agentes pasa de correos a identificadores para agregar personas en el Builder, y de identificadores a correos para leer una versión (Builder y Revisión).

Responde si un correo está en el directorio: es una **excepción acordada el 2026-10-02** a «Sin revelar si un usuario existe», solo para creadores de agentes y admins (`AGENTS.md`; `marketplace-v1-threat-model.md`, TM-M24). En login, registro y recuperación la regla no cambia.

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| POST | `/api/directory/users/resolve` | `{"emails": [str] (0..20), "ids": [str] (0..50)}`, al menos uno de los dos → `{"users": [{"id": str, "email": str}], "emails_not_found": [str], "ids_not_found": [str]}`. Los correos se normalizan (sin espacios, en minúsculas) y se devuelven así. **429 `rate_limited`** con `Retry-After`, **502 `upstream_error`** si Cognito no responde, **503 `audit_unavailable`** |

- **Autorización:** acción `CreateAgent` sobre la plataforma (lectura), más la comprobación del grupo `mango-agent-creator` o admin. Va por `POST` para que los correos no viajen en la URL.
- **Límites por usuario,** todos compartidos por las tareas de `mango-api` (D70): 30 correos por minuto y 300 identificadores por minuto (tabla `RateLimits`) y **200 correos por día UTC** (contador `DIRECTORY_LOOKUPS` / `<sub>#<día>` en la tabla `Settings`). Una llamada frenada no consulta nada.
- **Directorio:** un correo se busca con `AdminGetUser` y un identificador con `ListUsers` (filtro por `sub`), solo en el User Pool de la instalación. Un usuario sin confirmar o deshabilitado responde como no encontrado por correo. Los usuarios federados (SSO) no se encuentran por correo.
- **Auditoría (fail-closed):** evento `directory.lookup` con `emails`, `ids`, `emails_found`, `ids_found`, `found_users` (identificadores encontrados por correo) y `outcome: applied`. Nunca lleva los correos consultados. Una llamada frenada por el límite se audita con `outcome: rejected` y `error: rate_limited`.

### Tools de escritura con aprobación (D27)

Ninguna tool de escritura se ejecuta sin que una persona la confirme. Cuando un agente llama una, el Gateway la rechaza (no trae approval token) y `mango-api` crea una **solicitud** con los argumentos tal como los pidió el modelo, el tramo calculado con esos argumentos y la política de la tool, y un vencimiento. Por debajo del umbral confirma quien la pidió; por encima firman N personas distintas de quien la pidió. Después la ejecuta **quien la pidió, con su sesión**: `mango-api` llama al Gateway con los argumentos guardados y un token firmado con KMS, de un solo uso y ligado a `hash(tool, args)`. Modelo de amenazas: `docs/security/threat-models/write-tools-approval-threat-model.md`.

Acciones de Verified Permissions: `ViewApprovals` (cualquier usuario con sesión; qué ve cada uno lo decide `mango-api` por objeto), `ApproveToolCall` (admins y FinOps central), `ProposeToolPolicy` y `ApproveToolPolicy` (admins). Confirmar, cancelar y ejecutar son solo de quien pidió; ejecutar vuelve a decidir `UseAgent` sobre el agente. Quien no puede ver una solicitud recibe 404.

`Approval`:

```json
{
  "approval_id": "32 hex", "status": "pending | approved | executing | executed | failed | rejected | cancelled | expired",
  "tier": "self | approvers", "tool": "<conector>.<tool>", "server_name": "str",
  "description": "qué hace la tool según el manifiesto de la release (nunca el texto del modelo)",
  "agent_id": "str", "agent_name": "str | null",
  "arguments": {"…": "los argumentos guardados, que son los que se ejecutan"},
  "rule": {"condition": "always | amount | count | environment", "reason": "always | above | below | unknown",
           "amount_usd": "str | null", "count": "int | null", "environment": "str | null",
           "approvers": 1, "expires_hours": 24},
  "approvals_needed": 1, "signatures": [{"user_id": "str", "email": "str | null", "at": "ISO", "note": "str | null"}],
  "requested_by": "str", "requested_by_email": "str | null", "created_at": "ISO", "expires_at": "ISO",
  "decided_by": "str | null", "decided_by_email": "str | null", "decided_at": "ISO | null", "note": "str | null",
  "error": "código corto | null", "conversation_id": "solo para quien pidió | null",
  "mine": true, "can_sign": false
}
```

- `rule` es la política **con la que nació** la solicitud: un cambio posterior de política no la toca. `reason: "unknown"` significa que el dato del umbral faltaba o no se pudo interpretar: aplica el tramo de aprobadores (fail-closed).
- `expired` lo calcula la API al leer: una solicitud `pending` o `approved` pasada de `expires_at`.
- `mine` y `can_sign` son ayudas para la interfaz; la API autoriza cada decisión por su cuenta.

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| GET | `/api/approvals?view=pending\|resolved` | → `{"items": [Approval], "can_decide": bool}`. Quien puede aprobar ve las solicitudes del tramo de aprobadores; el resto, solo las suyas |
| GET | `/api/approvals?conversation_id=<id>` | → las solicitudes **propias** de esa conversación (ambos tramos) |
| GET | `/api/approvals/{id}` | → `Approval` |
| POST | `/api/approvals/{id}/confirm` | `{}` → `Approval`. Solo quien pidió y solo tramo `self`: confirma y ejecuta. **409 `tool_unavailable`** si el agente ya no tiene la tool; **410 `expired`**; **503 `execution_unavailable`** si la instalación no tiene la llave de firma |
| POST | `/api/approvals/{id}/cancel` | `{}` → `Approval`. Solo quien pidió, mientras no se haya ejecutado |
| POST | `/api/approvals/{id}/approve` | `{"note": str\|null}` → `Approval`. **403 `own_request`** si firma quien pidió; **409 `already_signed`**; **410 `expired`**. Con la última firma pasa a `approved`; no ejecuta nada |
| POST | `/api/approvals/{id}/reject` | `{"reason": str (1..500)}` → `Approval`. **403 `own_request`** |
| POST | `/api/approvals/{id}/execute` | `{}` → `Approval`. Solo quien pidió, con la solicitud `approved` y sin vencer. Una llamada rechazada antes de llegar a la tool la deja en `approved` con `error` (se puede reintentar); si la tool pudo haber corrido, queda `failed` y no se reintenta |
| GET | `/api/approvals/policies` | → `{"tools": [{"tool", "server_name", "description", "conditions": [...], "policy": Rule, "version": int, "pending_change_id": str\|null}], "changes": [...]}`. `changes` (últimos 30 días) solo para admins |
| POST | `/api/approvals/policies/{tool}/changes` | `{"base_version": int, "condition", "amount_usd"?, "count"?, "environment"?, "approvers": 1..3, "expires_hours": 1\|4\|24\|48\|72, "reason": str}` → 201 `{"change_id"}`. **422 `condition_unsupported`** (la tool no informa ese dato), **422 `no_change`**, **409 `already_pending`**, **409 `version_conflict`** |
| POST | `/api/approvals/policies/changes/{id}/approve` | `{}` → el GET. **403 `same_approver`**; **410 `expired`** (7 días) |
| POST | `/api/approvals/policies/changes/{id}/reject` | `{"reason": str}` → el GET |
| POST | `/api/approvals/policies/changes/{id}/withdraw` | `{}` → el GET. Solo quien propuso |

Sin política guardada, una tool usa «Siempre · 1 aprobador · 24 h». Qué argumento es el monto, la cantidad o el entorno lo declara el manifiesto del conector (`tools[].approval`), no la llamada.

Auditoría (con `args_hash`, nunca los argumentos): `approval.request`, `approval.self_confirm`, `approval.self_cancel`, `approval.cancel`, `approval.approve`, `approval.reject`, `approval.expire`, `approval.execute`, `approval.execute_failed` y `approval.policy.propose|approve|reject|withdraw`. Las decisiones siguen la auditoría fail-closed de Admin v0 (`requested` antes de escribir).

Límites: 3 solicitudes por turno, 20 abiertas por persona, argumentos de hasta 8 KB.

### Restablecer MFA de un usuario (D20)

Todas requieren `is_admin` y su acción de Verified Permissions: `ViewAdmin` (lectura), `ProposeMfaReset` (proponer y retirar) y `ApproveMfaReset` (aprobar y rechazar). Auditoría fail-closed como en Admin v0 (`outcome: requested` antes de escribir o llamar a Cognito; 503 `audit_unavailable` si no se puede registrar). Eventos: `account.mfa_reset_propose`, `account.mfa_reset_approve`, `account.mfa_reset_reject`, `account.mfa_reset_withdraw` y, al aplicarse, `account.mfa_reset` (con `target_user`, `sessions_revoked: true`). Un intento no permitido (el propio MFA, aprobar la propia propuesta) se rechaza y se audita con `outcome: rejected`.

Al aprobarse, `mango-api` llama `AdminDeleteSoftwareToken` (borra el TOTP registrado; si no hay, sigue) y `AdminUserGlobalSignOut` sobre el User Pool de la instalación: el siguiente ingreso del usuario cae en el alta de MFA. Los access tokens ya emitidos siguen válidos hasta vencer (≤ 60 min). Las solicitudes vencen a las **72 h**; hay **una abierta por usuario**, un **enfriamiento de 24 h** después de un restablecimiento, **5 propuestas por hora** por admin (en proceso) y como máximo 10 pendientes.

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| GET | `/api/admin/mfa-resets` | → `{"items": [{"change_id": str, "status": "pending"\|"approved"\|"rejected"\|"withdrawn"\|"expired", "target_user": str, "target_email": str\|null, "proposed_by": str, "proposed_by_email": str\|null, "reason": str, "identity_verified": bool, "created_at", "expires_at", "decided_by": str\|null, "decided_by_email": str\|null, "decided_at": str\|null, "note": str\|null}]}` (últimos 30 días) |
| POST | `/api/admin/mfa-resets` | `{"email": str, "reason": str (1..500), "identity_verified": true}` → 201. `identity_verified` es la declaración de quien propone de que verificó la identidad del usuario por otro canal (llamada, videollamada o en persona; D20): solo se acepta el booleano JSON `true` (422 si falta, es `false`, `1` o `"true"`), y se guarda en la solicitud y en los eventos de auditoría `{"change_id": str}`. El correo solo sirve para buscar al usuario (`AdminGetUser`); después se usa su `sub`. **404 `user_not_found`**, **422 `federated_user`** (el MFA lo gestiona su IdP), **403 `self_reset`**, **409 `already_pending`**, **409 `too_many_pending`**, **429 `rate_limited`** (más de 5 solicitudes por hora de quien propone; o el MFA de esa persona se restableció hace menos de 24 h. Los dos con `Retry-After`: en el segundo, lo que falta de esas 24 h) |
| POST | `/api/admin/mfa-resets/{change_id}/approve` | `{}` → el GET. **403 `same_approver`** si aprueba quien lo propuso; **403 `self_reset`** si es sobre el propio aprobador; **410 `expired`**; **409 `version_conflict`** si ya se decidió; **502 `upstream_error`** si Cognito falla (la solicitud sigue pendiente) |
| POST | `/api/admin/mfa-resets/{change_id}/reject` | `{"reason": str (1..500)}` → el GET. Otro admin distinto del proponente y del afectado (`same_approver`, `self_reset`) |
| POST | `/api/admin/mfa-resets/{change_id}/withdraw` | `{}` → el GET. Solo el proponente (403 si no) |

### Personas e instalación (D60)

Ajustes › Personas: el directorio, los grupos de cada persona, invitaciones y acceso. Modelo de amenazas: `docs/security/threat-models/people-management-threat-model.md`. Todas las rutas requieren `is_admin` y su acción de Verified Permissions: `ViewPeople` (lecturas), `ManagePeople` (cambios, invitaciones y retirar) y `ApprovePeopleChange` (aprobar y rechazar). Listar el directorio a administradores es una excepción acordada a «sin revelar si un usuario existe» (`AGENTS.md`, 2026-10-03).

Qué exige un segundo administrador lo decide el servidor: dar o quitar `mango-admin` o `finops-central`, deshabilitar a un administrador y rehabilitar a quien tiene uno de esos dos grupos. Lo demás se aplica al momento. Reglas: nadie decide un cambio de ese tipo sobre su propia cuenta, ni se quita él solo un grupo sensible, ni se deshabilita; nunca quedan menos de dos administradores habilitados; mientras quien llama sea el único administrador habilitado, nombrar al segundo se aplica sin aprobador (`result: "bootstrap"`). Al quitar un grupo sensible o deshabilitar se revocan los refresh tokens; el access token vigente dura hasta 60 minutos. Por eso toda ruta que cambia algo comprueba además en el directorio que quien llama **sigue siendo** un administrador habilitado (403 `forbidden` si no), y los cambios que tocan quién es administrador se aplican de uno en uno (**409 `busy`** si hay otro en curso, también al aprobar: basta reintentar en unos segundos; `version_conflict` queda para lo que ya cambió: un cambio ya decidido o, en el arranque, los administradores que ya no son los que se leyeron).

Auditoría fail-closed. Eventos: `directory.list` (solo conteos: nunca correos ni el prefijo buscado; también al leer la lista de cambios, con `scope: "changes"`), `directory.invite`, `directory.group_add`, `directory.group_remove`, `directory.disable`, `directory.enable`, `directory.member_propose`, `directory.member_approve`, `directory.member_reject`, `directory.member_withdraw`. El evento aplicado tras una aprobación lleva `change_id`, `proposed_by` y `approved_by`; el del arranque, `bootstrap: true`.

Límites por administrador: 120 lecturas por minuto, 200 cambios, 20 propuestas y 20 invitaciones por hora; 20 cambios pendientes a la vez. Los cuatro límites de tasa se cuentan una vez entre todas las tareas de `mango-api` (D70).

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| POST | `/api/admin/people/search` | `{"prefix"?: str (inicio del correo, 1..64, sin comillas ni espacios), "filter"?: "all"\|"pending"\|"invited"\|"disabled", "cursor"?: str}` → `{"items": [{"user_id": str, "email": str, "status": "active"\|"invited"\|"disabled", "mfa": bool, "groups": [str], "created_at": str}] (20 por página), "next_cursor": str\|null, "pending": int, "admins": int, "with_access": int, "incomplete": bool}`. Primero quien espera acceso (activa y sin grupos), luego por alta descendente. Las cuentas sin correo verificado no aparecen. Es POST para que el prefijo no viaje en la URL |
| POST | `/api/admin/people/invitations` | `{"email": str, "groups"?: [str] (0..10)}` → 201 `{"user_id": str, "result": "applied"\|"bootstrap"}`. Cognito envía la contraseña temporal. **422 `invalid_email`**, **`public_domain`** (se acepta cualquier dominio que no sea de un proveedor de correo público, D61; qué es público lo dice la lista única de `mango_core.mail_domains`, con variantes por país y correos desechables, D62: lo decide la API, no la pantalla; el registro abierto sigue limitado a `SignUpDomains`), **`sensitive_group`**, **`unknown_group`**; **409 `already_exists`** |
| POST | `/api/admin/people/{user_id}/groups` | `{"group": str, "reason"?: str (1..500)}` → `{"result": "applied"\|"proposed"\|"bootstrap", "change_id": str\|null}`. **422 `unknown_group`** (solo los cuatro de sistema y los del registro), **`reason_required`**; **409 `already_member`**, **`user_disabled`**, **`already_pending`**, **`too_many_pending`**; **403 `self_change`**; **404 `user_not_found`** |
| POST | `/api/admin/people/{user_id}/groups/remove` | Igual. **409 `not_member`**, **`last_admins`** |
| POST | `/api/admin/people/{user_id}/disable` | `{"reason": str}` → igual. **409 `already_disabled`**, **`last_admins`**; **403 `self_change`** |
| POST | `/api/admin/people/{user_id}/enable` | `{"reason"?: str}` → igual. **409 `already_enabled`**; **422 `reason_required`** si exige aprobación |
| GET | `/api/admin/people/changes` | → `{"items": [{"change_id": str, "kind": "add"\|"remove"\|"disable"\|"enable", "group": str\|null, "status": "pending"\|"approved"\|"rejected"\|"withdrawn"\|"expired", "target_user": str, "target_email": str, "proposed_by": str, "proposed_by_email": str\|null, "reason": str, "created_at", "expires_at", "decided_by": str\|null, "decided_by_email": str\|null, "decided_at": str\|null, "note": str\|null, "target_in_directory": bool\|null}]}` (últimos 30 días; vencen a las 72 h). `target_in_directory` dice si la persona del cambio sigue en el directorio (`false`: «Ya no está en el directorio»; el correo se conserva porque es historial); `null` si no se sabe (el directorio no se pudo leer, o no cabe en una lectura y se agotaron las 20 consultas de esa lectura). Cuenta como lectura del directorio (D66): mismo límite de 120 por minuto (**429 `rate_limited`**) y evento `directory.list` con `scope: "changes"`, `returned` y `missing` (**503 `audit_unavailable`** si no se pudo auditar). La misma lista como respuesta de una decisión no gasta lectura |
| POST | `/api/admin/people/changes/{change_id}/approve` | `{}` → el GET. Se vuelven a comprobar todas las reglas antes de aplicar. **403 `same_approver`**, **`self_change`**; **410 `expired`**; **409 `version_conflict`** si el cambio ya se decidió (o se está decidiendo); **409 `busy`** si otro cambio de administradores se está aplicando en ese momento (el cambio sigue pendiente: basta reintentar en unos segundos); **409** con el código de la regla que ya no se cumple; **502 `upstream_error`** (el cambio sigue pendiente) |
| POST | `/api/admin/people/changes/{change_id}/reject` | `{"reason": str}` → el GET |
| POST | `/api/admin/people/changes/{change_id}/withdraw` | `{}` → el GET. Solo quien lo propuso |
| GET | `/api/admin/installation` | (`ViewAdmin`) → `{"name": str, "version": str\|null, "release": str\|null` (etiqueta de la release instalada, `v0.1.0-g<commit>`)`, "organization_id": str\|null, "management_account_id": str\|null, "alerts_emails": [str], "sign_up_domains": [str], "first_admins": [str]}`. Solo lectura; no va en el `config.json` público |

Errores: `{"error": {"code": str, "message": str}}` con el status HTTP correspondiente:
- 401 si no hay token o es inválido;
- 403 si el usuario no tiene permiso; 403 `no_group` si el token es válido pero el usuario aún no tiene grupo (D20);
- 402 `budget_exceeded` si se agotó el presupuesto;
- 409 `conversation_busy` si otro mensaje de la misma conversación se está respondiendo (D39); el cliente puede reintentar;
- 503 `budget_unavailable` si la reserva no se pudo registrar por contención de escrituras (reintentable);
- 422 si la entrada es inválida;
- 409 `version_conflict` o `too_many_pending`, 410 `expired` y 429 `rate_limited` en las rutas de admin. Todo 429 lleva `Retry-After` en segundos enteros (≥ 1): lo que falta para que salga de su ventana la llamada más antigua, o de la espera que la ruta indique;
- 503 `audit_unavailable` en las escrituras de admin si no se pudo registrar la auditoría (no se escribió nada; reintentable);
- 502 `upstream_error` si falla el chequeo contra la payer (organización o conectividad), sin detalle;
- en admin, 422 `invalid_request` también para una propuesta que no cambia el mapeo.

Notas de admin: `reject` es la decisión de otro admin y `withdraw` el retiro por quien propuso; ninguno toca el mapeo. Quien no es el proponente no puede rechazar cambios que tocan su propia área (`self_edit`). **Cambio del 2026-09-30:** antes el proponente retiraba con `reject` (motivo obligatorio y permiso `ApproveBusinessUnits`), auditado como `settings.bu_mapping.rejected` con `withdrawn: true`; ese camino ahora responde 403 `use_withdraw`. Los eventos viejos conservan esa forma y la web los sigue mostrando como "retirado". Las OUs se validan contra la organización al proponer. El límite de 5 por minuto y las cachés viven en cada tarea de `mango-api` (con N tareas, el límite efectivo es N×5).

## Audit log

`GET /api/admin/audit`: eventos del índice (30 días), del más reciente al más antiguo. Parámetros de query (cualquier otro → 422):

| Parámetro | Valor |
|---|---|
| `limit` | 1..200 (por defecto 50) |
| `cursor` | `next_cursor` de la página anterior (opaco) |
| `since`, `until` | ISO 8601; rango `[since, until)` aplicado en el servidor. Sin zona = UTC. Se recorta a la vida del índice |
| `exclude` | `reads`: oculta las `policy.decision` **permitidas** de solo lectura (`ViewAdmin`, `ViewAudit` y las lecturas marcadas `read_only`, como `GET /api/agents/{id}`). También oculta las lecturas del directorio (`directory.list`, D62) y las sesiones recuperadas (`session.renewed`, D64). Se siguen auditando; solo se filtran. Las denegaciones nunca se ocultan |
| `event` | Nombre exacto (`agent.invoke`) o prefijo terminado en punto (`settings.`) |

Respuesta:

```json
{
  "items": [{
    "event_id": "32 hex",
    "ts": "2026-09-30T12:00:00.000+00:00",
    "event": "settings.bu_mapping.withdrawn",
    "user_id": "<sub>",
    "actor_email": "str | null",
    "actor_role": "finops-central | bu-lead | null",
    "actor_is_admin": "bool | null",
    "resource": {"type": "bu_change", "id": "…"},
    "detail": {},
    "hash": "sha256 hex"
  }],
  "next_cursor": "str | null"
}
```

- `actor_email`, `actor_role` y `actor_is_admin` salen del access token verificado **al emitir** (sin consultas a Cognito). El correo es solo para mostrar. Los eventos anteriores no los tienen (`null`).
- **Eventos de sesión (D63, D64):** `session.started` (`federated`, `expires_at`), `session.renewed`, `session.rejected` (`reason`: `invalid_refresh_token` o `sub_mismatch`) y `session.ended`. El `reason` de `session.ended` es uno de:

  | `reason` | Cuándo |
  |---|---|
  | `sign_out` | La persona cerró sesión |
  | `expired` | Pasó la duración máxima de la sesión |
  | `disabled` | Un administrador deshabilitó a la persona |
  | `group_removed` | Se le quitó un grupo sensible |
  | `mfa_reset` | Se restableció su MFA |
  | `revoked` | La marca de revocación no dice la causa (marcas escritas antes del 2026-10-04, que viven dos días) |
  | `rejected` | Cognito rechazó renovar y `mango-api` no tiene una marca que cubra esa sesión: Cognito no dice por qué (token revocado o vencido allí, persona deshabilitada fuera de Mango, cookie alterada) |

  Si dos cambios cierran las sesiones de la misma persona antes de que su navegador vuelva a renovar, el evento nombra el más reciente. `session.ended` se emite sin token a la vista (la sesión venció, se revocó o se cerró solo con la cookie): su `actor_email`, `actor_role` y `actor_is_admin` son los del **ingreso**, guardados en el registro de la sesión. Una persona sin grupo no los tiene en ningún evento de sesión, y las sesiones iniciadas antes de este cambio tampoco en su cierre.
- `resource` se normaliza al escribir: `budget_defaults`, `user_budget`, `bu_change`, `conversation`, `agent`, `user`, `change` o el tipo Cedar (`Mango::Platform`) en `policy.decision`. Los eventos anteriores no lo tienen.
- `hash` es el SHA-256 del evento sin el campo `hash` (JSON canónico). No es una cadena: la verificación de integridad encadenada del diseño sigue pendiente.
- `next_cursor` es `null` cuando no hay más. Con filtros, una página puede traer menos de `limit` (o ninguno) y aun así tener `next_cursor`: el servidor examina como máximo 2000 eventos por request. El servidor no sabe cuántos quedan.
- `policy.decision` incluye `read_only` desde esta versión.
- **Autorización por turno del chat.** La `policy.decision` de `UseAgent` que emite `POST /api/chat` lleva `conversation_id` y `turn` (los del turno que autoriza; en una conversación nueva, el id que se le asignará). Se emite **siempre**, antes de reservar budget, también si se deniega o si el turno falla después (auditoría fail-closed, regla 4). `agent.completed` lleva los mismos `conversation_id`/`turn` y `authz: {"action": "UseAgent", "allowed": true}` (solo los turnos permitidos llegan a completarse). La web muestra la decisión permitida dentro de la «Consulta del agente» de su turno cuando esta está cargada; si no (turno fallido o en otra página), como fila propia. Las denegadas siempre son filas («Acceso denegado»). Los eventos anteriores no tienen `turn` ni `authz`.

## `POST /api/chat`: Server-Sent Events

`Content-Type: text/event-stream`. El cliente usa `fetch` con `ReadableStream`, porque `EventSource` no soporta POST ni headers. Eventos, en orden:

```
event: conversation
data: {"conversation_id": "01J..."}

event: status
data: {"phase": "thinking" | "tool" | "tool_result" | "writing", "tool"?: "get_cost_and_usage"}

event: tool
data: {"name": "get_cost_and_usage", "status": "started" | "completed" | "error"}

event: delta
data: {"text": "..."}

event: approval
data: { …Approval… }

event: done
data: {"message_id": "01J...", "stop_reason": "end_turn", "usage": {"input_tokens": 1234, "output_tokens": 321}, "cost_usd": "0.0123"}

event: error
data: {"code": "budget_exceeded" | "upstream_error" | ..., "message": "..."}
```

- Llegan heartbeats como comentarios SSE (`: ping`) cada 15 s; se ignoran.
- `done.stop_reason` es el motivo de fin que informa el harness. `max_tokens`: la respuesta se cortó en el tope de tokens de la llamada (D74); el mensaje guardado es el texto hasta el corte y el turno termina con `done`, no con `error`. `guardrail_intervened`: la cortó el guardrail.
- `approval` (D27): el agente llamó una tool de escritura. El Gateway no la ejecutó; el evento trae la solicitud que la interfaz muestra como tarjeta («¿Ejecutar esta acción?» o «Requiere aprobación»). El mensaje del asistente guarda sus ids (`messages[].approvals`) y `GET /api/conversations/{id}` devuelve las solicitudes en `approvals`.
- **`status`: progreso en vivo del turno.** Lo calcula `mango-api` a partir del stream del harness; **nunca lleva texto del modelo** (ni respuesta ni razonamiento), así que no depende del guardrail (D39). Se envía solo cuando la fase cambia, varias veces por turno:
  - `thinking`: el turno ya corre y el modelo trabaja. Es el primer evento después de `conversation`, antes de llamar al harness: con el guardrail síncrono el harness no entrega nada hasta que hay un bloque revisado o una llamada a una tool.
  - `tool`: hay una llamada a una tool en curso. `tool` es su nombre visible, el mismo del evento `tool` (64 caracteres como máximo), y solo se envía si es una tool de la versión publicada del agente; si no, la fase llega sin nombre. Solo esta fase lo lleva.
  - `tool_result`: todas las llamadas en curso respondieron y el modelo trabaja con los resultados.
  - `writing`: llega texto ya revisado; va justo antes del primer `delta` de cada tramo de texto.

  Es transitorio: no se guarda con el mensaje ni se audita (las tools siguen en `tool`, en el mensaje y en `agent.completed`). No hay `status` final: el turno termina con `done` o `error`. Un cliente debe ignorar una fase que no conozca (pueden añadirse) y un cliente anterior ignora el evento entero.
- El razonamiento del modelo (`reasoningContent`) **no se reenvía nunca**: el guardrail no lo revisa.
- `delta.text` es **markdown producido por el LLM** y es **no confiable**. Se renderiza sin HTML crudo, con enlaces externos deshabilitados o con confirmación y sin imágenes remotas.
