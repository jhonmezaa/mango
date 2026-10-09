# Runbook: operar y probar una instalación (laboratorio)

> **Obsoleto en parte (2026-10-05).** Este runbook nació para una PoC que se desplegaba con `cdk deploy`, que ya no existe (D58 (6)). El runbook vigente es [`install.md`](install.md). De aquí solo sirven las secciones de operación y de pruebas de punta a punta; cualquier paso que hable de `cdk deploy`, de CDK bootstrap o de `infra/config/<env>.json` no se puede ejecutar tal cual.
>
> **Instalar, actualizar y desinstalar ya no se explica aquí:** está en [`install.md`](install.md). Desde D58 el laboratorio se instala como un cliente, con `CreateStack`/`UpdateStack` sobre las plantillas de una versión publicada. No hay `cdk deploy` de desarrollo ni CDK bootstrap.
>
> Este documento conserva la operación y las pruebas de punta a punta del laboratorio. Donde una sección diga «desplegar `Core`», léase `UpdateStack` de `Core` a una versión publicada (`install.md`, paso 4).
>
> **Secciones escritas antes de D58.** Las que nombran `infra/config/<env>.json` describen el modelo anterior: hoy cada valor de la instalación es un parámetro de stack (`install.md`, paso 2), un valor por defecto de la release (`release-defaults.json`) o configuración de la aplicación. `tests/e2e/member_access.py` es la excepción: sigue leyendo un archivo local con esa forma (`infra/config/example.json`), fuera de git.

## Prerrequisitos

- **Herramientas:** `mise install` en la raíz instala Python 3.13, Node 24, uv y pnpm. Docker solo hace falta para construir packs o una versión (`mise run pack`, `mise run dist`).
- **Perfiles de AWS CLI con IAM Identity Center:**
  - `mango-sandbox`: cuenta donde se instala Mango.
  - `mango-mgmt`: management/payer.
  - Si expiran: `aws sso login --profile <perfil>`.
- **Una instalación:** hecha según `install.md`.
- **Organización:** Cost Explorer habilitado y modelos de Anthropic habilitados en Bedrock en la cuenta Mango.

## Comprobaciones locales

```bash
mise run install                      # dependencias Python y TypeScript
mise run lint && mise run typecheck && mise run test
mise run synth                        # plantillas sin publicar: sirven para las comprobaciones, no para instalar
```

## Admin v0 (D17): valores iniciales

- `budgets` y `businessUnits` de la configuración de IaC son **solo valores iniciales**. El despliegue los siembra en la tabla `Mango-<ns>-Settings` con `attribute_not_exists(PK)`: solo se escriben si el ítem no existe.
- Después, la tabla manda. Cambiar esos valores en `infra/config/<env>.json` y redesplegar **no** pisa lo editado en la app. Los cambios se hacen desde las pantallas de admin (presupuestos directos; mapeo área↔OU con doble aprobación).
- Para volver a sembrar (solo laboratorio): borrar el ítem (`BUDGETS/DEFAULTS` o `BU_MAPPING/CURRENT`) y redesplegar Core.
- El conector ya no usa la variable `BUSINESS_UNITS`: lee el mapeo de la tabla (caché ≤ 5 min). Si el ítem falta o es inválido, los `bu-lead` no ven cuentas (fail-closed).
- El Lambda `Mango-<ns>-AdminProbe` usa el broker existente; la plantilla Payer no cambia.

## Agentes de la release (D34) y migración de FinOps (Marketplace v1, A5)

FinOps ya no es un recurso de CDK: es un agente más de la tabla `Mango-<ns>-Agents`.

- El despliegue lo **siembra** (put-if-absent) como versión 1 ya aprobada por la release (`approved_by: release@<versión>`), desde `agents/finops/agent.json` más el modelo de la configuración (`models.agent`).
- En el mismo despliegue el stack **inicia el provisioner**, que crea el rol `Mango-<ns>-agent-finops`, el harness `Mango_<ns>_a_finops` y su endpoint `live`. Tarda menos de un minuto.
- Después la tabla manda: cambiar `agent.json` y redesplegar **no** cambia el agente ya sembrado. Los cambios se hacen en la app (Agent Builder y revisión, D18).
- Si la publicación falla (por ejemplo, el modelo está deshabilitado en Brains), la versión queda `Fallida` y un admin la reintenta desde Revisión de agentes › Historial.
- La reconciliación diaria alarma (`release_agent_content_changed`) si FinOps sirve contenido distinto del de la release (D42). También salta tras un cambio aprobado en la app: hay que confirmar que ese cambio es el esperado.

**Instalación nueva:** no hay pasos extra. El chat de FinOps responde cuando el provisioner termina.

**Instalación que ya tenía el harness de FinOps creado por CDK (el laboratorio): dos despliegues.**

1. **Convivencia.** Desplegar el commit de convivencia de A5 (el anterior al que elimina el harness de CDK). Siembra y publica FinOps con el provisioner, y deja además el harness antiguo. `mango-api` usa el harness nuevo en cuanto está publicado y el antiguo mientras tanto; el interceptor del Gateway acepta la firma nueva (v2) y la anterior (v1), para las tareas que aún no se han reemplazado.
2. **Verificar** antes de seguir:
   - la ejecución de `Mango-<ns>-AgentProvisioner` terminó `SUCCEEDED`;
   - existe el ítem `PUBLISHED#finops` / `CURRENT` en la tabla `Agents`;
   - un turno de chat con FinOps deja en Auditoría un `agent.invoke` con `version: 1`, y CloudTrail muestra `InvokeHarness` sobre `harness/Mango_<ns>_a_finops-…`;
   - `tests/e2e/smoke.py` y el set de evaluación de FinOps pasan.
3. **Retiro.** Desplegar la versión final de A5. Elimina el harness `Mango_<ns>_finops`, su rol, el permiso de `mango-api` sobre él, la política Cedar `use-finops-agent` y la aceptación de la firma v1. Tras el despliegue el stack no tiene ningún `AWS::BedrockAgentCore::Harness`.

