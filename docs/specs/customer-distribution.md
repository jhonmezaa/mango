# Distribución para clientes: instalación «one-click» (v0.1, diseño)

> Fecha: 2026-10-03 · Estado: **diseño aprobado por el usuario el 2026-10-03**, con las decisiones de §9. Pasos 1 a 7 construidos (rama `feat/customer-distribution`); 1 a 5 probados en el laboratorio (§12). La desinstalación se vio en AWS el 2026-10-07 (§8.1 y D58, puntos 12 y 13); faltan por ver en una instalación la plantilla corregida del guard y el guion de purga corregido. Falta probar el workflow `release.yml`, y construir el paso 8 (usuarios de prueba con MFA y batería e2e) y el retiro del agente de la release.
> Decisiones que desarrolla o cambia: D3, D8, D9, D25, D36, D43, D54 (`reference-architecture.md` §4.9, §4.12, §8).
> Modelo de amenazas: `docs/security/threat-models/customer-distribution-threat-model.md`.
> Origen: prueba «one-click», parte 1 (desmantelar el laboratorio, 2026-10-03) y el pedido del usuario del mismo día: trabajar como cliente de aquí en adelante.

## 1. Resumen

La distribución que describe D8 no existe. Hoy `Core` solo se instala con `cdk deploy` y bootstrap de CDK, y toda la configuración de la instalación se hornea al sintetizar.

Este documento propone:

1. **Tres plantillas iguales para todos los clientes** (`Core`, `Payer`, `OrgAccess`), sin cuenta, organización ni usuarios escritos dentro. Lo propio de cada instalación entra por **parámetros de stack** (pocos) o se configura **desde la aplicación**.
2. **Distribución como Innovation Sandbox** (usuario, 2026-10-03): `mise run dist` y un workflow de GitHub publican plantillas y assets, inmutables por versión, en buckets de una cuenta de AWS del proveedor que está **fuera** de la organización del laboratorio. La imagen va a un ECR del proveedor, por digest.
3. **Instalar y actualizar = «Launch stack» / `CreateStack` / `UpdateStack`** con la URL de la plantilla de una versión. Sin bootstrap, sin CodeBuild, sin `cdk deploy` (reglas 1 y 2).
4. **Firma con llave KMS en la cuenta del proveedor** (§6): la llave y el rol de firma de packs se mudan allí desde la cuenta de gestión; el manifiesto de la release se firma con la misma llave. Nada en registros públicos.
5. **Desinstalación que funciona:** un recurso del stack limpia lo que Mango creó por API (agentes, packs) antes de que CloudFormation borre el resto.

Tamaño total estimado: 5 a 7 semanas de trabajo, en 10 pasos (§10).

## 2. Inventario: qué depende hoy de la cuenta, del bootstrap o de la configuración horneada

Medido sobre `infra/cdk.out` (síntesis del laboratorio, 2026-10-03) y el código de `infra/`.

### 2.1 Plantillas

| Plantilla | Tamaño | Recursos | Parámetros | Valores de la instalación escritos dentro |
|---|---|---|---|---|
| `Core` | 433 KB (límite 1 MB) | 325 (límite 500) | Solo `BootstrapVersion` | Cuenta Mango ×159, cuenta de gestión ×6, organización ×12, 2 OUs, 8 usuarios, zonas `us-east-1a/b`, `gmail.com` ×35, bucket y ECR del bootstrap ×29, región literal ×152 |
| `Payer` | pequeño | 5 | Ninguno | Cuenta Mango ×12, organización ×6 |
| `OrgAccess` | 4 KB | 2 | Ninguno | OUs objetivo, exclusiones, y la plantilla `Member` embebida con cuenta Mango y organización |
| `Member` | 4 KB | 2 | Ninguno | Cuenta Mango ×6, organización ×3 |

`Core` fija `env: { account, region }` (`infra/bin/mango.ts`), por eso CDK resuelve la cuenta como literal. Usa el synthesizer por defecto: exige `CDKToolkit`.

### 2.2 Assets de `Core` (20 archivos y 1 imagen)

| Asset | Cantidad | De dónde sale | Cómo llega hoy |
|---|---|---|---|
| Lambdas de Mango (Python, `uv` local) | 8 | `functions/*`, `connectors/cost-explorer` | Zip en el bucket del bootstrap |
| Lambdas de aws-cdk-lib (custom resources, auto-delete, restrict default SG, bucket deployment y su capa de AWS CLI) | 5 | aws-cdk-lib | Ídem |
| SPA | 3 | `apps/web/dist` (2 zips) y `config.json` generado | `BucketDeployment` desde el bucket del bootstrap |
| Packs firmados | 3 | `dist/packs` (zip, declaración firmada, SBOM) | `BucketDeployment` desde el bucket del bootstrap |
| La plantilla | 1 | synth | Bucket del bootstrap |
| Imagen `mango-api` | 1 | `apps/api/Dockerfile`, linux/arm64 | `DockerImageAsset` en el ECR del bootstrap |

Datos de la release que viajan **dentro** de assets o de la plantilla (no dependen del cliente): manifiestos de conectores y `models/capabilities.json` (en la imagen), políticas Cedar (`policies/`), definición del agente FinOps (`agents/finops/agent.json`), catálogo de packs por digest y llave pública de firma (`packs/signing-key.pub`).

La SPA **no** lleva valores de la instalación en el bundle: los lee de `config.json`, que se resuelve al desplegar. No hay que reconstruirla por cliente.

### 2.3 Lo que se rompe al quitar la cuenta y el namespace de la síntesis

- `gatewayName.toLowerCase()` (`tools.ts:344`) y las longitudes de nombres validadas al sintetizar: con `Namespace` como parámetro pasan a ser tokens.
- Ids de supresión de cdk-nag que incluyen cuenta, región o namespace (`core-stack.ts`, `agent-platform.ts`, `member-stack.ts`).
- Zonas por nombre (`availabilityZones`) en las dos VPC. La red de packs ya coloca subnets por **id de zona** (`AvailabilityZoneId`), que no depende de la cuenta.
- CIDR de las subnets de packs calculados al sintetizar (`packSubnetCidrs`).
- Usuarios, grupos y siembras de `Settings` como recursos generados por un bucle sobre la configuración.
- `OrgAccess`: la plantilla `Member` va en `TemplateBody` con cuenta y organización como literales; su `sha256` cambia por cliente.

### 2.4 Desinstalación (informe `one-click-part1.md`)

- El agente de la release (harness, endpoint, identidad de workload, rol) no es de CloudFormation y el deprovisioner lo ignora. Su rol retiene el boundary y el stack falla.
- Lo mismo pasaría con **cualquier** agente publicado o pack habilitado que siga vivo al borrar el stack: sus roles llevan boundaries del stack.
- AgentCore retiene las ENI de la red de packs durante horas.
- Quedan fuera del stack: log groups de AgentCore (2 por agente o versión de pack), de Lambda de los custom resources, de Container Insights, de flow logs; definiciones de tarea; llaves KMS a 30 días; el bucket de auditoría con Object Lock.

## 3. Destino de cada clave de configuración

Leyenda: **P** = parámetro de stack sin valor por defecto. **Pa** = parámetro avanzado, con valor por defecto. **R** = valor fijo de la release. **App** = se configura en la aplicación; la release solo siembra un valor inicial.