No saltarse el paso 1 en una instalación existente: el despliegue final quita el harness antiguo y la firma v1 mientras las tareas anteriores de `mango-api` todavía los usan.

## MCP packs (D36)

- El despliegue copia al bucket de packs lo que haya en `dist/packs/`: el sobre firmado (`<id>-<versión>.pack.json`), el zip y el SBOM de cada pack. Los genera el workflow `packs` (`packs/README.md`).
- Solo se aceptan packs firmados con la llave de `packs/signing-key.pub`. En el laboratorio se puede usar una llave de prueba poniendo su PEM en `packs.signingPublicKey` de `infra/config/poc.json`.
- Sin llave o sin packs firmados el despliegue funciona igual: el catálogo de packs queda vacío y no se puede habilitar ninguno.
- Habilitar un pack es una ejecución de la máquina `Mango-poc-PackProvisioner` (salida `PackProvisionerArn`) con `{"pack_id", "pack_version", "enablement_id"}`, sobre una habilitación aprobada en la tabla `Settings`.

### Red de los packs: egress restringido (R6)

Los Runtimes de packs corren en una VPC propia sin internet gateway ni NAT (`Mango-poc-PackVpc`). Solo alcanzan los endpoints de VPC que declara el manifiesto firmado de cada pack (`packs/README.md`, «Red de los Runtimes»).

- **Costo en el laboratorio:** 8 endpoints de interfaz en 2 zonas con los tres packs de hoy, ~USD 117 al mes. Sin packs en `dist/packs/` no se crea la red.
- **Zonas.** `packs.network.availabilityZoneIds` en `infra/config/poc.json` (por defecto `use1-az1` y `use1-az2`). Son ids, no nombres: AgentCore solo admite `use1-az1`, `use1-az2` y `use1-az4`.
- **Packs firmados antes de este cambio no sirven:** su manifiesto no declara `egress` y la síntesis falla. Hay que construir y firmar de nuevo los tres (`aws-pricing 1.1.1-2`, `aws-billing 0.0.38-5`, `aws-cloudwatch 0.3.1-2`) con el workflow `packs` y dejar en `dist/packs/` solo esas versiones.
- **Packs ya instalados.** Siguen en la red `PUBLIC` hasta que se actualizan. Después de desplegar `Core`: en el catálogo de MCP, actualizar cada pack habilitado (doble aprobación) o deshabilitarlo y habilitarlo de nuevo. Para ver la red de un Runtime:
  ```bash
  aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <id> \
    --query '{version: agentRuntimeVersion, network: networkConfiguration}'
  ```
  Debe decir `networkMode: VPC`, con las subnets y el security group de la salida `PackNetwork` del stack. Mientras un pack siga en otra red, la reconciliación diaria lo reporta (`pack_runtime_not_in_vpc`) y dispara la alarma `Mango-<ns>-Reconciler-findings`: ver «Reconciliación diaria y alarmas».
- **Rol vinculado al servicio.** El primer Runtime en modo VPC de la cuenta crea `AWSServiceRoleForBedrockAgentCoreNetwork`; el provisioner de packs tiene permiso para crear ese rol. El primer Runtime de la cuenta, de un pack o de un agente, crea además `AWSServiceRoleForBedrockAgentCoreRuntimeIdentity`; los dos provisioners pueden crearlo (D40 (5), D43 (4)). No pueden crear ningún otro rol vinculado a un servicio.
- **Quitar un pack de la release.** Deshabilitarlo y esperar hasta 8 horas antes de desplegar la release que ya no lo trae: AgentCore tarda eso en soltar sus interfaces de red y CloudFormation no puede borrar el security group mientras tanto.
- **CloudWatch solo en `us-east-1`.** El pack `aws-cloudwatch` rechaza otra región con un mensaje que lo dice.

**Prueba de la red** (crea y borra recursos reales, etiquetados `mango:e2e=pack-egress`). Un Runtime de prueba pregunta desde dentro qué alcanza:

```bash
# Red temporal, sin tocar la instalación: prueba el diseño (rutas, security groups, políticas
# de endpoint, DNS Firewall) con los permisos que tiene el provisioner.
uv run --no-project --with boto3 python tests/e2e/pack_egress.py \
  --profile mango-sandbox --state <archivo-local>.json

# Red desplegada: usa las subnets y el security group de un pack de la release.
uv run --no-project --with boto3 python tests/e2e/pack_egress.py \
  --profile mango-sandbox --state <otro-archivo-local>.json --network stack --pack aws-pricing
```

«Los permisos que tiene el provisioner» son una copia que vive en el guion (`caller_policy`). Un test de `infra/` la compara con el rol del provisioner y falla si se separan (`docs/security/threat-models/pack-egress-threat-model.md`, «Comprobado en el laboratorio»).

Con `--network stack --pack aws-pricing` debe pasar: el Runtime arranca sin ruta a internet, un nombre fuera de la allowlist no resuelve, una IP pública y una privada no conectan, Price List responde por su endpoint, **STS no es alcanzable** (ese pack no lo declara), los logs llegan y el DNS Firewall falla cerrado. `cleanup` borra todo salvo, con la red temporal, la VPC y sus subnets mientras AgentCore conserve las interfaces (hasta 8 horas): repetir `--steps cleanup` con el mismo archivo de estado.

Después, las pruebas de punta a punta de los packs reales (más abajo: fase B, fase C y cuentas miembro) deben pasar igual que antes.

### Inactividad del Runtime y sesiones del Gateway (D47)

- **Runtime de los packs.** Cada versión se crea con 60 s de inactividad y 28 800 s de vida máxima. Requiere desplegar `Core` (lleva el código del provisioner de packs).
- **Packs ya instalados.** No se migran solos. Siguen con 900 s hasta la siguiente ejecución aprobada del pack: actualizar, cambiar parámetros, o deshabilitar y volver a habilitar. Para ver qué tiene un Runtime:
  ```bash
  aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <id> \
    --query '{version: agentRuntimeVersion, lifecycle: lifecycleConfiguration}'
  ```
- **Sesiones MCP del Gateway.** Activas por defecto, con 900 s. Para desactivarlas: `"gateway": {"mcpSessions": false}` en `infra/config/poc.json` y desplegar `Core`. Es una actualización del Gateway sin reemplazo: no cambian su id ni su URL.
- **Comprobar tras desplegar**, antes de dar el cambio por bueno:
  1. `aws bedrock-agentcore-control get-gateway --gateway-identifier <id> --query protocolConfiguration` muestra `sessionTimeoutInSeconds: 900`.
  2. El agente FinOps responde una pregunta que usa tools (por ejemplo, el costo del mes por servicio). Si las tools fallan y el log del Gateway muestra respuestas 400, el harness no envía `Mcp-Session-Id`: desactivar las sesiones.
  3. Con un pack habilitado, un turno con dos llamadas al mismo pack: la segunda debe tardar menos de un segundo.
  4. Un turno con tools de FinOps y de un pack a la vez.
  5. Dos turnos seguidos en la misma conversación, y otro después de más de 15 minutos: el harness abre una sesión nueva por invocación, así que ninguno debe fallar con 404.

## Bajar Cognito de Plus a Essentials

No se puede en un solo despliegue: falla con un error de `Log Streaming`, porque el plan Essentials no admite la entrega de logs que queda activa (verificado el 2026-10-01). Hay que hacerlo en dos pasos:

```bash
# 1. Desactivar la entrega de logs del user pool
aws cognito-idp set-log-delivery-configuration --user-pool-id <pool> --log-configurations '[]'

# 2. Actualizar Core a una versión cuyo plan sea Essentials (`install.md`, paso 4)
```

## Prueba E2E (usuarios `e2e: true`)

```bash
uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
  python tests/e2e/smoke.py --profile mango-sandbox \
  --secrets <archivo-local-fuera-del-repo>.json \
  --user <email-e2e> --me --question "¿Cuánto gastamos este mes?"
```

### Antes de correr las pruebas de punta a punta

Los scripts de `tests/e2e/` y `tests/eval/` usan los usuarios `e2e: true` contra el laboratorio. Estas reglas del producto hacen fallar una corrida que, por lo demás, está bien:

| Regla | Síntoma | Qué hacer |
|---|---|---|
| El código TOTP no se puede reutilizar dentro de su ventana de 30 s | El inicio de sesión falla en `respond_to_auth_challenge` cuando dos scripts (o dos pasos) entran con el mismo usuario seguidos | Esperar 31 s entre corridas que usan el mismo usuario |
| Un creador envía a revisión 5 agentes al día como máximo (`MAX_SUBMISSIONS_PER_DAY`) | `agent_submit` responde 429 `submission_limit` | Usar el otro administrador como creador (`--creator`/`--requester`) y el primero como aprobador, o reutilizar un agente publicado con `--agent <id>` |
| Cada usuario tiene un presupuesto mensual de IA (USD 5 por defecto) y la reserva es previa a la llamada | El chat responde 402 `budget_exceeded` aunque el gasto mostrado sea algo menor que el límite | Usar otro usuario para el chat, o subir el límite de ese usuario en Presupuestos (solo en el laboratorio) |
| Nadie aprueba lo que él mismo pidió | 403 `same_approver` | Los scripts ya lo comprueban; quien pide y quien aprueba deben ser dos administradores distintos |
| Los packs de datos de cuentas son solo para usuarios centrales | El usuario de área recibe 403 o no ve el agente | Es lo esperado; el solicitante de esos scripts debe estar en `finops-central` |
| CloudTrail tarda minutos en mostrar los eventos | El paso `trail` no encuentra el `AssumeRole` | Repetir solo ese paso con `--steps trail --since <hora ISO del turno>` |

- Tras retirar un agente, su harness y su rol se borran en segundo plano (D48); una corrida inmediata puede verlos todavía.
- Los scripts imprimen JSON por paso y no muestran tokens. Guarda los informes fuera del repo y fuera de `/tmp` (ver «Entorno local» en `AGENTS.md`).
- Las sesiones de AWS SSO de los perfiles (`mango-sandbox`, `mango-mgmt` y los de las cuentas miembro) vencen por separado: una prueba que usa la pagadora necesita `aws sso login --profile mango-mgmt` vigente.

### Latencia del chat y progreso en vivo (D39)

`tests/e2e/chat_latency.py` mide cuándo llega cada cosa al usuario: la primera fase del progreso (evento `status`), la primera tool y el primer bloque de la respuesta. No crea nada más que las conversaciones del usuario e2e; cada turno gasta su presupuesto como cualquier otro. Se corre antes y después de un despliegue que toque el chat y se comparan los resúmenes:

```bash
uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
  python tests/e2e/chat_latency.py --profile mango-sandbox \
  --secrets <archivo-local-fuera-del-repo>.json \
  --user <email-e2e> --turns 5 --follow-up
```

Qué esperar con el evento `status` desplegado: `first_status_s` casi igual a `first_conversation_s` (menos de 1 s), una fase `tool` por cada llamada y `tool_result` entre la última tool y el primer bloque. `first_delta_s` no cambia: el texto sigue llegando en bloques revisados por el guardrail. Línea base del laboratorio sin `status` (2026-10-02, FinOps, 5 turnos): en una conversación nueva, la primera señal (un texto breve y la primera tool) llega a los 8,0 s (p50, máximo 9,5 s); en el segundo mensaje, la primera tool a los 4,0 s y el primer bloque a los 10,5 s. Hasta la primera señal la pantalla solo decía «Pensando...».

## Reconciliación diaria y alarmas (Marketplace v1, A11)

La función `Mango-<ns>-Reconciler` corre cada día a las 07:00 UTC (regla `Mango-<ns>-Reconciler-daily`). Solo lee: compara la tabla `Agents` con los harness `Mango_<ns>_a_*` y los roles `Mango-<ns>-agent-*`, y revisa en qué red corren los Runtimes de packs `Mango_<ns>_mcp_*` (R6, D54). No repara nada: lo que deja un agente retirado lo borra el deprovisioner (D48), y aquí se reporta si no lo hizo.