| Clave (`schema.ts`) | Hoy | Destino | Pantalla o endpoint | Qué falta |
|---|---|---|---|---|
| `namespace` | Horneado en todo nombre | **P** `Namespace` en las tres plantillas | n/a | Nombres con `Fn::Join`; validar con `AllowedPattern` |
| `installationType` | `lab` | **R** `customer` | Ajustes › Autenticación (lectura) | Quitar las ramas `lab` del código de la release |
| `region` | Literal | Fija por plantilla: `Core` se sintetiza una vez por región soportada (hoy `us-east-1`) | n/a | Las tablas DynamoDB con llave propia y los access logs del ALB no se pueden sintetizar sin región. Una regla de la plantilla rechaza otra región |
| `mangoAccountId` | Literal | `AWS::AccountId` en `Core`; **P** `MangoAccountId` en `Payer` y `OrgAccess` | n/a | n/a |
| `managementAccountId` | Literal | **P** `ManagementAccountId` en `Core` | Ajustes › Conectividad (lectura) | n/a |
| `organizationId` | Literal | **P** `OrganizationId` en las tres | Ídem | n/a |
| `availabilityZones` | Nombres | **Pa** `AvailabilityZoneIds` (por defecto `use1-az1,use1-az2`) | n/a | La VPC principal pasa a ids de zona, como la de packs. Los ids válidos por región van en un `Mapping` |
| `businessUnits` | Siembra | **App**, vacío al instalar | Ajustes › Áreas y OUs (existe, doble aprobación) | Nada |
| `accessGroups` | Siembra + grupos de Cognito | **App**; la release siembra solo los grupos de sistema | Ajustes › Grupos (existe; crea el grupo de Cognito) | Nada |
| `mfa` | Configurable | **R** `required` | Ajustes › Autenticación (lectura) | n/a |
| `auth.signUpDomains` | Entorno de la Lambda y `config.json` | **P** `SignUpDomains` (lista) | Ajustes › Autenticación (lectura) | Rechazar dominios públicos: hoy lo hace zod al sintetizar; pasa a la Lambda *pre sign-up* (lista cerrada en el código) |
| `auth.cognitoPlan` | Configurable | **R** `plus` | Lectura | n/a |
| `auth.highRiskAction` | Configurable | **Pa** `HighRiskSignInAction` (`NO_ACTION`) | Lectura | n/a |
| `auth.authEventsRetentionDays` | Configurable | **R** 365 días | n/a | No es parámetro: cfn-guard exige una retención literal en cada log group |
| `auth.aiPolicyUrl` | Opcional | **Pa** `AiPolicyUrl` (vacío) | Registro y Ajustes › Autenticación | `AllowedPattern` `https://…` |
| `users` | Recursos de Cognito por usuario | **P** `FirstAdminEmail`. Nada más | **No existe gestión de usuarios en la app** | Ver §3.1: es el hueco principal |
| `models.agent` | Horneado: hash del agente FinOps, entorno de `mango-api` | **R** (modelo por defecto de la release) + **App** | Catálogo de modelos (`/api/admin/models`, existe) | Nada para instalar |
| `models.auxiliary` | Horneado: IAM de `mango-api` por ARN exacto | **R** | No hay pantalla | Cambiarlo exige una release. Aceptable (parche) |
| `modelPrices` | Entorno y siembra | **R** como siembra + **App** | Catálogo de modelos (existe) | Nada |
| `budgets.*` | Entorno y siembra | **R** como siembra (USD 5 por usuario, USD 30 por agente) + **App** | Presupuestos (existe) | Nada |
| `retainData` | Configurable | **R** `true` | n/a | Ver N7 (§9): afecta desinstalar y reinstalar |
| `audit.retentionDays`, `audit.mode` | Configurable | **Pa** `AuditRetentionDays` (365) y `AuditLockMode` (`GOVERNANCE`) | n/a | `COMPLIANCE` no tiene vuelta atrás: documentarlo |
| `packs.signingPublicKey` | Solo laboratorio | **R**: llave pública del proveedor (§6) | n/a | Se elimina la clave de configuración |
| `packs.network.cidr` | Configurable | **Pa** `PackVpcCidr` (`10.210.0.0/22`) del stack `PackNetwork` | n/a | Subnets con `Fn::Cidr` |
| `packs.network.availabilityZoneIds` | Configurable | El mismo **Pa** `AvailabilityZoneIds` | n/a | Validar contra las zonas de AgentCore |
| `gateway.mcpSessions` | Configurable | **R** `true` | n/a | Se elimina la clave |
| `orgAccess.targets`, `excludedAccountIds` | Horneado en `OrgAccess` y en el entorno del AdminProbe | **P** en `OrgAccess`; en `Core`, **Pa** con los mismos valores | Ajustes › Conectividad › Cuentas miembro (existe) | Dato repetido en dos stacks (N10, §9) |
| `orgAccess.adminAccountId` | Horneado | **Pa** `CallAs` en `OrgAccess` (`SELF`) | n/a | n/a |
| `observability.transactionSearch` | Configurable | **Pa** `TransactionSearch` (`stack`) | n/a | `Condition` de CloudFormation |
| `alerts.emails` | Suscripciones por correo | **P** `AlertsEmail` (uno) | n/a | Más destinos: se suscriben al topic fuera del stack, como hoy |

Parámetros que ve quien instala `Core`: **6 obligatorios** (`Namespace`, `OrganizationId`, `ManagementAccountId`, `FirstAdminEmail`, `AlertsEmail`, `SignUpDomains`) y 9 con valor por defecto. `Payer`: 3. `OrgAccess`: 5. `PackNetwork`: 2 (`Namespace`, `OrganizationId`).

### 3.1 Hueco: gestión de usuarios

Hoy los usuarios y su pertenencia a grupos salen de `users` en la configuración. La aplicación no tiene dónde asignar una persona a un grupo (`group_admin.py` crea y borra grupos, no miembros; el diseño dice «los miembros se asignan en el directorio»).

Consecuencia para un cliente: tras instalar hay **un** admin. Las personas se registran solas (dominios de la empresa) y quedan sin rol. Darles un grupo exige la consola o la CLI de Cognito. Además, las acciones con doble aprobación (áreas, grupos, packs, MFA) necesitan un **segundo admin** desde el primer día.

No se inventa UI. Propuesta:

- **Ahora:** parámetro avanzado `SecondAdminEmail` (opcional) y el paso de la CLI de Cognito en el runbook, declarado como hallazgo.
- **Después:** brief para Claude Design, «Ajustes › Personas»: lista del directorio, asignar y quitar grupos (doble aprobación para `mango-admin`), invitar. Requiere su modelo de amenazas (toca la regla «sin revelar si un usuario existe» y la escalada a admin).

### 3.2 Otros huecos de UI (briefs, no se construyen aquí)

- Ajustes › General › «Modelos por defecto», «Notificaciones» y «Observabilidad»: hoy son «Próximamente». No bloquean la instalación.
- «Preparar desinstalación» (zona peligrosa): D21 dejó fuera de la app el redeploy y el borrado. Se mantiene fuera; la desinstalación va por CloudFormation y runbook (§8).

## 4. Plantillas independientes de la cuenta

1. **Stacks sin `env`.** `Core`, `PackNetwork`, `Payer` y `OrgAccess` se sintetizan una vez, con cuenta y región como pseudo-parámetros.
2. **Parámetros** definidos en un módulo único (`infra/lib/params.ts`) con `AllowedPattern` equivalentes a las reglas de zod actuales. `schema.ts` se reduce a la **configuración de la release** (versión, modelos y precios por defecto, presupuestos por defecto, regiones) y vive en el repo (`release.yaml` y `models/`), no en `infra/config/<env>.json`.
3. **`Rules` de CloudFormation** para lo que hoy valida zod entre claves: región soportada, cuenta de gestión distinta de la cuenta Mango, la cuenta Mango no puede ser objetivo de `OrgAccess`.
4. **Zonas:** subnets por `AvailabilityZoneId` en las dos VPC. Los ids admitidos por región (CloudFront VPC origins, AgentCore Runtime en VPC) en un `Mapping`.
5. **`Member`:** recibe `Namespace`, `MangoAccountId` y `OrganizationId` como parámetros del StackSet. El `TemplateBody` pasa a ser **idéntico para todos los clientes**, y su `sha256` es un dato de la release (va en el manifiesto).
6. **Primer admin:** un `AWS::Cognito::UserPoolUser` con `FirstAdminEmail` en `mango-admin` y `finops-central`. Cognito le envía la contraseña temporal; MFA obligatorio en el primer ingreso.
7. **Siembras** (`Settings`, agente FinOps): siguen siendo put-if-absent; cambian sus valores de «configuración del cliente» a «valores por defecto de la release».
8. **Versión visible:** descripción `(Mango) mango-hub vX.Y.Z · <stack>`, y un `Mapping` `Release` con versión, commit y digest de la imagen. `mango-api` la expone en `/api/health` y en el user-agent de los SDK. **Desde D69 (§13) la descripción no nombra la versión:** la etiqueta solo viaja en `MANGO_RELEASE` (Ajustes › Instalación) y en el manifiesto.
9. **Tamaño:** test que falla si `Core` supera 800 KB o 450 recursos.
10. **Sin `AWS::LanguageExtensions`.** Por eso `DeletionPolicy` no puede depender de un parámetro (N7, §9).

Lo que **no** cambia: la arquitectura de `Core`, los nombres `Mango-<ns>-…`, las excepciones de seguridad ya acordadas.

## 5. Cómo llega la release a la cuenta del cliente

**Decidido por el usuario (2026-10-03): «como Innovation Sandbox».** El cliente solo hace `CreateStack` («Launch stack») con la URL de una plantilla y sus parámetros. Plantillas y assets están en buckets de S3 **del proveedor**, versionados e inmutables.

La cuenta de AWS del proveedor existe, pero **fuera de la organización del laboratorio**, que simula a un cliente. La crea el usuario; aquí es un parámetro del pipeline (`providerAccountId`, nombre de bucket, repositorio). Nada del proveedor vive en las cuentas del cliente.

### 5.1 Opciones descartadas y por qué

| | (a) bedrock-chat | (b) Innovation Sandbox: **elegida** | (c) Híbrido |
|---|---|---|---|
| Qué hace el cliente | Un comando en CloudShell | «Launch stack» o `CreateStack` con una URL | Un comando en CloudShell |
| Qué pasa en su cuenta | CodeBuild clona GitHub y hace `cdk bootstrap` + `cdk deploy` | CloudFormation lee plantillas y assets del proveedor | Un script descarga la release de GitHub, crea bucket y ECR en la cuenta del cliente, copia y hace `CreateStack` |
| Se compila en la cuenta del cliente | Sí | No | No |
| Infraestructura del proveedor en AWS | Ninguna | Buckets, ECR, rol de publicación | Ninguna |
| Lo que se instala es lo que se probó | No: cada instalación construye de nuevo | Sí | Sí |

- **(a) descartada:** contradice D9, D25 y las reglas 1 y 2 (CodeBuild, `cdk deploy`, bootstrap y un rol de despliegue amplio en la cuenta del cliente). Cada instalación resuelve dependencias y compila otra vez: lo instalado no es lo probado.
- **(c) descartada:** cumple las reglas, pero no hay «Launch stack»: el cliente ejecuta un script con sus credenciales, hay que resolver la descarga desde un repo privado y la subida de la imagen desde CloudShell, y actualizar repite la copia. (b) deja la instalación en una sola llamada a CloudFormation.

### 5.2 Cuenta del proveedor

Stack propio `Mango-provider` (`infra/lib/stacks/provider-stack.ts`, guía en `deployment/provider/README.md`; **no** va a los clientes), instalado una vez en la cuenta del proveedor:

| Recurso | Reglas |
|---|---|
| Bucket global de plantillas `<nombre>` | Versionado, Object Lock, cifrado, TLS obligatorio. Clave `mango/<versión>/<Stack>.template.json` |
| Bucket regional de assets `<nombre>-<región>`, uno por región soportada (hoy `us-east-1`) | Ídem. Clave `mango/assets/<hash>.zip`, la misma para todas las versiones (D69, §13; hasta el 2026-10-05, `mango/<versión>/<hash>.zip`). Lambda exige que el bucket esté en la región de la función |
| Repositorio de la imagen | Ver §5.4 |
| Proveedor OIDC de GitHub y rol `Mango-provider-release-publisher` | Confianza solo en este repo, rama `main` y entorno `release`. Permisos: `s3:PutObject` en `mango/*` de esos buckets, `s3:GetObject` en `mango/assets/*` del regional (D69: compara un asset que ya existe), subir al repositorio de la imagen y `kms:Sign` para el manifiesto. **No puede borrar ni cambiar políticas** |
| Política de los buckets | Escritura: solo el rol de publicación y solo con `If-None-Match: *` (una clave publicada no se sobrescribe). Lectura: §5.3 |
| Lista de clientes | Parámetro de la plantilla (ids de organización). Añadir un cliente es un `UpdateStack` en la cuenta del proveedor |
| Alarmas | Regla de EventBridge sobre cambios de política de los buckets, del repositorio y del rol, a un topic del proveedor |

La llave de firma de packs y del manifiesto, su rol OIDC y sus alertas también van en esta plantilla (§6).

### 5.3 Quién puede leer plantillas y assets

**Con qué identidad se lee.** No hay un rol de servicio de CloudFormation que lea por su cuenta:

- `TemplateURL`: CloudFormation descarga la plantilla **con las credenciales de quien llama a `CreateStack`** (la persona en la consola, o su rol). Vale también para el enlace «Launch stack».
- Código de Lambda (`Code.S3Bucket`): Lambda lo copia con las credenciales con las que CloudFormation crea la función (quien llama, o el rol de servicio del stack si se pasó uno).
- `BucketDeployment` (SPA y packs): lee el rol de su Lambda, que es de la cuenta Mango del cliente.
- StackSet `Member`: no lee nada; su plantilla va inline.

Todas son identidades de la organización del cliente. Por eso la condición natural es `aws:PrincipalOrgID`.

| | Bucket público de solo lectura (AWS Solutions) | Lectura por organización del cliente | Lectura por cuenta |
|---|---|---|---|
| Qué expone | Todo el producto a cualquiera: Lambdas, SPA y packs son el código | Solo a principales de las organizaciones listadas | Solo a las cuentas listadas |
| Operación | Ninguna | Añadir el id de organización de cada cliente | Añadir dos cuentas por cliente (gestión y Mango), y cada cuenta nueva |
| «Launch stack» | Funciona para cualquiera | Funciona para quien esté en una organización listada | Ídem, por cuenta |
| Coherencia con un repo privado | No | Sí | Sí |
| Riesgo propio | Enumeración y descarga masiva | Un cliente dado de baja sigue leyendo hasta que se quite de la lista | Lista más larga y más fácil de dejar desactualizada |

**Decidido: por organización** (`s3:GetObject` con `aws:PrincipalOrgID` en la lista de clientes, sin `ListBucket`). El cliente ya entrega su id de organización como parámetro. Si el producto pasa a distribuirse abiertamente, cambiar a público es quitar la condición.

### 5.4 Imagen de `mango-api`

| | ECR Public (ISB) | ECR privado del proveedor | ghcr.io |
|---|---|---|---|
| Quién puede descargarla | Cualquiera | Las organizaciones listadas (política de repositorio con `aws:PrincipalOrgID`) | Privado: quien tenga un token de GitHub |
| Qué necesita la cuenta del cliente | Nada | Permiso de pull en el rol de ejecución de la tarea, sobre ese repositorio | Un token del proveedor, de larga vida, en Secrets Manager de cada cliente |
| Regiones | Global | Regional: replicación de ECR a cada región soportada | Global |
| Dependencia al arrancar tareas | ECR Public | ECR del proveedor | GitHub |
| Coherencia con un repo privado | No: la imagen lleva el código Python | Sí | Sí, pagando el secreto |

**Decidido: ECR privado del proveedor**, por digest: `<providerAccountId>.dkr.ecr.${AWS::Region}.amazonaws.com/mango/api@sha256:…`. Tags inmutables y escaneo al subir. ghcr.io se descarta: mete un secreto del proveedor en cada cliente. ECR Public queda para el día en que la lectura sea pública.