- **Hallazgos:** una línea `reconciler.finding` por hallazgo en `/aws/lambda/Mango-<ns>-Reconciler`, con código, agente (o ninguno, si es un Runtime de pack) y recurso. Nunca contenido de agentes.
- **Métricas:** namespace `Mango/Reconciler`, dimensión `Installation`.
- **Alarmas** (todas notifican al topic `Mango-<ns>-Alerts`, salida `AlertsTopicArn`):

| Alarma | Qué significa |
|---|---|
| `Mango-<ns>-Reconciler-findings` | La última ejecución encontró algo. Se apaga cuando una ejecución termina sin hallazgos |
| `Mango-<ns>-Reconciler-failed` | La reconciliación falló tras sus reintentos; el evento está en la cola `Mango-<ns>-Reconciler-dlq`. Tras corregir la causa, vaciar la cola |
| `Mango-<ns>-AgentProvisioner-failed` | Una ejecución del provisioner falló, venció o fue abortada |
| `Mango-<ns>-AgentProvisioner-volume` | Más de 30 publicaciones en una hora |
| `Mango-<ns>-AgentDeprovisioner-failed` | Falló, venció o fue abortado el borrado del harness o del rol de un agente retirado (D48). El agente sigue retirado; ver «Agentes retirados» más abajo |

Ejecutarla a mano y ver el resultado:

```bash
aws lambda invoke --function-name Mango-poc-Reconciler --cli-binary-format raw-in-base64-out \
  --payload '{}' /dev/stdout
```

| Código | Causa habitual | Qué hacer |
|---|---|---|
| `harness_orphan`, `role_orphan` | Recurso con el prefijo de Mango sin agente, o resto de una primera publicación fallida | Confirmar en CloudTrail quién lo creó y borrarlo |
| `harness_missing`, `role_missing`, `harness_replaced` | Borrado o recreado fuera de Mango | Publicar una versión nueva del agente |
| `live_endpoint_drift`, `harness_version_unexpected`, `harness_content_mismatch` | `UpdateHarness` o `UpdateHarnessEndpoint` fuera del provisioner | Revisar CloudTrail; publicar de nuevo la versión aprobada |
| `role_without_boundary`, `role_trust_changed`, `role_policies_changed` | Rol de agente alterado | Tratar como incidente: revisar CloudTrail y restaurar el rol |
| `version_stuck_approved` | La ejecución venció o nunca arrancó (la versión quedó `approved`) | Un admin abre Revisión de agentes › Historial: la versión aparece como «Fallido» en «publication_expired» y se publica de nuevo con «Reintentar» (disponible a los 45 minutos de la aprobación) |
| `publication_record_mismatch`, `provision_lock_invalid`, `record_invalid` | La tabla no coincide con lo que publicó el provisioner | Revisar quién escribió la tabla |
| `creator_over_submissions`, `creator_over_drafts` | Un creador supera los límites que aplica `mango-api` | Revisar la auditoría de ese usuario |
| `retired_agent_resources` | Harness o rol de un agente retirado hace menos de 45 minutos (el deprovisioner los está borrando), o de un agente de la release, que los conserva | Informativo: no dispara la alarma |
| `pack_runtime_not_in_vpc` | Un Runtime de pack (`resource`: su id) sirve una versión fuera de la red de packs. `detail` dice la versión, la red (`PUBLIC`) y qué endpoint la sirve: `live` es el que llama el Gateway; `DEFAULT` sirve siempre la versión más reciente. Lo habitual: un pack instalado antes de R6 que no se ha actualizado, o una actualización que falló antes de mover `live` | Mientras siga así el pack tiene salida a internet. En el catálogo de MCP, actualizar el pack (doble aprobación) o deshabilitarlo y habilitarlo de nuevo; si no se va a usar, deshabilitarlo. Si el pack ya estaba actualizado, tratarlo como incidente: revisar en CloudTrail quién llamó `UpdateAgentRuntime`. La alarma se apaga con la siguiente ejecución sin hallazgos |
| `deprovision_incomplete` | Pasaron 45 minutos del retiro y queda el harness o el rol: el deprovisioner falló o no arrancó | Ver «Agentes retirados»: leer el motivo, corregirlo e iniciar la ejecución de nuevo |

### Agentes retirados: borrado del harness y del rol (D48)

Retirar un agente inicia la máquina `Mango-<ns>-AgentDeprovisioner` (salida `AgentDeprovisionerArn`). Borra los endpoints del harness salvo `DEFAULT`, luego el harness `Mango_<ns>_a_<id>` y al final el rol `Mango-<ns>-agent-<id>`. Tarda entre 5 y 15 minutos: borrar un endpoint es asíncrono. Los agentes de la release (FinOps) no se borran.

- **Ver qué pasó:** en Auditoría, el evento `agent.deprovision` (`requested`, luego `applied` o `rejected`). Un `rejected` trae `failed_step` y `failure` (un código, nunca el mensaje de AWS). El mismo código sale en el log `/aws/lambda/Mango-<ns>-Deprovisioner` (`deprovisioner.step_failed`).
- **Reintentar a mano** (es idempotente; también sirve para agentes retirados antes de esta versión):

  ```bash
  aws stepfunctions start-execution --region us-east-1 \
    --state-machine-arn <salida AgentDeprovisionerArn> \
    --name "<id>-retire-manual-$(date +%s)" \
    --input '{"agent_id":"<id>"}'
  ```

  El nombre `<id>-retire-…` importa: el Marketplace muestra a los admins el estado de la última ejecución con ese nombre («Limpiando», «Limpieza falló»). Una ejecución con otro nombre borra igual, pero el aviso de fallo no se quita.

  Si ya no queda nada termina en `NothingToDo`. Si el agente no está retirado falla con `not_retired` y no borra nada.