Consecuencia: `mango-api` depende del ECR del proveedor cada vez que ECS arranca una tarea nueva. Si el proveedor borra la imagen o quita al cliente de la lista, las tareas en marcha siguen pero no se reemplazan. Mitigación: tags inmutables, el rol de publicación no borra, y parámetro avanzado `ApiImageRepository` para el cliente que quiera copiarla a su ECR.

### 5.5 Synthesizer y plantillas

`MangoReleaseSynthesizer`, subclase de `DefaultStackSynthesizer`, como el de ISB:

- `fileAssetsBucketName: "<nombre>-${AWS::Region}"`, `bucketPrefix: "mango/assets/"` (D69, §13; antes `mango/<versión>/`).
- `generateBootstrapVersionRule: false`; sin roles de bootstrap.
- Los assets de directorio se comprimen al sintetizar, de forma determinista.
- El nombre del bucket, la cuenta del proveedor y la versión son contexto de CDK (parámetros del pipeline), y quedan en un `Mapping` de la plantilla.
- Desaparece `ContainerImage.fromAsset`: la imagen se referencia por digest.
- Sin modo dual (N6, §9): los tests sintetizan con un bucket de mentira.

### 5.6 `mise run dist` y publicación

**`mise run dist`** construye; con `--publish` además sube, contra el bucket indicado (`MANGO_DIST_BUCKET`, `MANGO_PROVIDER_ACCOUNT`):

1. Comprueba el árbol limpio y la versión de `release.yaml`.
2. Construye la SPA y los zips de Lambda (como hoy).
3. Verifica los packs firmados de `dist/packs` (§6).
4. Construye la imagen (`docker buildx`, linux/arm64) y calcula su digest.
5. `cdk synth` con el synthesizer de release → `dist/release/<versión>/` (`global-s3-assets/`, `regional-s3-assets/`).
6. cdk-nag, cfn-guard y Checkov sobre **esas** plantillas.
7. Escribe `manifest.json`: versión, commit, sha256 y tamaño de cada plantilla y asset, digest de la imagen, sha256 del `TemplateBody` de `Member`, regiones.
8. Con `--publish`: sube la imagen y comprueba el digest remoto; sube assets y plantillas con `If-None-Match`; sube el manifiesto y su firma al final. Un asset cuya clave ya existe no se sube: se compara su sha256 con el construido y, si difiere, la publicación termina sin subir plantillas ni manifiesto (D69, §13).

**Workflow `release.yml`** (GitHub Actions, al crear el tag en `main`): un job construye sin credenciales de AWS; otro, con el entorno `release`, asume `Mango-provider-release-publisher` por OIDC, firma el manifiesto con la llave KMS y publica. El job con credenciales no ejecuta código de terceros, como el de firma de packs.

En local, `--publish` usa las credenciales de quien lo corre: sirve para el laboratorio antes de que exista el workflow. Las releases para clientes salen solo del workflow.

### 5.7 Instalar y actualizar

Las notas de cada release dan tres enlaces «Launch stack» y sus URL:

```
1. Cuenta de gestión:  Mango-<ns>-Payer        https://<nombre>.s3.amazonaws.com/mango/vX.Y.Z/Payer.template.json      (3 parámetros)
2. Cuenta de gestión:  Mango-<ns>-OrgAccess    …/OrgAccess.template.json    (5 parámetros; opcional)
3. Cuenta Mango:       Mango-<ns>-PackNetwork  …/PackNetwork.template.json  (2 parámetros)
4. Cuenta Mango:       Mango-<ns>-Core         …/Core.template.json         (6 parámetros)
```

`Core` importa de `PackNetwork` (misma cuenta) las subnets y los security groups de los packs: `PackNetwork` va antes. Entre cuentas ningún stack lee a otro. Actualizar es `UpdateStack` con la URL de la versión nueva y los parámetros anteriores. Nunca hay un alias `latest`: siempre una versión concreta (§4.12).

`docs/runbooks/poc-deploy.md` se reemplaza por `docs/runbooks/install.md`, escrito para un cliente.

### 5.8 Verificación de integridad

- **Plantillas:** `manifest.json`, firmado con la llave KMS del proveedor (§6), lista su sha256. `deployment/verify-release.sh <versión>` descarga manifiesto y plantillas, verifica la firma con la llave pública del repo y compara hashes. El runbook lo pone antes de `CreateStack`.
- **Assets:** claves inmutables (`If-None-Match` + Object Lock) y el rol de publicación sin permiso de borrar; el manifiesto lista sus sha256 para auditoría. Las claves se comparten entre versiones (D69): al publicar, cada una se sube nueva o se comprueba que ya tiene esos bytes.
- **Imagen:** por digest (direccionada por contenido).
- **Packs:** además, el provisioner verifica firma y hash al habilitar (D43).
- **Cliente que no permite buckets externos:** copia la release a un bucket propio (`aws s3 sync`) e instala desde ahí; el manifiesto firmado sigue valiendo. Exige que el nombre del bucket de assets sea un parámetro avanzado (`ReleaseBucketPrefix`) con el del proveedor por defecto.

## 6. Firma de packs y del manifiesto: llave KMS en la cuenta del proveedor

**Decidido por el usuario el 2026-10-03: no se firma sin llave.** Como habrá cuenta de AWS del proveedor, se mantiene D36 tal como está escrita: llave asimétrica de KMS en la cuenta del proveedor, llave pública en la plantilla, verificación sin salir a internet. Nada queda en registros públicos.

### 6.1 Por qué no la firma sin llave (queda descartada)

- **Attestations nativas de GitHub:** en planes Free, Pro y Team solo están disponibles para repos públicos; en repos privados exigen Enterprise Cloud (documentación de GitHub). El repo es privado y de una cuenta personal.
- **Sigstore público (cosign sin llave):** funciona desde un repo privado, pero publica para siempre en el registro de transparencia el certificado de firma (nombre del repo, ruta y rama del workflow, SHA del commit, id de la ejecución) y el hash de lo firmado. No tiene vuelta atrás.
- Con una cuenta del proveedor, la llave KMS ya tiene dónde vivir y el código de firma y verificación actual se reutiliza sin cambios.

### 6.2 Diseño

- **La llave y el rol se mudan** de la cuenta de gestión del laboratorio (que ahora es la de un cliente) a la cuenta del proveedor, dentro de su plantilla (`deployment/provider/`): llave ECC P-256 de firma, rol OIDC `Mango-provider-pack-signing` que solo confía en este repo y el entorno `pack-signing`, y las reglas de alerta sobre uso indebido y cambios del rol.
- KMS no exporta llaves privadas: es una **llave nueva**. `packs/signing-key.pub` cambia y los tres packs se firman de nuevo. No hay instalaciones que migrar: el laboratorio está vacío.
- **Sin cambios de código** en `deployment/pack-builder` (`kms.py`), `mango_packs.signing`, `infra/lib/config/pack-release.ts`, el provisioner ni `mango-api`. Cambia la configuración de GitHub del job de firma. Desde el 2026-10-05 (D59 (6)) es el secreto `PACK_SIGNING_ROLE_ARN` del entorno `pack-signing`, no una variable del repositorio (los logs de un repositorio público son públicos y Actions imprime las variables), y la llave se nombra por su alias.
- **El manifiesto de la release se firma con la misma llave**, con el mismo formato de sobre y otro `payload_type` (`application/vnd.mango.release.v1+json`), para que una firma de pack no valga como firma de manifiesto ni al revés. Lo firma el workflow `release.yml` con un rol aparte (`Mango-provider-release-publisher`) que puede `kms:Sign` y publicar; el rol de firma de packs no puede publicar.
- **Verificación:** como hoy (síntesis, provisioner de packs, `mango-api`), más `verify-release.sh` para el manifiesto, con `openssl` y la llave pública del repo.
- Se elimina `packs.signingPublicKey` de la configuración: una instalación solo confía en la llave de la release.

### 6.3 Migración y borrado