| `failure` | Causa | Qué hacer |
|---|---|---|
| `endpoint_delete_timeout`, `harness_delete_timeout` | AgentCore tardó más de 15 minutos | Reintentar |
| `role_without_boundary` | El rol no lleva el boundary de agentes: no lo creó el provisioner o alguien lo cambió | Revisar CloudTrail y borrarlo a mano |
| `DeleteRole:DeleteConflict` | El rol tiene políticas gestionadas adjuntas (cambio fuera de Mango) | Revisar CloudTrail, quitarlas y reintentar |
| `version_not_retired`, `not_retired` | La tabla no dice que el agente y su versión estén retirados | Revisar quién escribió la tabla; no se borra nada |
| `<Operación>:AccessDeniedException` | Al rol `Mango-<ns>-Deprovisioner` le falta un permiso | Buscar la llamada denegada en CloudTrail y reportarlo |

### Quién recibe las alertas

`alerts.emails` de la configuración (`infra/config/<env>.json`, hasta 10 correos) suscribe esos buzones al topic `Mango-<ns>-Alerts`:

```json
"alerts": { "emails": ["oncall@example.com"] }
```

- SNS envía a cada buzón un correo de confirmación. **Hasta que su dueño acepta, no recibe nada.**
- Quitar un correo de la lista y redesplegar borra su suscripción.
- Otros canales (chat, paging) se suscriben al topic fuera del stack.
- Los mensajes llevan el nombre de la alarma, la métrica y el umbral. Nunca contenido de agentes ni de conversaciones.

**Comprobar que llegan** (después de desplegar; no cambia ningún recurso de Mango):

```bash
aws cloudwatch set-alarm-state --alarm-name Mango-poc-Reconciler-findings \
  --state-value ALARM --state-reason "prueba de notificaciones"
```

- Debe llegar un correo en uno o dos minutos. La alarma vuelve sola a su estado real en la siguiente evaluación.
- Si no llega: métrica `NumberOfNotificationsFailed` del topic (namespace `AWS/SNS`). La llave `alias/Mango-<ns>-alerts` solo deja publicar a CloudWatch en nombre de esta cuenta (`aws:SourceAccount`). Si esa condición fuera la causa, se quita en `infra/lib/constructs/alerts.ts` y se reporta: es la única diferencia con la sentencia mínima que documenta AWS.

## Marketplace: prueba de punta a punta (fase A)

**En el navegador, contra el mock local** (sin AWS):

```bash
mise run e2e
```

Playwright recorre crear → enviar a revisión → el autor no puede aprobar → otro admin aprueba → publicación → reintento de una publicación fallida → uso en el chat. También corre en CI.

**Contra el laboratorio** (crea recursos reales: una versión en `Agents` y, al aprobar, un rol y un harness):

```bash
uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
  python tests/e2e/marketplace.py --profile mango-sandbox \
  --secrets <archivo-local-fuera-del-repo>.json \
  --creator <admin e2e> --approver <otro admin e2e> --outsider <usuario e2e de un área>
```

| Paso | Esperado |
|---|---|
| `create`, `submit` | Borrador y luego `in_review` con su `content_hash` |
| `self_approval` | 403 `same_approver`: quien escribió la versión no la aprueba |
| `not_usable_before_approval` | 403: antes de publicarse nadie la usa |
| `read_for_review`, `approve` | El otro admin lee el diff y aprueba el hash que leyó |
| `published` | El provisioner la publica (uno o dos minutos; la primera invocación paga el arranque en frío) |
| `marketplace`, `chat` | El creador (miembro del grupo central) la ve y recibe respuesta |
| `outsider` | El usuario del área no la ve, recibe 403 en el detalle y en el chat |
| `retire` | Queda `retired` y el chat ya no la atiende |
| `deprovisioned` | La ejecución del deprovisioner termina `SUCCEEDED` y ya no existen el harness ni el rol del agente (entre 5 y 15 minutos) |

- `--dry-run` solo lee (sesión, catálogos, cola de revisión): no crea nada. Sirve para comprobar el acceso antes de la prueba.
- `--keep` deja el agente publicado.
- **Limpieza.** Retirar borra el harness `Mango_<ns>_a_<id>` (con sus endpoints) y el rol `Mango-<ns>-agent-<id>` (D48); el paso `deprovisioned` lo comprueba con las credenciales de quien ejecuta la prueba (lectura de AgentCore, IAM y Step Functions). Quedan los ítems del agente en la tabla y los log groups del Runtime (30 días). Si `deprovisioned` falla, ver «Agentes retirados».
- Si `published` falla, el paso muestra `failed_step`; el motivo está en el log de `Mango-<ns>-Provisioner`.

**Checklist de cierre de la fase A** (con los usuarios E2E, en el navegador):

1. Un usuario de `mango-agent-creator` crea un agente y lo envía; en Marketplace aparece en «Tus agentes en curso».
2. Ese mismo usuario no puede aprobarlo; otro admin ve el diff, lo rechaza con motivo y el historial lo muestra como «Rechazado» con ese motivo y el correo de quien revisó.
3. El creador lo corrige y lo reenvía; el otro admin lo aprueba; pasa de «Publicando…» a «Publicado».
4. Un miembro de sus grupos lo ve en Marketplace y chatea con él; un usuario de otra área no lo ve.
5. Org Chart lo muestra bajo su supervisor; «Editar» abre el Builder en su versión.
6. Presupuestos lista el agente con su gasto; Auditoría muestra `agent.version.submitted`, `approved` y el turno del chat con su agente.
7. `tests/e2e/smoke.py` y `tests/e2e/gateway_probe.py` siguen pasando (FinOps sin regresiones; un `bu-lead` sigue sin poder llamar a las tools de toda la organización).

## MCP packs: prueba de punta a punta (fase B)

Contra el laboratorio, con dos administradores E2E. **Crea recursos reales:** el rol, el Runtime, el target del Gateway y las políticas Cedar del pack, y el rol y el harness de un agente de prueba.

```bash
uv run --no-project --python 3.13 --with boto3 --with pycognito --with pyotp --with httpx \
  --with ./packages/py/mango-packs \
  python tests/e2e/packs.py --profile mango-sandbox \
  --secrets <archivo-local-fuera-del-repo>.json \
  --requester <admin e2e> --approver <otro admin e2e>
```

| Paso (`--steps`) | Esperado |
|---|---|
| `enable` | Solicitud con los parámetros por defecto del manifiesto; quien pidió recibe 403 al aprobar y al rechazar; el otro admin aprueba; el pack pasa a `enabled` (poco más de un minuto) |
| `aws` | Solo lectura: Runtime `READY` con `live` en su versión, sin autorizador de tokens; target `<id>` con SigV4 y sin propagar `Authorization`; políticas `Mango_<ns>_mcp_<id>_<n>` activas, solo `permit` de las tools del pack; rol con el boundary `Mango-<ns>-mcp-boundary` y solo las acciones del manifiesto; `tools/list` del Runtime con las tools del manifiesto (y su `tools_hash`, para compararlo con `packs/<id>/manifest.yaml`); una llamada sin SigV4 recibe 403 |
| `agent` | Un agente con todas las tools del pack: creado por un admin, aprobado por el otro, publicado. Un turno de chat llama a una tool y responde con un precio |
| `measure` | Latencia del Runtime en frío (sin sesión MCP) y en caliente (repitiendo el `Mcp-Session-Id`), y de las tools desde el chat. Llama a `InvokeAgentRuntime` con las credenciales de quien ejecuta la prueba |
| `disable` | Sin motivo, 422. Con motivo, un solo admin: el pack pasa a `disabled`; el agente sigue publicado, lista las tools en `unavailable_tools` y responde sin llamarlas (D46) |
| `reenable` | Otra vez con doble aprobación; el agente recupera las tools sin nueva revisión |
| `cleanup` | Retira el agente. El pack queda como estaba antes de la prueba (deshabilitado, si la prueba lo habilitó) |

- Sin `--steps` corre todos, en ese orden. Con `--steps` se pueden correr por partes; `--agent <id>` reutiliza un agente ya publicado.
- `--dry-run` solo lee (sesión y catálogo). `--keep-pack` deja el pack habilitado. `--show` imprime el principio de cada respuesta (precios públicos).
- Una corrida completa dura unos 10 minutos. El token de acceso dura una hora.
- `aws` y `measure` necesitan permisos de lectura de AgentCore e IAM para quien ejecuta la prueba; `measure`, además, `bedrock-agentcore:InvokeAgentRuntime` sobre el Runtime del pack.
- **Limpieza.** Deshabilitar borra políticas, target, Runtime y rol del pack; quedan sus log groups (30 días). El harness y el rol del agente retirado los borra el deprovisioner unos minutos después (D48); esta prueba no espera a que termine.
- Si `enable_installed` falla, el paso muestra `failed_step` y `failure`; el motivo está en el log de `Mango-<ns>-PackProvisioner`.

## Packs de datos de cuentas: prueba de punta a punta (fase C)

Para un pack `central_only` (`aws-billing`). Necesita `Core` desplegado con el pack firmado en `dist/packs/`: el despliegue añade el rol del pack al trust del broker de Billing y el pack a `IDENTITY_TARGETS` del interceptor. **Crea recursos reales**, como la prueba de la fase B.

```bash
uv run --no-project --python 3.13 --with boto3 --with pycognito --with pyotp --with httpx \
  --with ./packages/py/mango-packs \
  python tests/e2e/account_data_pack.py --profile mango-sandbox --payer-profile mango-mgmt \
  --secrets <archivo-local-fuera-del-repo>.json \
  --requester <admin central e2e> --approver <otro admin e2e> --area-user <líder de área e2e>
```

| Paso (`--steps`) | Esperado |
|---|---|
| `enable` | Igual que en la fase B: doble aprobación y `enabled` |
| `aws` | Solo lectura: Runtime y target como en la fase B; políticas Cedar en pares `permit` / `forbid`, todas con `mango_central`; el rol del pack solo con `sts:AssumeRole`, `SetSourceIdentity` y `TagSession` sobre el broker; el trust del broker nombra el rol del pack y exige `SourceIdentity`; el entorno del Runtime solo trae `MANGO_PACK_*`; el interceptor firma para el pack y no le entrega el token; `tools/list` con las tools del manifiesto; un `tools/call` directo al Runtime, sin identidad o con una inventada, recibe el rechazo fijo |
| `agent` | Un agente con las tools del pack para un grupo central, aprobado por el otro admin y publicado |
| `central` | Un turno del usuario central llama a una tool del pack y responde con cifras. Con `--families`, un turno más por cada tool del pack, pidiéndola por su nombre: todas deben ejecutarse (`central_family` por tool y `central_families` al final) |
| `area` | El líder de área no ve el agente (403 en el detalle y en el chat); una llamada suya directa al Gateway no devuelve datos; un borrador con esas tools para un grupo de área recibe 422 `account_data_for_non_central_group` y se borra |
| `trail` | CloudTrail de la pagadora: `AssumeRole` sobre `Mango-<ns>-BillingReader` con `sourceIdentity` = `sub` del usuario central, hecho por una sesión del broker con la misma identidad y con session policy; ninguno con el `sub` del líder de área. En la cuenta Mango: `AssumeRole` del rol del pack sobre el broker con los tags `mango_user`, `mango_agent` y `mango_bu`. Los eventos tardan hasta 15 minutos: el paso espera (`--trail-wait`, 20 minutos por defecto) |
| `cleanup` | Retira el agente. El pack queda como estaba antes de la prueba |