1. Crear la cuenta del proveedor e instalar su plantilla (usuario).
2. Guardar la llave pública nueva en `packs/signing-key.pub`, actualizar la configuración de GitHub (secretos del entorno, D59 (6)) y firmar los tres packs con `packs.yml`.
3. Borrar en la cuenta de gestión del laboratorio, creados a mano, sin stack. **Solo con la orden del usuario**, cuando una release firmada con la llave nueva esté verificada:
   - llave KMS `alias/mango-pack-signing`: programar borrado a 7 días y quitar el alias;
   - rol `Mango-pack-signing` y su política inline `pack-signing`;
   - reglas de EventBridge `Mango-pack-signing-misuse` y `Mango-pack-signing-role-change`;
   - topic `Mango-pack-signing-alerts`;
   - proveedor OIDC `token.actions.githubusercontent.com`: es el único de la cuenta y solo lo usa ese rol.
4. Actualizar `packs/README.md` y `mcp-pack-pipeline-threat-model.md` (dónde vive la llave).

## 7. El laboratorio como cliente

- La organización del laboratorio es la de un cliente: cuenta de gestión y una cuenta miembro (sandbox) donde va Mango. Nada del proveedor vive ahí. Su id de organización es el primero de la lista de clientes de la cuenta del proveedor.
- `infra/config/poc.json` desaparece. Los parámetros del laboratorio van en `~/.config/mango/lab/params-<stack>.json`.
- Usuarios e2e: se crean después de instalar con un script del laboratorio (`AdminCreateUser` + grupos), no con la plantilla.
- `gmail.com` deja de valer como dominio de registro (regla de cliente). El laboratorio necesita un dominio propio o crear sus usuarios solo por `AdminCreateUser`, que no pasa por el filtro (D28).
- MFA obligatorio: las pruebas e2e necesitan TOTP automatizado (secreto guardado en `~/.config/mango/lab/`).

## 8. Desinstalación

### 8.1 Recurso `UninstallGuard` (parte del stack)

Un custom resource de `Core` cuyo `Delete` corre **antes** que el de todo lo demás del stack: depende de todos los otros recursos, se crea el último y se borra el primero (2026-10-08, D58 (16); hasta entonces dependía solo de los boundaries, el Gateway, el motor de políticas y las alertas):

1. Borra todo harness `Mango_<ns>_a_*` (endpoint primero), su identidad de workload y su rol `Mango-<ns>-agent-*`. Incluye al agente de la release.
2. Borra todo target de pack del Gateway, Runtime `Mango_<ns>_mcp_*` y rol `Mango-<ns>-mcp-*`.
   - Los roles van al final, cada uno con sus políticas en línea y sus políticas adjuntas quitadas antes (D58 (22)).
3. Borra los log groups `/aws/bedrock-agentcore/runtimes/*Mango_<ns>_*`.

Reglas:

- Reutiliza el código del deprovisioner (`functions/provisioner`), con un rol propio que solo borra y solo por prefijo de namespace.
- **Solo actúa si el stack está en `DELETE_IN_PROGRESS`** (lo comprueba con `DescribeStacks`). Un `Delete` causado por un reemplazo del recurso en un `UpdateStack` no borra nada. Su id físico es fijo y no tiene propiedades que cambien entre releases.
- Solo lo invoca CloudFormation.
- **Las políticas de packs (2026-10-07, D58 (13)):** el paso 2 borra también la política Cedar de cada pack (`Mango_<ns>_mcp_*`). AgentCore autoriza ese borrado contra el motor de políticas, contra la política y contra el Gateway al que está ligada: el rol lleva `bedrock-agentcore:ManageResourceScopedPolicy` sobre el Gateway, sin `GetGateway` ni `InvokeGateway`. Sin ese permiso el guard fallaba y `Core` quedaba a medio borrar (visto en una instalación de laboratorio).
- Si una llamada falla, responde a CloudFormation con la operación y el código del error, sin argumentos ni identificadores.
- **Las políticas adjuntas a un rol (2026-10-09, D58 (22), decidido por el dueño).** IAM no borra un rol que tiene una política administrada adjunta, y alguien puede adjuntarla después de que el provisioner creara el rol: un administrador, a mano, o una organización que adjunta una a todos los roles. Visto el 2026-10-08: el guard tomaba el `DeleteConflict` por «ocupado», agotaba su hora y no decía la causa.
  - Antes de borrar un rol, el guard borra sus políticas en línea, lista sus políticas adjuntas y las desadjunta, y borra el rol. En ese orden.
  - Solo en los roles que barre: prefijo de nombre de la instalación **y** uno de sus dos permissions boundaries. De un rol sin ese boundary no lista ni quita nada.
  - Al retirar un agente rige otra cosa: el deprovisioner no borra un rol con políticas gestionadas y lo deja para una persona (D48 (3)). El dueño confirmó la diferencia el 2026-10-09: el stack no puede borrarse mientras exista un rol con su boundary, y quien desinstala quiere que no quede nada.
  - Su rol gana dos acciones sobre los mismos ARNs de roles de agentes y de packs: `iam:ListAttachedRolePolicies` (nombres y ARNs, nunca el contenido de una política) e `iam:DetachRolePolicy`, esta con la misma condición `iam:PermissionsBoundary` que `DeleteRole`. La referencia de autorización de AWS dice que la acción admite esa clave (comprobado el 2026-10-09). No puede adjuntar ni escribir políticas.
  - Una política que otro ya quitó no es un error. Un permiso negado al desadjuntar es un fallo como los demás: «Uninstall guard failed (DetachRolePolicy: AccessDenied). …».
  - **Un rol que sigue sin poder borrarse (propuesto por un agente y aceptado por el dueño el 2026-10-09).** Con sus políticas quitadas, a un rol solo lo retiene algo que el guard no puede ver ni quitar, como un instance profile. Si `DeleteRole` responde `DeleteConflict` en tres pasadas seguidas, el guard responde `FAILED` y lo dice («… 1 role(s) of agents or packs cannot be deleted with their policies removed: something else holds them, such as an instance profile. …»), en vez de esperar su hora. Sin permisos nuevos: dice cuántos roles, no cuáles ni qué los retiene. El guard no lo quita: la salida es a mano (runbook).
  - **Qué registra (propuesto por un agente y aceptado por el dueño el 2026-10-09).** Cuentas: `uninstall_guard roles: detached_policies=<n> held=<n>`. Nunca el nombre de un rol ni el nombre o el ARN de una política.
  - Límites: una política que algo vuelve a adjuntar acaba en ese mismo fallo temprano; si el guard falla después de quitarle las políticas a un rol, el rol queda sin ellas (como ya quedaba sin sus políticas en línea).