- `--show` imprime el principio de cada respuesta: **son costos de la organización**, no usarlo en una terminal compartida.
- `--families` necesita un agente que tenga todas las tools del pack: un agente publicado antes de que el pack creciera conserva las que tenía, así que hay que crear otro (paso `agent`, sin `--agent`). Son unos nueve turnos más.
- **Servicios con inscripción.** `compute-optimizer` y `cost-optimization` solo devuelven datos si Compute Optimizer y Cost Optimization Hub están activos en la pagadora. La prueba lo lee con `--payer-profile` (paso `payer_enrollment`) y **no inscribe nada**: si el servicio no está activo, espera que la tool se ejecute y responda ese error. Para verlo a mano: `aws compute-optimizer get-enrollment-status --profile mango-mgmt --region us-east-1` y `aws cost-optimization-hub list-enrollment-statuses --profile mango-mgmt --region us-east-1`.
- **Si el pack pide acciones nuevas** (cambió `BILLING_READER_DATA_ACTIONS`), antes de habilitarlo hay que actualizar el stack de la pagadora (`Mango-<ns>-Payer`) a la versión nueva (`install.md`, paso 4). Sin eso, el rol detrás del broker no tiene las acciones y las tools nuevas responden `AccessDenied`.
- `trail` se puede correr aparte más tarde con `--steps trail --since <hora ISO del turno>`.
- La misma consulta a mano, en la pagadora:
  ```bash
  aws cloudtrail lookup-events --profile mango-mgmt --region us-east-1 \
    --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole \
    --start-time <hora ISO del turno> \
    --query 'Events[].CloudTrailEvent' --output text \
    | tr '\t' '\n' \
    | jq -c 'select(.requestParameters.roleArn | endswith(":role/Mango-poc-BillingReader"))
        | {eventTime, sourceIdentity: .requestParameters.sourceIdentity,
           caller: .userIdentity.arn, callerSourceIdentity: .userIdentity.sessionContext.sourceIdentity,
           hasSessionPolicy: (.requestParameters.policy != null), errorCode}'
  ```
- Las llamadas de datos (`GetCostAndUsage`) también quedan en CloudTrail de la pagadora, con el mismo `sourceIdentity` en `userIdentity.sessionContext`: `--lookup-attributes AttributeKey=EventSource,AttributeValue=ce.amazonaws.com`.

## Tools de escritura con aprobación: prueba de punta a punta (D27)

Primera tool de escritura: `aws-budgets.create_budget`, que crea un presupuesto mensual en la cuenta pagadora (sin notificaciones). Modelo de amenazas: `docs/security/threat-models/write-tools-approval-threat-model.md`.

Qué se despliega (dos stacks, en este orden):

1. **Payer** (cuenta de administración): rol nuevo `Mango-<ns>-BudgetsOperator`, con `budgets:ModifyBudget` solo sobre `budget/Mango-<ns>-*` y trust al broker de escritura de la cuenta de Mango.
2. **Core**: tabla `Mango-<ns>-Approvals`, llave `alias/Mango-<ns>-approval` (solo `mango-api` firma), Lambda `Mango-<ns>-ApprovalExecutor`, rol `Mango-<ns>-OperateBroker`, target `ops` del Gateway con sus políticas Cedar, y variables nuevas del interceptor y de `mango-api`.

Después, con dos administradores de FinOps central (usuarios `e2e: true`):

```bash
uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
  python tests/e2e/write_approval.py --profile mango-sandbox --payer-profile mango-mgmt \
  --secrets ~/.config/mango/lab/e2e-secrets.json \
  --requester <admin central> --approver <otro admin central>
```

El script cambia la política de la tool con doble aprobación (hasta USD 500 confirma quien pide), publica un agente temporal con la tool, comprueba que nada existe en AWS Budgets antes de confirmar, que el Gateway rechaza la tool sin aprobación, que una solicitud confirmada crea exactamente ese presupuesto y no se puede repetir, y que por encima del umbral firma otra persona y ejecuta quien pidió. Al terminar retira el agente y **borra los presupuestos** `Mango-<ns>-e2e-*` con las credenciales de la pagadora (`--keep` los deja).

Qué mirar a mano: en CloudTrail de la pagadora, `CreateBudget` por el rol `Mango-<ns>-BudgetsOperator` con `sourceIdentity` = el `sub` de quien pidió y la etiqueta de sesión `mango_approval`; en Auditoría de Mango, los eventos `approval.*`.

Si el script falla antes de limpiar: `aws budgets describe-budgets --account-id <pagadora> --profile mango-mgmt --query "Budgets[?starts_with(BudgetName, 'Mango-<ns>-e2e-')].BudgetName"` y `aws budgets delete-budget` por cada uno.
## Packs sobre cuentas miembro: prueba de punta a punta (CloudWatch, D51)

Para un pack `central_only` de la cadena `member` (`aws-cloudwatch`). **Crea recursos reales**, como la prueba de la fase C, y no cambia nada en las cuentas miembro.

Antes, en este orden:

1. `dist/packs/` con el pack firmado (`aws-cloudwatch-<versión>.pack.json`, el zip y el SBOM), además de los que ya hubiera. `aws-billing` cambia de revisión en la misma release: su zip lleva el código común nuevo.
2. `mise run synth` y **`OrgAccess`** (el rol `Mango-<ns>-ReadOnly` recibe sus acciones de lectura en cada cuenta objetivo): actualizar `Mango-<ns>-OrgAccess` a la versión nueva (`install.md`, paso 4). Esperar a que las instancias del StackSet queden `CURRENT`.
3. **`Core`** (trust de `ReadBroker` con el rol del pack, boundary de packs, entorno del provisioner de packs y el pack en `IDENTITY_TARGETS` del interceptor).
4. `tests/e2e/member_access.py` sigue pasando (el rol de cada cuenta tiene exactamente las acciones de la release).

```sh
uv run --no-project --python 3.13 --with boto3 --with pycognito --with pyotp --with httpx \
  --with ./packages/py/mango-packs \
  python tests/e2e/member_data_pack.py --profile mango-sandbox \
  --member-profile <cuenta Audit>=mango-audit --member-profile <cuenta Log Archive>=mango-logarchive \
  --outside-account <cuenta de administración> \
  --secrets <ruta> --requester <admin central> --approver <otro admin> --area-user <líder de área>
```

| Paso | Qué comprueba |
|---|---|
| `enable` | Solicitud de un admin y aprobación del otro; el pack pasa a `enabled` |
| `aws` | Solo lectura: Runtime, target y políticas Cedar como en la fase C; el rol del pack solo con `sts:AssumeRole`, `SetSourceIdentity` y `TagSession` sobre `ReadBroker`; el trust de `ReadBroker` nombra el rol del pack y el del broker de Billing no; el entorno del Runtime trae el **nombre** del rol (`MANGO_PACK_TARGET_ROLE_NAME`) y ningún ARN de destino; los esquemas listados exigen `account_id`, acotan `region` y no traen `profile_name`; un `tools/call` directo al Runtime recibe el rechazo fijo; el rol de cada cuenta miembro tiene exactamente las acciones de lectura de la release y ninguna de contenido de logs |
| `agent` | Un agente con las tools del pack para un grupo central, aprobado por el otro admin y publicado |
| `central` | Por cada cuenta miembro: un turno que lista sus alarmas activas y otro que lee una métrica; las dos tools deben completarse. Después, la cuenta Mango y `--outside-account`: la tool se llama y responde el rechazo |
| `area` | Como en la fase C: el líder de área no ve el agente, el Gateway lo rechaza y un agente de un grupo de área con estas tools no pasa a revisión |
| `trail` | CloudTrail de cada cuenta miembro: `AssumeRole` sobre `Mango-<ns>-ReadOnly` con `sourceIdentity` = `sub` del usuario central, hecho por `ReadBroker` y con session policy; ninguno con el `sub` del líder de área. En la cuenta Mango: `AssumeRole` del rol del pack sobre `ReadBroker`. Hasta 15 minutos |
| `cleanup` | Retira el agente. El pack queda como estaba antes de la prueba |

- Si `enable` falla en `ensure_runtime` o `verify_tools`, mirar el log del provisioner de packs: es la primera vez que el Runtime recibe un zip comprimido de este tamaño (97 MB; 304 MB descomprimido).
- Si `central` falla con `AccessDenied` en una tool y no con el rechazo fijo, la sesión se asumió pero al rol o a la session policy le falta la acción: comparar con `MEMBER_READ_ONLY_STATEMENTS`.

## Acceso a cuentas miembro (§4.10, C4)

Tres piezas, sin orden obligatorio entre ellas (ningún stack lee a otro):

| Pieza | Cuenta | Cómo se instala |
|---|---|---|
| `Mango-<ns>-ReadBroker` | Mango | Va dentro de `Core` |
| `Mango-<ns>-OrgAccess` (StackSet `Mango-<ns>-Member`) | Administración, o administrador delegado de StackSets | Plantilla `OrgAccess` de la versión (`install.md`, paso 2), sin bootstrap |
| `Mango-<ns>-ReadOnly` | Cada cuenta miembro objetivo | Lo crea el StackSet. Con CfCT o AFT: `infra/cdk.out/Member.template.json` |

**Prerrequisitos (los hace el cliente; Mango no cambia ajustes de Organizations):**

- Acceso de confianza de StackSets activado **desde CloudFormation**. Comprobar: `aws cloudformation describe-organizations-access` debe responder `ENABLED`. Si responde `DISABLED`, activarlo desde la cuenta de administración: `aws cloudformation activate-organizations-access` (o en la consola de StackSets). Activar solo el principal de servicio en Organizations no basta.
- Decidir los objetivos: OUs concretas (preferido) o la raíz. Las cuentas que entren después a esas OUs reciben el rol solas; las que salgan lo pierden.
- La cuenta de administración nunca recibe el rol: los StackSets no llegan a ella.

**Instalación:** los stacks `OrgAccess` (parámetros `Targets` y `ExcludedAccountIds`) y `Core` de `install.md`, paso 2. Al terminar, todas las instancias del StackSet deben quedar `CURRENT` / `SUCCEEDED`.

**Comprobación (solo lectura):** `tests/e2e/member_access.py`. No crea ni cambia nada.

```bash
mise run synth   # el script compara la plantilla desplegada con la que sintetiza la release
uv run --no-project --python 3.13 --with boto3 python tests/e2e/member_access.py \
  --config infra/config/poc.json --profile mango-sandbox --admin-profile mango-mgmt \
  --member-profile <cuenta>=<perfil> --member-profile <cuenta>=<perfil>
```

| Paso | Qué comprueba |
|---|---|
| `org` | Qué cuentas deben tener el rol: las activas bajo los objetivos, menos las excluidas y la de administración |
| `stackset` | StackSet `SERVICE_MANAGED` con auto-deployment, con la misma plantilla que sintetiza la release, y una instancia al día por cuenta esperada y ninguna de más |
| `broker` | El trust de `ReadBroker` nombra ARNs exactos de la cuenta Mango, exige `SourceIdentity` y la organización; solo puede asumir `Mango-<ns>-ReadOnly`, y solo dentro de la organización |
| `roles` | En cada cuenta con `--member-profile`: el rol existe, confía solo en el broker, exige `SourceIdentity` y tiene exactamente las acciones de la release (hoy, ninguna). Sin perfil, la cuenta se reporta como no comprobada |
| `chain` | El AdminProbe llega al rol de cada cuenta a través del broker con `SourceIdentity`; el broker rechaza una sesión sin `SourceIdentity`; el operador (administrador de la cuenta Mango, pero no el broker) es rechazado por el broker y por cada rol; en la cuenta de administración no hay rol al que llegar |
| `trail` | CloudTrail de cada cuenta miembro muestra el `AssumeRole` con el `SourceIdentity` de esta ejecución, desde la cuenta Mango y con session policy. Tarda hasta 15 minutos |

- El paso `chain` invoca el Lambda `Mango-<ns>-AdminProbe` con las credenciales del operador. En una instalación de cliente solo `mango-api` lo invoca.
- Si `member_role` falla con `access denied` en todas las cuentas, revisar primero la condición `aws:ResourceOrgID` de la política del broker (sin comprobar en AWS hasta este despliegue; ver `member-access-threat-model.md`).

**Quitarlo:** en la cuenta de administración, `aws cloudformation delete-stack --stack-name Mango-<ns>-OrgAccess` borra el StackSet y el rol de cada cuenta. El broker se va con `Core`.

## Desinstalar

Ver `install.md`, paso 5: el orden de borrado, qué queda retenido y cómo purgarlo (`deployment/purge-retained.sh`).