- **Lo que ya se está borrando no se vuelve a pedir (2026-10-09, D58 (22), decidido por el dueño).** El guard mira el estado antes de pedir un borrado: un endpoint, un target, una política y, desde ese día, un Runtime de pack o un harness en `DELETING` se saltan en esa pasada y siguen contando como pendientes. Visto el 2026-10-08: repetía `DeleteAgentRuntime` en cada pasada. Sin permisos nuevos: el estado viene en los listados que ya leía.
- Los dos cambios, comprobados con tests y síntesis. El 2026-10-09 se vio su change set en una instalación de laboratorio que se actualizó a la versión que los trae (D58 (23)): la política del rol del guard llegó como un `Modify` sin reemplazo, con sus dos acciones, y el recurso del guard no tuvo ningún evento. **Sin ver en AWS:** el guard quitando una política, el fallo temprano y el salto de lo que está `DELETING`.
- **Un fallo deja la instalación en pie (2026-10-08, D58 (16), decidido por el dueño).** CloudFormation no borra aquello de lo que depende un recurso que falló al borrarse. Como el guard depende de todo lo demás, si falla el stack queda en `DELETE_FAILED` sin haber borrado nada más: la aplicación, los provisioners, el directorio y las alarmas siguen. Se arregla la causa y se repite el `delete-stack`.
  - La dependencia la añade un aspecto de CDK al sintetizar, no una lista: un recurso nuevo entra solo, y un test falla si alguno queda fuera.
  - Los cinco recursos con condición (segundo administrador, Transaction Search) no pueden ir en ese `DependsOn`: CloudFormation rechaza la plantilla si nombra un recurso que su condición deja sin crear (visto el 2026-10-08 con un stack de prueba). Los sujeta **el ancla** (D58 (17), decidido por el dueño el 2026-10-08): un `AWS::CloudFormation::WaitConditionHandle` sin condición ni propiedades, que no crea nada, cuyo `Metadata` nombra cada uno dentro de `Fn::If` con su condición. El guard depende del ancla; el mismo aspecto la rellena, y un test falla si un recurso condicional queda fuera. El guard sigue sin propiedades propias. Mecanismo probado en AWS con stacks de relleno: con el guard fallando, el condicional anclado sobrevivió.
  - El mensaje dice que el resto del stack no se borró y qué hacer: ante un permiso denegado, que repetir falla igual hasta dar esa operación a su rol; ante un fallo del servicio o de la red, que se repita; ante otro, que se mire antes el log.
  - **El buzón de alertas también se entera (2026-10-08, D58 (19), decidido por el dueño).** Tras responder `FAILED`, la función cuenta 1 en una métrica propia escrita en su log (`Mango/UninstallGuard`, `DeletionFailed`) y la alarma `UninstallGuard-deletion-failed` la lleva al topic de alertas. Sin permisos nuevos: no publica ni llama a CloudWatch. **Visto en una cuenta de ensayo el 2026-10-08 (D58 (20)):** con el fallo provocado dos veces, la alarma saltó alrededor de minuto y medio después y el correo llegó con la suscripción confirmada; el aviso publicado con la suscripción pendiente se perdió. Avisa una vez por episodio, no por intento: la alarma se queda 15 minutos en `ALARM` y CloudWatch solo avisa al cambiar de estado. En una instalación de laboratorio con datos que se actualizó ese día a esa versión, el change set trajo la alarma como único `Add` y el rol del guard quedó igual. **Un segundo ensayo de ese día, con un pack habilitado (D58 (21)),** mostró lo que faltaba. Un fallo con un pack: `DELETE_FAILED` a los 11 s con la instalación en pie; el guard ya había borrado el target y la política del pack, y el catálogo lo seguía mostrando habilitado. Un segundo y un tercer fallo dentro del episodio no mandaron otro aviso; la alarma volvió a `OK` 25 minutos después de saltar, unos 15 después del último. El guard que agota su hora responde `FAILED` (a los 53 min 5 s) y avisa por esta misma alarma. El que no llega a responder es otro caso: avisa `UninstallGuard-failed` (a los 6 min 14 s) y CloudFormation espera 60 min 21 s. Un rol con una política administrada adjunta, que el guard de esa versión no puede quitar, le hace agotar su hora: el dueño decidió el 2026-10-09 que el guard la quite (D58 (22), arriba); con una versión anterior la salida es a mano y está en el runbook. Sin ver en una instalación: un fallo pasajero.
  - En el camino bueno el barrido corre antes que el resto, no a la vez: la aplicación sigue respondiendo mientras dura.
  - Comprobado con tests y síntesis. **Visto en una instalación el 2026-10-08** (D58 (18)), con `v0.1.0-g6f9b8e4` instalada desde cero y el fallo provocado dos veces: `DELETE_FAILED` a los 11 s (antes de borrar nada) y a los 317 s (a medio barrido, con el harness del agente ya borrado), con un solo recurso fallido y nada más del stack borrado, tampoco los cinco recursos con condición. El mensaje dijo la operación, el código y qué hacer. Arreglada la causa, el borrado terminó en 18 min 4 s y ningún otro recurso empezó a borrarse antes de que el guard terminara; el camino completo, unos 23 minutos, como antes del cambio.
  - Lo que el fallo a medio barrido enseñó: la aplicación siguió listando el agente cuyo harness ya no existía, y la comprobación de solo lectura pasó (D75 (9)). Y ninguna alarma saltó con los fallos: el guard responde a CloudFormation y no deja nada en su cola de errores (esa versión no traía la alarma de D58 (19): arriba).
  - En una instalación que se actualiza a esa versión, el recurso del guard tiene un único evento `UPDATE_COMPLETE` (CloudFormation guarda su `DependsOn` nuevo) y su función no se invoca: visto el 2026-10-08.
  - Sin ver: un fallo con packs habilitados y este orden, un fallo pasajero y el agotamiento de la hora.

### 8.2 Red de packs en un stack propio (usuario, 2026-10-03)

AgentCore puede tardar horas en soltar las ENI. Para que `Core` se borre limpio, la red de packs (VPC, subnets, endpoints, security group por pack, DNS Firewall, flow logs) pasa al stack **`Mango-<ns>-PackNetwork`**, en la cuenta Mango.

- Exporta las subnets y el security group de cada pack (`Mango-<ns>-PackNetwork-…`); `Core` los importa con `Fn::ImportValue`. CloudFormation impide borrar `PackNetwork` mientras `Core` exista: el orden de borrado queda forzado.
- Sale de los manifiestos firmados de la release, como hoy (D54). No tiene assets ni Lambdas.
- Desinstalar: `Core` primero (el guard borra Runtimes y roles). Luego `PackNetwork`: si las ENI siguen, falla solo ese stack y se repite el `delete-stack` más tarde. Medido dos veces (2026-10-07 y 2026-10-08, D58 (15)): el primer borrado falla a los 19 minutos, AgentCore suelta las ENI unas 8 horas después de borrarse el Runtime del pack y el segundo borrado tarda segundos. Mientras espera no cuesta nada: los endpoints ya se borraron.
- Actualizar a una release con un pack nuevo: `PackNetwork` antes que `Core`. Con un pack retirado: `Core` antes. Las notas de la release lo dicen.
- El guard ya no espera a las ENI.

### 8.3 Otros arreglos

- **Agente de la release:** «retirar» deja de ser un no-op en el deprovisioner; borra harness y rol como en cualquier agente (N9, §9).
- **Log groups de AgentCore:** el deprovisioner y el provisioner de packs los borran al retirar o deshabilitar.
- **Llaves KMS:** `PendingWindowInDays: 7`.
- **Almacén de políticas de Verified Permissions (2026-10-07, D58 (14)):** sin protección de borrado. Solo guarda el esquema y las políticas de la plantilla; con protección, `Core` fallaba siempre su primer borrado.
- **Flow logs:** misma política de borrado que el resto de los logs.

### 8.4 Datos retenidos

Con `RETAIN` (clientes) quedan: 8 tablas, user pool, bucket de auditoría (Object Lock), buckets de logs y packs, llaves KMS (sin alias: los alias se borran con los stacks) y log groups. **Reinstalar con el mismo namespace falla** mientras existan, porque los nombres son fijos.

`purge-retained.sh <namespace>` (publicado con la release) los lista y, con `--confirm`, los borra. Se niega mientras exista `Core` o `PackNetwork`, y también si no puede comprobar que no existen. Al borrar: quita la protección de borrado, vacía buckets (con bypass de governance solo donde hay Object Lock) y programa a 7 días las llaves que llevan la etiqueta `mango:namespace` de la instalación. En modo `COMPLIANCE` el bucket de auditoría no se puede vaciar hasta que venza la retención: el script lo dice, sigue con lo demás y termina con error, como cada vez que algo de lo listado no se pudo borrar. No toca las llaves que el stack ya dejó en espera de borrado, los log groups `aws/spans` y `/aws/application-signals/data` ni las revisiones inactivas de la task definition, y lo dice en la lista (D58 (12), (15); el detalle, en `docs/runbooks/install.md`, paso 5).

**Lo que no es de la instalación y queda en la cuenta (2026-10-08, D58 (15)).** Transaction Search se revierte al borrar `Core`. CloudWatch Application Signals, que se activa con él, no: sigue activo para toda la cuenta, con su log group `/aws/application-signals/data`, sin retención. La purga lo nombra y no lo borra; la documentación de AWS no dice cómo se apaga en una cuenta. Quedan también `aws/spans` (30 días) y los roles vinculados a servicios que creó la instalación.

**Visto en una instalación (2026-10-08).** La purga, con `--confirm`, en dos instalaciones de laboratorio ya desinstaladas: 89 segundos cada una, sin error y sin dejar nada de lo que listó.

Orden de desinstalación: `Core` → `PackNetwork` → `purge-retained.sh` (si se quiere borrar los datos) → `OrgAccess` → `Payer`.

## 9. Decisiones (usuario, 2026-10-03)

Para registrar en §8 de la arquitectura:

| # | Decisión |
|---|---|
| N1 | **Parámetros mínimos + aplicación:** `Core` pide 6 parámetros; el resto son valores de la release o configuración de la app. Una plantilla para todos los clientes. La tabla de §3 es el reparto |
| N2 | **Distribución como Innovation Sandbox:** plantillas en un bucket global y assets en buckets regionales de una cuenta de AWS del proveedor, fuera de la organización del cliente; claves inmutables; publica GitHub Actions por OIDC. Confirma y precisa D8. Se descartan el instalador con CodeBuild (bedrock-chat) y la copia a un bucket del cliente como camino normal |
| N3 | **Lectura por organización del cliente** (`aws:PrincipalOrgID`), en buckets y en el ECR privado del proveedor; imagen por digest |
| N4 | **Firma con KMS en la cuenta del proveedor** (se mantiene D36): la llave y el rol de firma de packs se mudan de la cuenta de gestión a la del proveedor; llave nueva y packs firmados de nuevo. El manifiesto de la release se firma con la misma llave. Se descarta la firma sin llave: publica metadatos del repo en un registro público |
| N5 | **`installationType: customer` es el único tipo que se publica.** El laboratorio se instala igual que un cliente. Retira las excepciones de laboratorio de D14, D20 y D28 (`mfa: off`, Essentials, `gmail.com`) |
| N6 | **Sin modo dual del synthesizer:** todo se instala desde la release; no hay `cdk deploy` de desarrollo. **Ajusta §4.9**, que pedía modo dual |
| N7 | **Datos:** siempre `RETAIN`; una sola plantilla (regla 8); `purge-retained.sh` para borrar lo retenido |
| N8 | **Red de packs en un stack propio** `Mango-<ns>-PackNetwork`, que `Core` importa. Precisa D54 |
| N9 | **`UninstallGuard`:** `Core` limpia lo creado por API al borrarse. **Retirar el agente de la release** borra su harness y su rol, como cualquier agente. Precisa D25, D34 y D48 |
| N10 | **Objetivos de `OrgAccess`** repetidos como parámetro de `Core`, para la prueba de cuentas miembro |
| N11 | **Segundo admin:** parámetro opcional `SecondAdminEmail` hasta que exista la gestión de personas en la app |
| N12 | **Presupuestos por defecto de la release:** USD 5 por usuario y USD 30 por agente; el admin los cambia en Presupuestos |

## 10. Plan por pasos

Tamaños: S (días), M (una a dos semanas), L (más de dos semanas).

| # | Paso | Tamaño | Depende de |
|---|---|---|---|
| 1 | Configuración de la release separada de los parámetros: `params.ts`, `schema.ts` reducido, `release.yaml` y `models/` con modelos, precios y presupuestos por defecto | M | n/a |
| 2 | `Payer`, `Member` y `OrgAccess` con parámetros (plantillas pequeñas; sirven de ensayo) | S | 1 |
| 3 | `Core` sin `env`: namespace, cuenta, organización y zonas como parámetros o pseudo-parámetros; primer admin; siembras con valores de la release; `Rules`; supresiones de cdk-nag, guard y Checkov rehechas sin literales | L | 1 |
| 4 | Synthesizer de release, imagen por digest, `mise run dist`, manifiesto, tests de consistencia y de tamaño | M | 3 |
| 5 | Cuenta del proveedor: plantilla `deployment/provider/`, `dist --publish`, workflow `release.yml` con firma del manifiesto, `verify-release.sh`, `docs/runbooks/install.md` | M | 4; que el usuario cree la cuenta |
| 6 | Stack `PackNetwork` separado de `Core` (exports e imports) | S | 3 |
| 7 | `UninstallGuard`, retiro del agente de la release, log groups de AgentCore, ventana de KMS, `purge-retained.sh` | M | 3 |
| 8 | Laboratorio como cliente: parámetros, usuarios e2e, TOTP en las pruebas | M | 3 |
| 9 | Firma en la cuenta del proveedor: llave y rol en `deployment/provider/`, llave pública nueva, firmar de nuevo los tres packs, firma del manifiesto | S | 5 |
| 10 | Borrar la firma vieja de la cuenta de gestión (con orden del usuario) | S | 9 verificado |

Los pasos 6 y 7 no dependen de 4 ni de 5. Los pasos 5, 9 y 10 necesitan la cuenta del proveedor. Después (fuera de este trabajo): parte 2 de la prueba «one-click», brief de «Personas», un stack por pack (ola 0.3).

Skills por paso: `security-best-practices` donde se toque FastAPI (8); `security-audit` en modo guía sobre el diff de IAM, trusts y firma (2, 3, 5, 6, 7, 9).

## 11. Lo que no se verificó

Sale de documentación o del código, no de una prueba.

1. Que el enlace «Launch stack» de la consola acepte una `templateURL` de un bucket no público. Por API funciona.
2. Cómo se comporta la importación de la red de packs al añadir o quitar un pack entre releases (la importación en sí funciona).
4. Cuánto tardan de verdad las ENI de AgentCore en soltarse: se vieron 8–9 h una vez. (Medido dos veces más, el 2026-10-07 y el 2026-10-08: unas 8 horas desde que se borra el Runtime del pack; §8.2.)
5. Que el `UninstallGuard` termine dentro de la hora de un custom resource con muchos agentes y packs. Con dos agentes y un pack tardó unos 9 minutos (2026-10-07, con el permiso de D58 (13) puesto a mano); la plantilla que ya lo trae no se ha visto en una instalación. (Vista el 2026-10-07 con `v0.1.0-g5c86ad2`, con dos agentes y un pack: `Core` se borró a la primera en 23 min 34 s. Con muchos agentes y packs sigue sin verse. El 2026-10-08, con el orden de D58 (16) y un agente sin packs: 5 min 17 s en borrar el harness. Ese día se vio también al guard agotar su hora, provocado con un rol que no podía borrar: respondió `FAILED` a los 53 min 5 s, tras cuatro invocaciones, dentro de la hora del custom resource (D58 (21)).)
6. Habilitar un pack y chatear con el agente en la instalación hecha desde la release: faltan los usuarios de prueba con MFA (paso 8).
7. `PackVpcCidr` como parámetro (`Fn::Cidr`): hoy el rango de la red de packs es un valor fijo de la release.
8. El workflow `release.yml`: la release de prueba se publicó desde una estación de trabajo.

## 12. Comprobado en el laboratorio (2026-10-03)

Cuenta temporal del proveedor, en una organización; stack `Mango-provider`. Cliente: la organización del laboratorio, que es otra. Detalle en `deployment/provider/README.md`; los ids reales no van en el repositorio.

- **Lectura entre organizaciones con `aws:PrincipalOrgID`:** las cuentas Mango y de gestión del cliente leen; sin listado; anónimo 403.
- **`TemplateURL` y código de Lambda de otra cuenta:** un stack creado en la cuenta del cliente desde la URL del bucket del proveedor, con una Lambda cuyo código está en el bucket regional, llegó a `CREATE_COMPLETE` y la función respondió. Se borró después.
- **Claves inmutables:** `s3:if-none-match` junto con `s3:ObjectCreationOperation` en la política niega toda escritura sin precondición; una clave existente responde 412; las subidas multiparte funcionan con `--no-overwrite`.
- **Solo el rol de publicación escribe:** el administrador de la cuenta recibe un deny explícito.

### Instalación como cliente (2026-10-03, 21:51–22:10 UTC)

Release `v0.1.0-g58cdf6a`, publicada con `mise run dist -- --publish` y verificada desde la cuenta del cliente con `verify-release.py` (una plantilla alterada, un manifiesto alterado y la llave vieja se rechazan). Instalada con tres `create-stack` por URL, namespace `lab`:

- `Payer` y `OrgAccess` en la cuenta de gestión: `CREATE_COMPLETE` en menos de un minuto; el StackSet desplegó `Mango-lab-ReadOnly` en Audit y Log Archive con el trust esperado (cuenta Mango, broker, organización, `SourceIdentity`).
- `Core` en la cuenta Mango: `CREATE_COMPLETE` a la primera, 306 recursos, 18 min 30 s. Sin bootstrap de CDK en la cuenta.
- Comprobado en la instalación: la SPA responde y `config.json` lleva los dominios del parámetro; `/api/health` responde 200; la tarea de ECS corre la imagen del ECR del proveedor por digest; los tres packs (hasta 97 MB) se copiaron del bucket del proveedor al de la instalación; el agente FinOps quedó publicado (`Mango_lab_a_finops` `READY`); los dos administradores existen en Cognito; las subnets están en `use1-az1` y `use1-az2`.

Con esto quedan confirmados los supuestos que el diseño marcaba como centrales: nombres con el parámetro `Namespace` en todos los tipos de recurso, subnets por id de zona con ALB y VPC origin de CloudFront, pull de ECS Fargate desde otra organización y `BucketDeployment` leyendo de otra cuenta.

### Actualización entre versiones y red de packs en su stack (2026-10-03, 22:31–22:49 UTC)

De `v0.1.0-g58cdf6a` a `v0.1.0-gb557f40`, que saca la red de packs a `PackNetwork` y añade el `UninstallGuard`:

- `PackNetwork` creado desde la plantilla publicada en 3 min; exporta las dos subnets y un security group por pack.
- `UpdateStack` de `Core` con un change set y los parámetros anteriores: `UPDATE_COMPLETE` en 12 min. Añadió el guard, quitó los 61 recursos de la red interna y no reemplazó ningún recurso con datos. `Core` importa la red (`list-imports` lo confirma) y el provisioner de packs recibe las subnets y los security groups del stack nuevo.
- El guard recibió sus eventos de creación sin borrar nada: el agente FinOps sigue `READY` y la app responde.
- Un tropiezo sin consecuencias: al quitar la VPC interna, el custom resource de CDK que restringe su security group por defecto falló al borrarse (`InvalidGroup.NotFound`: la VPC ya no existía). Ocurre en la fase de limpieza, que no revierte la actualización.

Sigue sin probar: la desinstalación con el guard. (Probada después: el 2026-10-07 con agentes y un pack, y el 2026-10-08 con el guard fallando a propósito; §8.1 y D58 (13), (16), (17) y (18).)

## 13. Una actualización toca solo lo que cambió (D69, 2026-10-05)

**El problema.** Cada actualización de `Core` traía 63 entradas en el change set aunque solo cambiara la web: 15 Lambdas (solo `Code.S3Key`), 5 capas reemplazadas, 5 `BucketDeployment`, la task definition y 37 reevaluaciones, el user pool entre ellas. Quien revisa aprende a no leerlo. Cuatro causas, todas comprobadas en el código:

| Causa | Dónde | Qué se hizo |
|---|---|---|
| La etiqueta iba en el prefijo de la clave de cada asset (`mango/<etiqueta>/`): 16 o 17 de 19 assets eran idénticos entre releases y solo cambiaba su ruta | `infra/lib/release-target.ts` | Prefijo único `mango/assets/`. Plantillas, manifiesto y firma siguen en `mango/<etiqueta>/` |
| El nombre de un asset no garantizaba su contenido: salía del directorio fuente del paquete, no de lo que se empaqueta (`uv.lock` y los paquetes compartidos cambian el zip y no el nombre) | `infra/lib/constructs/python-function.ts` | `assetHashType: OUTPUT`: el nombre es el hash del bundle. El bundle es el mismo en todo checkout (`deployment/bundle-python.sh` quita los scripts de consola, que llevan la ruta del intérprete local, y su línea en `RECORD`) y el zip depende solo de rutas y contenidos (`zip_directory`) |
| `dist.py` subía con «no sobrescribir» y omitía en silencio una clave existente | `deployment/dist.py` | `put_asset`: sube con `If-None-Match` y el sha256 declarado; si la clave existe, compara y **falla** si los bytes son otros |
| La etiqueta iba en la `Description` de los cuatro stacks: CloudFormation no acepta un cambio solo de descripción, así que `Payer` y `OrgAccess` mostraban etiquetas viejas | `infra/bin/mango.ts` | Descripciones sin etiqueta. `dist.py` falla si una la nombra |

La imagen de `mango-api` salía con otro digest en cada release: bases por tag y fecha de build en la configuración. Ahora las dos bases van por digest y la imagen lleva una fecha fija (`apps/api/Dockerfile`, `SOURCE_DATE_EPOCH` en `dist.py`): las mismas fuentes dan el mismo digest.

**Medido el 2026-10-05** (sin publicar; `mise run dist` sin packs firmados: 16 assets, 155 MB):

| Prueba | Resultado |
|---|---|
| Dos builds seguidos del mismo commit | Manifiestos idénticos byte a byte: 16 de 16 nombres y sha256, 5 de 5 plantillas |
| El mismo commit en un clon limpio, en otra ruta y sin `.venv` | Manifiesto idéntico al anterior |
| Otro commit sin cambios de contenido (otra etiqueta) | 16 de 16 assets con la misma clave y sha256; `PackNetwork`, `Payer`, `OrgAccess` y `Member` con el mismo sha256; en `Core` difiere 1 recurso de 248 (la task definition, por `MANGO_RELEASE`) |
| Otro commit que solo cambia la web | 14 de 16 assets iguales y 2 claves nuevas; en `Core` difieren 3 recursos: los dos `BucketDeployment` de la web y la task definition |
| Imagen: tres builds sin caché, en dos checkouts | El mismo digest las tres veces; sin la fecha fija, uno distinto cada vez (las capas ya coinciden) |

**Qué esperar en el change set de `Core`:**

- **Primera actualización después de D69:** igual de ruidosa que las anteriores, una última vez. Todas las claves pasan de `mango/<etiqueta>/` a `mango/assets/` y los nombres de los ocho paquetes Python cambian (ahora salen del bundle).
- **Siguientes, si solo cambió la web:** los dos `BucketDeployment` de la web (`Modify`), la task definition (`Replacement: True`, por `MANGO_RELEASE` y, si cambió, el digest de la imagen) y el servicio de ECS que la usa (`Modify`). Ninguna Lambda, ninguna capa, ningún pack, y nada que cuelgue de ellos (ni el user pool ni el Gateway).
- **Si cambió un paquete Python:** además, las Lambdas que lo empaquetan y las reevaluaciones de lo que lee su ARN.
- `Payer`, `OrgAccess` y `PackNetwork`: el manifiesto dice si hay algo que actualizar. Si el sha256 de su plantilla es el de la release instalada, no se tocan.

**Lo que sigue igual a propósito:** la task definition cambia en cada release porque lleva la etiqueta en `MANGO_RELEASE` (un despliegue rodante de la API por actualización). Cómo llega la etiqueta a la API no se rediseñó aquí.

**Sin probar en AWS:** dos releases seguidas publicadas e instaladas en el laboratorio, la lectura del rol de publicación (`head-object` con el sha256 que guarda S3) y que el registro conserve el digest al construir desde el runner de GitHub. El stack `Mango-provider` hay que actualizarlo antes de la primera publicación (permiso de lectura nuevo).

