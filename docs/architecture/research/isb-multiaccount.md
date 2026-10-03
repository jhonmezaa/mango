# Innovation Sandbox on AWS (ISB): cómo estructura el despliegue multi-cuenta

**Fuente:** `aws-solutions/innovation-sandbox-on-aws`, commit `ec46ee7` (release v1.3.3).
**Alcance:** solo cómo se estructuran, conectan, empaquetan y actualizan los stacks entre cuentas. La lógica de negocio (leases, nuke) queda fuera.
**Rutas:** relativas a la raíz del repo. `infra/` = `source/infrastructure/`.
**Docs oficiales verificadas** (implementation guide, 2026-09-28): *Prerequisites*, *Launch the stacks*, *Step 1 AccountPool*, *Step 2 IDC*, *Update the solution*, *Architecture overview*.

---

## 0. Resumen ejecutivo

- **Cuatro stacks, tres roles de cuenta y un StackSet.**
  - `AccountPool` va en la **management**.
  - `IDC` va en la **cuenta de Identity Center** (management o delegated admin).
  - `Data` y `Compute` van en la **cuenta hub** dedicada.
  - Un **StackSet service-managed**, *declarado como recurso dentro del stack de la management*, pone el rol spoke en cada cuenta miembro.
  - Todo va en **una sola región**.
- **La confianza entre cuentas usa nombres de rol predecibles** con el namespace dentro. Los spokes confían en la cuenta hub con la condición `aws:PrincipalArn` = un único **rol intermedio** del hub. En runtime, las Lambdas hacen *role chaining*: Lambda → IntermediateRole → rol spoke.
  - No usan `ExternalId` (salvo para clientes M2M), ni `aws:PrincipalOrgID`, ni `SourceIdentity`.
- **La configuración viaja entre stacks por SSM Parameter (tier Advanced) compartido con RAM.** El stack `Compute` lo lee en deploy-time con un custom resource. Eso crea un orden de instalación estricto.
- **Distribución:** CDK → CloudFormation pre-sintetizado.
  - Usan un synthesizer propio (subclase de `DefaultStackSynthesizer`) que apunta los assets a buckets regionales del proveedor (`<bucket>-<region>/<name>/<version>/`).
  - No hace falta *bootstrap* en la cuenta del cliente.
  - Imágenes de contenedor en **ECR Public** con tag "estable" `vX.Y`.
- **Varias instalaciones por organización** vía parámetro `Namespace` (3–8 alfanuméricos). Todo nombre global lo lleva y hay tests de regresión que lo verifican.
- **Tests de IaC:** snapshots, aserciones puntuales, test de consistencia de versiones y metadata para cfn-guard. **No usan cdk-nag** y **el repo no tiene CI público**.

---

## 1. Stacks, cuentas y regiones, parámetros y orden

### 1.1 Inventario

`infra/bin/app.ts:14-53` instancia todos los stacks en **una sola app CDK** con el mismo synthesizer. No fija `env`: los stacks son *environment-agnostic* y la cuenta y región se deciden al desplegar.

| Stack (id) | Cuenta | Qué crea | Código |
|---|---|---|---|
| `${stackPrefix}-AccountPool` | **Org management** (doc Step 1: "log into the Org Management account") | OUs (`<ns>_InnovationSandboxAccountPool` + 7 hijas), 5 SCPs, `OrgMgtRole`, SSM de config + share RAM, **StackSet service-managed** y activador de *cost allocation tags* | `infra/lib/isb-account-pool-stack.ts:18-153`, `infra/lib/isb-account-pool-resources.ts:76-445` |
| `${stackPrefix}-IDC` | Cuenta donde vive **IAM Identity Center**: management **o delegated admin** (doc Step 2) | Custom resource `IdcConfigurer` (grupos + permission sets), `IdcRole`, SSM de config + share RAM | `infra/lib/isb-idc-stack.ts:27-100`, `infra/lib/isb-idc-resources.ts:38-236` |
| `${stackPrefix}-Data` | **Hub** | DynamoDB, KMS, Cognito (user pool, identity pool y sus 3 roles), ConfigMigrator, SSM de config (sin RAM, misma cuenta) y *exports* | `infra/lib/isb-data-stack.ts:14-173`, `infra/lib/isb-data-resources.ts` |
| `${stackPrefix}-Compute` | **Hub** | IntermediateRole, Lambdas, Step Functions, API GW + WAF, CloudFront, CodeBuild de limpieza y lector de config compartida | `infra/lib/isb-compute-stack.ts:25-157`, `infra/lib/isb-compute-resources.ts:56-289` |
| `${stackPrefix}-M2mClient` | Hub (uno **por cliente** de automatización) | Rol M2M con `ExternalId` | `infra/bin/app.ts:46-51`, `infra/lib/isb-m2m-client-resources.ts` |
| `InnovationSandbox-SandboxAccount` | **Cada cuenta del pool** (vía StackSet) | `SandboxAccountRole` | `infra/lib/isb-sandbox-account-stack.ts`, `infra/lib/isb-sandbox-account-resources.ts:27-69` |

**Región:** "You must deploy all the stacks in the same AWS Region, and enable IAM Identity Center (IDC) in the same home Region" (doc *Prerequisites*).
- El StackSet se despliega solo en la región del stack: `regions: [Stack.of(scope).region]` (`infra/lib/isb-account-pool-resources.ts:417`).
- La única excepción cruzada es el certificado ACM de CloudFront, que debe estar en `us-east-1` (`infra/lib/isb-compute-stack.ts:89-106`).

**Instalación en una sola cuenta:** también es posible. `deploy:all` con un solo perfil (README "Deploy from Source") y `bootstrap.sh` deduplica por perfil (`scripts/cdk/bootstrap.sh:81-107`).

### 1.2 Parametrización: dos planos distintos

1. **Parámetros CloudFormation (deploy-time, los ve el cliente).** Hay clases reutilizables con `overrideLogicalId` para que el nombre sea idéntico en todos los templates (`infra/lib/helpers/shared-cfn-params.ts:8-56`):
   - `Namespace`: default `myisb`, patrón `^[0-9a-zA-Z]{3,8}$` (`source/common/types/isb-types.ts:39`).
   - `HubAccountId`, `OrgMgtAccountId` e `IdcAccountId`: validados con `^[0-9]{12}$`.
   - Por stack, además:
     - AccountPool: `ParentOuId`, `IsbManagedRegions` y listas de excepciones de SCP, con `allowedPattern` estrictos (`infra/lib/isb-account-pool-stack.ts:28-109`).
     - IDC: `IdentityStoreId`, `SsoInstanceArn` y nombres de grupo opcionales (`infra/lib/isb-idc-stack.ts:37-71`).
     - Data: `SamlMetadataUrl` y `AwsAccessPortalUrl`.
     - Compute: CIDRs, `UseStableTagging`, `AcceptSolutionTermsOfUse` y dominio propio (`infra/lib/isb-compute-stack.ts:38-106`).
   - Agrupados en la consola con `addParameterGroup` (p. ej. `infra/lib/isb-account-pool-stack.ts:126-137`).
2. **Contexto CDK (build-time, lo fija el proveedor).** Esquema zod `SolutionContextSchema` (`infra/lib/helpers/cdk-context.ts:36-87`): versión, bucket de distribución, registry y tag de ECR, `stackPrefix`, retenciones, *throttling*, validez de tokens y `deploymentMode`.
   - Se **congela dentro del template** como `CfnMapping` (`IsbMapping`, `infra/lib/helpers/cdk-context.ts:96-117`), así el template publicado lleva sus propios valores de build.
   - Nota: `stackPrefix` (contexto) y `Namespace` (parámetro) son **dos ejes distintos**. El primero nombra los stacks; el segundo, los recursos.

### 1.3 Orden de instalación

Es obligatorio: "You must deploy these four stacks … in the following order. Failing to do so will result in deployment failures" (doc *Launch the stacks*). El orden es **AccountPool → IDC → Data → Compute** (también `scripts/cdk/deploy.sh:242-244`).

Por qué este orden:
- `Compute` resuelve en deploy-time los parámetros SSM de las otras tres cuentas. Usa el custom resource `SharedJsonParamResolver` (`infra/lib/helpers/shared-ssm-params.ts:27-62`), que hace `ssm:GetParameter` sobre ARNs cross-account (`infra/lib/components/custom-resources/shared-json-param-resolver.ts:100-113`).
  - Si AccountPool o IDC no existen, o el share RAM no está aceptado, el `Create` de Compute falla.
- `Data` debe ir antes que `Compute`: aporta Cognito y los nombres de tablas.
- **Paso manual intermedio:** antes de Data hay que crear una aplicación SAML en Identity Center y copiar su metadata URL. Al final hay que volver a esa app para pegar el ACS y la audiencia que salen de los outputs de Data (doc *Launch the stacks*; outputs en `infra/lib/isb-data-stack.ts:153-172`).

**Prerrequisitos de organización** (doc *Prerequisites*):
- SCPs habilitadas.
- Identity Center habilitado.
- **RAM sharing con Organizations** activado.
- **Trusted access para StackSets** activado.
- Cost Explorer habilitado en la management (tarda ~24 h).
- SES en el hub.
- Cuota de concurrencia de Lambda ≥ 1000.
- Todas las cuentas deben ser miembros de la organización.

---

## 2. Relación entre cuentas: roles, trust y namespaces

### 2.1 Topología hub-and-spoke con rol intermedio

```
Hub (Compute)                          Management            IDC acct          Cada cuenta del pool
Lambda/CodeBuild role ─AssumeRole─▶ InnovationSandbox-<ns>-IntermediateRole
                                          │── AssumeRole ─▶ InnovationSandbox-<ns>-OrgMgtRole
                                          │── AssumeRole ─────────────────▶ InnovationSandbox-<ns>-IdcRole
                                          └── AssumeRole ──────────────────────────────────▶ InnovationSandbox-<ns>-SandboxAccountRole
```

- **Nombres de rol deterministas**, calculados con funciones puras compartidas por todos los stacks: `InnovationSandbox-${namespace}-{IntermediateRole|IdcRole|OrgMgtRole|SandboxAccountRole}` (`infra/lib/helpers/isb-roles.ts:24-38`). Cada stack puede referirse al ARN del otro **sin outputs ni imports**, construyéndolo con `formatArn` (`infra/lib/helpers/isb-roles.ts:40-66`).
- **Trust de los roles spoke** (OrgMgt, Idc, SandboxAccount): `AccountPrincipal(hubAccountId)` más la condición `ArnEquals aws:PrincipalArn = arn:…:role/InnovationSandbox-<ns>-IntermediateRole`.
  - Código: `infra/lib/isb-account-pool-resources.ts:224-242`, `infra/lib/isb-idc-resources.ts:60-77` e `infra/lib/isb-sandbox-account-resources.ts:37-50`.
  - **Por qué es importante:** se confía en la *cuenta* y el rol se restringe con una *condición*, no poniendo el ARN como `Principal`. IAM valida que un `Principal` ARN exista (y lo convierte internamente en un ID único); la condición no. Por eso el rol spoke **se puede crear antes que el IntermediateRole** y **sobrevive a que se borre y se recree**.
- **Permisos del IntermediateRole:** solo `sts:AssumeRole` sobre los tres ARNs anteriores. El de sandbox usa cuenta `*` (`infra/lib/helpers/isb-roles.ts:93-134`).
- **Trust del IntermediateRole:** la cuenta hub (`:root`) con la condición `aws:PrincipalTag/aws-solutions:isb-id = <ns>_isb` (ABAC).
  - Cada Lambda que lo necesita se registra con `IntermediateRole.addTrustedRole(role)`, lo que reescribe el trust con `addPropertyOverride` y hace `grantAssumeRole` (`infra/lib/helpers/isb-roles.ts:138-217`). Hay 10 llamadas, p. ej. `infra/lib/components/account-cleaner/account-cleaner.ts:211`.
  - El tag lo ponen en todos los recursos con `applyIsbTag` (`infra/lib/helpers/tagging-helper.ts:7-15`).
  - Segunda sentencia: confía en `cloudformation.amazonaws.com` con `aws:SourceAccount` y `aws:SourceArn = …:stackset/*` de la propia cuenta, para usarlo como *administration role* de StackSets self-managed. Un comentario explícito sobre *confused deputy* está en `infra/lib/helpers/isb-roles.ts:176-213`.
- **Runtime:** doble `fromTemporaryCredentials` (Lambda → Intermediate → destino), sesiones de 15 min y **nombres de sesión fijos** (`IsbIntermediateRoleSession`, `IsbSandboxAccountRoleSession`…) (`source/common/utils/cross-account-roles.ts:8-77`). **No propagan la identidad del usuario** (ni `SourceIdentity` ni session tags).

### 2.2 ExternalId, PrincipalOrgID y SourceIdentity

- **`ExternalId`:** solo en los roles **M2M**, que se asumen desde fuera de la solución. Vale el `UniqueStackIdPart`, se expone como output y el trust exige `sts:ExternalId` (`infra/lib/isb-m2m-client-resources.ts:65,88-97`; output en `infra/lib/isb-m2m-client-stack.ts:106-110`). Para la confianza intra-organización no lo usan, igual que en nuestra §4.10.
- **`aws:PrincipalOrgID`:** no se usa en ningún trust. El OrgId solo se deriva del ARN de la OU para acotar `organizations:*` (`infra/lib/isb-account-pool-resources.ts:123`).
- **`aws:SourceArn` / `aws:SourceAccount`:** solo en trusts de servicios (CloudFormation, logs) (`infra/lib/helpers/isb-roles.ts:188-211`, `infra/lib/components/observability/log-archiving.ts:87,110`).
- **`SourceIdentity`:** no se usa. En el CloudTrail de las cuentas spoke solo se ve `IsbSandboxAccountRoleSession`.

### 2.3 Namespaces: varias instalaciones en la misma organización

- Se añadió en la v1.3.0: "Support for multiple Innovation Sandbox deployments within the same AWS Organization via namespaced global resources" (`CHANGELOG.md:71`).
- Todo recurso con nombre global lleva `<ns>`:
  - roles (`isb-roles.ts:24-38`);
  - OUs y SCPs (`isb-account-pool-resources.ts:83,139,156,171,193,210`);
  - StackSet (`:404`) y shares RAM (`:374`; `isb-idc-resources.ts:228`);
  - parámetros SSM `InnovationSandbox_<ns>_{AccountPool|Idc|Data}_Configuration` (`source/common/types/isb-types.ts:41-51`);
  - Lambdas `ISB-<id>-<ns>` (`infra/lib/components/isb-lambda-function.ts:96`);
  - alias KMS (`infra/lib/components/kms.ts:24`);
  - grupos de IDC `<ns>_IsbAdminsGroup` (`infra/lib/isb-idc-stack.ts:52-71`);
  - roles M2M `<ns>-isb-m2m-<role>-<client>`, con el cálculo de 64 caracteres documentado (`infra/lib/isb-m2m-client-resources.ts:82-86`).
- **Tests de regresión dedicados** comprueban que cada nombre global se renderiza como `Fn::Join [Ref Namespace, sufijo]`. Están *fuera* del snapshot para que una regresión no se "re-baselinee" sin querer (`infra/test/namespace-globals.test.ts:4-8,71-74`).
- La excepción documentada: el dominio de Cognito usa región + ID del stack porque el namespace admite mayúsculas (`infra/lib/isb-data-resources.ts:252-253`).

### 2.4 Configuración compartida entre cuentas (en lugar de exports)

- Cada stack "productor" publica un **JSON en un SSM Parameter tier Advanced**, que es el requisito para compartirlo con RAM. El JSON lleva `solutionVersion` y `supportedSchemas`. Se comparte con `aws_ram.CfnResourceShare` solo con la cuenta hub (`allowExternalPrincipals: false`, permiso `AWSRAMDefaultPermissionSSMParameterReadOnly`).
  - Código: `infra/lib/isb-account-pool-resources.ts:341-381` e `infra/lib/isb-idc-resources.ts:204-235`.
- `Compute` lo lee con un custom resource que se re-ejecuta en **cada** update (`forceUpdate: new Date().getTime()`, `infra/lib/components/custom-resources/shared-json-param-resolver.ts:95`). El JSON se valida con zod en la Lambda (`source/lambdas/custom-resources/shared-json-param-parser/src/shared-json-param-parser-handler.ts:50-78`).
- Dentro del hub también hay `Export`s CFN clásicos (`infra/lib/isb-data-stack.ts:65-172`), pero Compute usa el SSM.
- Existe `supportedSchemas` (p. ej. `infra/lib/isb-account-pool-resources.ts:54-61`), pero **no encontré código que compare versiones o esquemas** entre stacks. Hoy es solo informativo.

---

## 3. Integración con IAM Identity Center y Organizations / Control Tower

- **Identity Center:**
  - El stack IDC va en la cuenta de la *instancia* de IDC, y AWS **recomienda la delegated admin**. Aun así, el parámetro `OrgMgtAccountId` siempre recibe la management, porque el ARN del identity store usa esa cuenta (doc Step 2; `infra/lib/isb-idc-resources.ts:40-47`).
  - Un custom resource (`IdcConfigurer`) crea los **grupos** (`identitystore:CreateGroup`, `infra/lib/components/custom-resources/idc-configurer.ts:89`) y los **permission sets**, y publica sus IDs en SSM.
  - `IdcRole` puede crear y borrar *account assignments*, acotado a la instancia y sus permission sets (`infra/lib/isb-idc-resources.ts:79-200`).
  - Con IdP externo + SCIM, los grupos deben existir con el mismo nombre en el IdP (doc Step 2).
- **Login a la app:** Cognito federa con IDC por SAML y el identity pool asigna 3 roles IAM según el grupo (`infra/lib/isb-data-resources.ts:291-346`). La app SAML es **manual**.
- **Organizations:**
  - Crean su **propio árbol de OUs** bajo `ParentOuId` (puede ser la raíz) (`infra/lib/isb-account-pool-resources.ts:79-121`).
  - `OrgMgtRole` tiene `MoveAccount`, `List*` y `Tag` acotados a esas OUs y a tag keys concretas (`:244-324`).
  - Cost Explorer con `ce:GetCostAndUsage` sobre `*` (`:325-338`).
- **SCPs:** 5 `CfnPolicy` gestionadas por CloudFormation y adjuntas a las OUs propias (`:125-222`). Se pueden personalizar por parámetros o sustituyendo los JSON en build-time (`scpDirectoryPath`). La doc de upgrade avisa: "The AccountPool stack update overwrites any SCP modifications you made directly in the AWS Organizations console."
- **Control Tower:** no depende de CT. En el código solo aparece para *rechazar* StackSets de CT como blueprint (`source/common/isb-services/blueprint-deployment-service.ts:236-262`). Con CT, la OU que crean es una OU más; el repo no documenta si hace falta registrarla en CT.
- **Delegated admin de StackSets:** no se usa. El StackSet se crea desde la management (`CfnStackSet` sin `callAs`).

---

## 4. Empaquetado y distribución

### 4.1 CDK → CloudFormation con un synthesizer propio

`SolutionsEngineeringSynthesizer extends DefaultStackSynthesizer` (`infra/lib/stack-synthesizers/solutions-engineering-synthesizer.ts:52-142`), configurado en `infra/bin/app.ts:18-24`:

- `fileAssetsBucketName = "${distOutputBucket}-${AWS::Region}"`: el bucket **del proveedor**, uno por región, resuelto en deploy-time.
- `bucketPrefix = "<solutionName>/<version>/asset."` (`infra/lib/helpers/cdk-context.ts:78-87`). Los assets quedan **inmutables por versión**.
- `generateBootstrapVersionRule: false`: el template no exige el parámetro `BootstrapVersion` ni el stack `CDKToolkit`.
- **Modo dual:** si no se pasa `distOutputBucket`, el synthesizer se comporta como el default y usa el bucket del *bootstrap*. Así sirve también para desarrollo con `cdk deploy` (`scripts/cdk/bootstrap.sh`, `scripts/cdk/deploy.sh:107-156`).
- **`addFileAsset`:** para los assets `zip`, empaqueta el directorio con `zip -r` en `cdk.out/asset.<hash>.zip`. Así el artefacto ya existe con el nombre que espera el template (`:60-78`).
- **Post-procesado:**
  - Quita el `Transform: AWS::LanguageExtensions`, que rompe el "Use existing value" al actualizar desde la consola (`:80-133`).
  - **Compacta el JSON** y avisa al acercarse al límite de 1 MB de template (`:14-46`), con su test en `infra/test/stack-synthesizers/`.

### 4.2 Scripts de `deployment/` y buckets

`deployment/build-s3-dist.sh`:
1. `cdk synth` con `--context distOutputBucket/version/...` (`:134-151`).
2. Templates → `global-s3-assets/`. **Excepción:** el template del StackSet (`InnovationSandbox-SandboxAccount`) va a `regional-s3-assets/`, porque su `TemplateURL` apunta al bucket regional (`:153-162`).
3. `asset.*` (Lambdas zip, frontend, template anidado) → `regional-s3-assets/` (`:164-165`).
4. Contexto de cada `Dockerfile` → `deployment/ecr/<name>-<image>` para que el pipeline interno lo construya y publique (`:167-179`).
5. Instrucciones de subida (`:187-192`):
   - `s3://<bucket>/<name>/<version>/` (global)
   - `s3://<bucket>-<region>/<name>/<version>/` (regional)

Los enlaces "Launch" apuntan a `solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/<Stack>.template` (`README.md:89-97`).

**Template anidado del StackSet:** se sintetiza **una segunda `App` dentro del constructor** de AccountPool (`infra/lib/isb-account-pool-resources.ts:382-393`). Se registra como `Asset` S3 y se pasa `templateUrl: asset.httpUrl` al `CfnStackSet` (`:395-439`). El template del spoke viaja con la versión igual que una Lambda.

### 4.3 Lambdas e imágenes sin bootstrap

- **Lambdas:** `NodejsFunction` con esbuild en synth (ARM64, Node 24) (`infra/lib/components/isb-lambda-function.ts:95-115`). Son file assets en los buckets regionales.
- **Contenedor** (account cleaner): **no es un `DockerImageAsset`**, que sí exigiría bootstrap y ECR en la cuenta del cliente. Se referencia como imagen de registry externo `public.ecr.aws/aws-solutions/<name>-account-cleaner:<tag>` (`infra/lib/components/account-cleaner/account-cleaner.ts:95-120`).
  - Parámetro `UseStableTagging`: `Yes` → tag `vX.Y` (mutable, recibe parches de seguridad); `No` → `vX.Y.Z` (`:101-111`).
  - Alternativa: repo **ECR privado** del cliente por contexto `privateEcrRepo`, con permisos condicionales (`:173-204`; `README.md:151-162`).
- `deployment/ecr_image_tags.json` fija el tag estable y un test asegura que coincide con el manifest (`infra/test/release-consistency.test.ts:39-56`).

### 4.4 `solution-manifest.yaml`, versionado y upgrades

- **`solution-manifest.yaml:1-15`** es la fuente única de `id` (SO0284), `name`, `version` (`v1.3.3`), la lista de templates (con `main_template`) y las imágenes. Lo leen `readManifest()` (`infra/lib/helpers/manifest-reader.ts:14-36`, que también arma el user-agent `AwsSolution/<id>/<ver>`) y `build-common.sh:26-66`.
  - `auto_create_github_pr: true` indica que el repo público es un **espejo** de un pipeline interno.
- **Versión en la descripción** de cada stack: `(SO0284-IdcStack) innovation-sandbox-on-aws v1.3.3` (`infra/bin/app.ts:26-51`). Es trazabilidad visible en la consola del cliente.
- **Test de consistencia:** `package.json` = manifest; tags ECR = `vMAJOR.MINOR` (`infra/test/release-consistency.test.ts:26-56`).
- **Proceso de upgrade** (doc *Update the solution*):
  - Activar **modo mantenimiento** y reemplazar los templates en orden **AccountPool → IDC → Data → Compute → M2M**, con "Rollback all stack resources".
  - Los parámetros se conservan.
  - Hay notas de *breaking changes* por versión: en 1.3.0, reconfigurar la app SAML (`CHANGELOG.md:83`); en 1.3.3, un API GW nuevo que obliga a actualizar los stacks M2M.
- **Migraciones de datos** con un custom resource `ConfigMigrator` en el stack Data (`infra/lib/isb-data-resources.ts:352`). Es idempotente y "never overwrites configuration already saved"; si falla, el stack hace rollback (doc).
- **Retención:** tablas, user pool y log groups tienen `RETAIN` salvo en `deploymentMode=dev` (`infra/lib/isb-data-resources.ts:72-74,200`).

---

## 5. StackSets: sí, de dos tipos

1. **Service-managed, para *bootstrap* del spoke** (`infra/lib/isb-account-pool-resources.ts:403-440`):
   - `permissionModel: SERVICE_MANAGED`, `autoDeployment.enabled: true`, `retainStacksOnAccountRemoval: false`.
   - Destino: **solo la OU raíz de ISB** (`organizationalUnitIds: [sandboxOu.attrId]`) y **una región**.
   - `managedExecution.Active: true` (encola operaciones).
   - `SOFT_FAILURE_TOLERANCE` con `failureTolerancePercentage: 100` y `maxConcurrentPercentage: 100`.
   - Parámetros `Namespace` y `HubAccountId`.
   - **Por qué:** toda cuenta que entra a la OU recibe el rol spoke sin intervención, y mover cuentas entre OUs hijas no dispara nada, porque siguen bajo la OU objetivo. Se declara **dentro del stack de la management**, que es donde tiene sentido un StackSet service-managed sin delegated admin. El rol de la propia management (`OrgMgtRole`) va **directo en ese mismo stack**, porque el StackSet no llega a la management.
2. **Self-managed, en runtime, para "blueprints":** el hub hace `CreateStackInstances` sobre StackSets que registra el administrador.
   - Usa el `IntermediateRole` como *administration role* (de ahí su trust a `cloudformation.amazonaws.com` con `SourceArn`) y el `SandboxAccountRole` como *execution role*.
   - Rechaza explícitamente los service-managed y los de Control Tower (`source/common/isb-services/blueprint-deployment-service.ts:143-157,236-262`).
   - **Por qué:** necesitan desplegar en *una* cuenta concreta del pool en el momento del lease, no en una OU.

---

## 6. CI/CD, testing de IaC, buenas y malas prácticas

### 6.1 CI/CD

- **No hay `.github/workflows`**: solo plantillas de issue y PR (`.github/`). El build y la publicación ocurren en el pipeline interno de AWS Solutions (`solution-manifest.yaml:11-15`).
- `package.json:13` referencia `deployment/build-open-source-dist.sh`, que **no existe** en el repo. Es un artefacto del espejo.
- **Local:** `.pre-commit-config.yaml` (prettier, shellcheck, *license headers*, `detect-private-key`, detección de drift del modelo de la CLI).
- `scripts/cdk/*.sh` envuelve `cdk deploy` por stack y por perfil de cuenta. Mapeo stack → perfil en `scripts/cdk/common.sh:83-89`. Hace build + synth una vez y despliega en orden, con resumen de éxitos y fallos (`scripts/cdk/deploy.sh:288-334`). Usa `--require-approval=never` (`:153`).

### 6.2 Testing de IaC (vitest)

- **Snapshots completos** de los 6 stacks, normalizando lo no determinista: hash del código Lambda, `TemplateURL` del StackSet y `forceUpdate` (`infra/test/snapshots.test.ts:32-89`). Mocks de `Code.fromAsset` y `Source.asset` para no empaquetar en los tests (`:95-125`).
- **Aserciones dirigidas** para regresiones reales, p. ej. que el rol del migrador tenga `BatchGetItem` y `PutItem` (`:155-175`).
- **Tests de namespacing** (§2.3) y de **consistencia de release** (§4.4).
- Tests de SCP (`infra/test/components/service-control-policies/`) y del synthesizer.
- **cfn-guard:** solo metadata de supresión por recurso (`addCfnGuardSuppression`, `infra/lib/helpers/cfn-guard.ts:6-28`). La ejecución de guard, y probablemente de cfn_nag, vive en el pipeline interno.
- **cdk-nag: no se usa** (sin coincidencias en `source/`).

### 6.3 Buenas prácticas observadas

- Nombres de recurso deterministas y con namespace, más tests que lo garantizan.
- Trust con `AccountPrincipal` + `aws:PrincipalArn`: independiente del orden de creación y robusto ante recreaciones.
- Un único rol intermedio por instalación, así los spokes solo confían en un ARN.
- `allowedPattern` y `constraintDescription` estrictos en cada parámetro. Los *wildcards* peligrosos se rechazan ya en el parámetro (`infra/lib/isb-account-pool-stack.ts:79-95`).
- Assets versionados e inmutables en buckets regionales, sin bootstrap en el cliente. Template del spoke distribuido como asset.
- Retirada de `AWS::LanguageExtensions` para no romper los updates desde consola. Compactación y control del límite de 1 MB.
- Contexto de build congelado en `CfnMapping` dentro del template. La versión aparece en la descripción del stack. El manifest es la fuente única de versión.
- `RETAIN` en datos, migraciones por custom resource idempotente y modo mantenimiento durante los upgrades.
- Trust de servicio con `aws:SourceAccount` + `aws:SourceArn` contra *confused deputy* (`infra/lib/helpers/isb-roles.ts:182-211`).

### 6.4 Malas prácticas y riesgos

- **Acoplamiento en deploy-time entre cuentas:** Compute falla si SSM o RAM de otras cuentas no están listos, y el custom resource corre en cada update (`forceUpdate` con timestamp), lo que vuelve el template no determinista.
- **`SandboxAccountRole` con `*:*`** y trust a `cloudformation.amazonaws.com` **sin condiciones**. Delegan la mitigación en una SCP (`infra/lib/isb-sandbox-account-resources.ts:32-61`). Es aceptable para cuentas desechables; **inaceptable para cuentas productivas** como las que tocará Mango.
- **Trust ABAC del IntermediateRole:** `:root` + `PrincipalTag`. Cualquier principal del hub que tenga ese tag y permiso `sts:AssumeRole` puede asumirlo; depende de que el hub sea una cuenta dedicada. Además se reescribe con `addPropertyOverride`, un *escape hatch*.
- **Estado estático global** en constructs (`IntermediateRole.instance`, `IsbMapping.instances` por nombre de stack): es frágil y complica los tests (ver el comentario en `snapshots.test.ts:143-147`).
- **StackSet con `failureTolerancePercentage: 100`:** los fallos en spokes pasan en silencio.
- **Sin trazabilidad de usuario** en las cuentas destino (sesiones con nombre fijo). Sin `PrincipalOrgID`.
- **Tag de imagen mutable `vX.Y`** sin *digest pinning*: la reproducibilidad y la cadena de suministro dependen de ECR Public.
- **Pasos manuales** (app SAML antes y después de Data) y 4 stacks que despliegan personas distintas en cuentas distintas, en orden estricto. Tiempo declarado: ~60 min por stack según la doc.
- **`supportedSchemas` sin validar.** El script de build referencia un archivo inexistente. No hay CI visible ni cdk-nag.

---

## 7. Qué adoptar para Mango

### 7.1 Estructura de stacks (propuesta)

| Stack | Cuenta | Contenido | Obligatorio |
|---|---|---|---|
| `Mango-<ns>-Core` (y el resto de apps de §4.8: `edge`, `agents`, `audit`) | cuenta `mango` | Plataforma, roles de ejecución de los conectores y el/los **broker roles** (ver 7.3) | Sí |
| `Mango-<ns>-OrgAccess` | **Management** o **delegated admin de StackSets** (`CfnStackSet` con `callAs: DELEGATED_ADMIN`) | Un **`AWS::CloudFormation::StackSet` service-managed declarado como recurso** (patrón ISB), con template del spoke como asset versionado, auto-deployment y OUs/raíz elegibles por parámetro | Sí, si hay multi-cuenta |
| `Mango-<ns>-Payer` | **Management** | Solo `Mango-<ns>-BillingReader` (CE, `organizations:List*/Describe*`, lectura de Data Exports) | Opcional (alternativa: solo CUR 2.0) |
| `Mango-<ns>-Support` (opcional, fase posterior) | Cuenta de **Identity Center** (management o delegated admin, patrón ISB Step 2) | Permission set de soporte acotado a la cuenta `mango`, **sin assignment** por defecto | Opcional |
| `Mango-<ns>-MemberRole` (template del spoke) | Cada cuenta miembro (vía StackSet, CfCT o AFT) | `Mango-<ns>-ReadOnly` (+ `Mango-<ns>-Operator` desactivado por parámetro) | Vía StackSet |

Separar `OrgAccess` de `Payer` (ISB los junta en AccountPool) tiene dos ventajas:
- El cliente puede lanzar el StackSet desde una **delegated admin** y dejar la management con el mínimo.
- Puede omitir `Payer` por completo si elige el camino "solo CUR 2.0".

### 7.2 Orden de instalación: independiente por diseño

- Adoptar la **independencia de orden** que ya permite el patrón de trust de ISB (§2.1) y **no** su acoplamiento por SSM/RAM en deploy-time.
  - Todos los nombres y ARNs son deterministas (`Mango-<ns>-…`) y se calculan con los *account IDs* pasados como parámetros.
  - Ningún stack lee a otro en deploy-time.
- **Orden documentado recomendado:** `Core` (cuenta mango) → `OrgAccess` → `Payer` (opcional) → `Support` (opcional).
- `Core` incluye un **"connectivity check"** en runtime y en la UI de admin: prueba `AssumeRole` a Payer y a una muestra de spokes, y muestra qué falta. Así un stack sin desplegar no bloquea a otro.
- Si hace falta compartir config (p. ej. la lista de OUs objetivo), lo lee la app **en runtime** vía `organizations:*` con el BillingReader. Nada de RAM+SSM.
- **Checklist de prerrequisitos** (tomado de la doc ISB):
  - Trusted access de StackSets activado.
  - Delegated admin de StackSets registrada (si aplica).
  - Cost Explorer habilitado (~24 h).
  - Región de la instalación definida.
  - Cuentas miembro de la organización.
  - Cuotas (Lambda, STS).

### 7.3 Patrón de roles (concreto)

- **Nombres:** `Mango-<ns>-ReadOnly`, `Mango-<ns>-Operator`, `Mango-<ns>-BillingReader` y `Mango-<ns>-{Read,Billing,Operate}Broker`. `Namespace` de 3–8 alfanuméricos, en **todos** los nombres globales (roles, StackSet, KMS alias, SSM, log groups, grupos IDC), con tests como `namespace-globals.test.ts`.
- **Brokers (patrón IntermediateRole) mejorados:** en la cuenta mango, un broker **por nivel de privilegio**, no uno solo como en ISB. Así el trust de `ReadOnly` no permite llegar a `Operator`.
  - Los roles de ejecución de los conectores asumen el broker; el broker asume el rol spoke.
  - Así, añadir o quitar conectores **no obliga a re-desplegar el StackSet**.
  - Costo: el *role chaining* limita la sesión a 1 h.
- **Trust del spoke** (ISB + lo que falta):

  ```json
  {"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<MANGO_ACCT>:root"},
   "Action":["sts:AssumeRole","sts:SetSourceIdentity","sts:TagSession"],
   "Condition":{
     "ArnEquals":{"aws:PrincipalArn":"arn:aws:iam::<MANGO_ACCT>:role/Mango-<ns>-ReadBroker"},
     "StringEquals":{"aws:PrincipalOrgID":"<o-xxxx>"},
     "StringLike":{"sts:SourceIdentity":"*"}}}
  ```

  - `AccountPrincipal` + `aws:PrincipalArn` (no `Principal` ARN) da independencia de orden y robustez ante recreaciones.
  - Añadir `aws:PrincipalOrgID` y **exigir `SourceIdentity`**. ISB no lo hace y su CloudTrail no identifica a la persona.
  - En el trust del broker, listar ARNs explícitos. **No** usar el ABAC `:root` + `PrincipalTag` de ISB.
  - **Verificar:** que `SourceIdentity` y los session tags transitivos se propagan como esperamos en el *chaining* broker → spoke.
- **ExternalId:** solo para accesos de terceros, como el M2M de ISB. Encaja con nuestra §4.10.
- **Payer:** rol directo en el stack de la management, como `OrgMgtRole` de ISB. ISB también necesita `ce:GetCostAndUsage` sobre `*` porque no se puede acotar (`isb-account-pool-resources.ts:325-338`); lo asumimos y lo documentamos.

### 7.4 Distribución de assets

- **Pasar ya al modelo pre-sintetizado de ISB**: synthesizer propio que extiende `DefaultStackSynthesizer`, con:
  - `fileAssetsBucketName: "<mango-releases>-${AWS::Region}"`;
  - `bucketPrefix: "mango/<version>/"`;
  - `generateBootstrapVersionRule: false`;
  - zip de assets en synth, retirada de `LanguageExtensions` y compactación con alarma de 1 MB.
- Buckets **regionales** para assets y el template del spoke; bucket **global** para los templates principales. Estructura `s3://<bucket>[-<region>]/mango/<version>/`, **inmutable**, con enlaces "Launch stack" por versión y alias `latest`.
- **Template del spoke como asset** dentro de `OrgAccess` (sub-`App` sintetizada o, mejor, un `Stage` o un paso de build separado), para que StackSet y plataforma compartan versión.
- **Contexto de build congelado** en `CfnMapping`, **versión en la descripción** de cada stack y user-agent `Mango/<ver>` en los SDK. `release.yaml` como fuente única de versión, con un test de consistencia.
- **Imágenes (Fargate `mango-api`, AgentCore Runtime):** no usar `DockerImageAsset`, porque requiere bootstrap y ECR en el cliente.
  - Publicar en **ECR Public** o en un ECR privado del proveedor con política de lectura por cuenta.
  - Referenciar **por digest** (`@sha256:`), con un tag `vX.Y` solo como opción explícita "recibir parches".
  - Ofrecer `privateEcrRepo` para clientes que no permiten registries externos.
  - **Verificar:** los requisitos de AgentCore Runtime sobre el origen de la imagen (misma cuenta y región o cross-account). Si exige ECR en la cuenta del cliente, hace falta un custom resource o CodeBuild de replicación en el install.
- **Modo dual** (dev con bootstrap / release sin bootstrap) en el mismo synthesizer, como ISB.

### 7.5 Upgrades y testing

- **Upgrades:**
  - Orden documentado por release.
  - Modo mantenimiento en la app.
  - Migraciones como **custom resource idempotente** que hace rollback del stack si falla (`ConfigMigrator`).
  - `RETAIN` en datos.
  - Notas de *breaking changes* en CHANGELOG y guía.
  - **Mejorar a ISB:** cada stack publica `version` y `schema` (en un tag del stack o en un SSM de la cuenta mango), y `Core` **valida** la compatibilidad en runtime o en el connectivity check. ISB guarda `supportedSchemas` pero no lo usa.
- **Testing:** snapshots normalizados + aserciones dirigidas (IAM, trusts) + tests de namespacing + test de consistencia de release + **cdk-nag (AwsSolutionsChecks)** + **cfn-guard ejecutado en CI** sobre los templates finales. ISB solo deja la metadata. Añadir además un test que falle si algún trust spoke no tiene `PrincipalOrgID` o `SourceIdentity`.

---

## 8. Qué no adoptar

- El **acoplamiento en deploy-time** por SSM tier Advanced + RAM + custom resource con `forceUpdate` de timestamp. Obliga a un orden estricto, requiere RAM org sharing y da templates no deterministas.
- **Roles spoke `*:*`** y trust a `cloudformation.amazonaws.com` sin condiciones. Mango opera sobre cuentas **productivas**: listas de acciones explícitas por conector (ya está en §4.10).
- **Trust ABAC `:root` + `PrincipalTag`** en el rol intermedio, reescrito con `addPropertyOverride`.
- **Singletons estáticos** en constructs.
- **Crear OUs y SCPs propias.** Mango no necesita modificar la estructura de la organización del cliente; sería el cambio más sensible para su equipo de seguridad.
- **`failureTolerancePercentage: 100` sin monitoreo.** Usar tolerancia razonable y **alarma o reporte** del estado de las instancias del StackSet, visible en el connectivity check.
- **Tags de imagen mutables por defecto.**
- **Pasos manuales entre stacks** (la app SAML de ISB). Nuestra federación Cognito ↔ IdP del cliente debería resolverse con parámetros y outputs en un solo stack, o con un asistente post-deploy.
- **Nombres de sesión fijos.**
- **Un stack M2M por cliente** creado a mano con scripts. Para Mango, los clientes M2M deberían ser datos de la app o un recurso de un único stack, no N stacks.

---

## 9. Dónde debería cambiar nuestra propuesta (§4.9 y §4.10)

**§4.9 (distribución):**
1. **Invertir las fases.** ISB demuestra que el modelo "plantillas pre-sintetizadas + synthesizer propio + buckets regionales versionados" funciona desde el día 1, con enlaces "Launch stack" y **sin bootstrap ni CodeBuild** en el cliente. Recomendación:
   - Hacer de la **Fase 2 el camino principal ya en el MVP**.
   - Dejar el instalador CodeBuild + `cdk deploy` solo como herramienta interna o de dev, o eliminarlo. Así desaparecen los problemas que §4.9 intenta "endurecer": `AdministratorAccess`, bootstrap y políticas de ejecución.
2. Añadir la **distribución de imágenes** (ECR Public o registry del proveedor por digest, con opción de ECR privado del cliente). Hoy §4.9 solo menciona "buckets/ECR de releases". Marcar como **pendiente de verificar** el requisito de origen de imagen de AgentCore Runtime.
3. Añadir **una región por instalación**, parámetro `Namespace`, versión en la descripción, `CfnMapping` de build, límite de 1 MB y un orden de upgrade documentado con modo mantenimiento y migraciones por custom resource.
4. **Testing:** añadir tests de namespacing, de trusts y de consistencia de release, y ejecutar **cfn-guard** sobre los templates finales, además de cdk-nag.

**§4.10 (multi-cuenta):**
1. **Namespace en todos los nombres.** `MangoReadOnly`, `MangoOperator` y `MangoBillingReader` deben ser `Mango-<ns>-…`, y el StackSet `Mango-<ns>-MemberAccess`. Si no, **`mango-prod` y `mango-nonprod` (§4.7) colisionan** en las mismas cuentas miembro al desplegar dos StackSets con roles del mismo nombre.
2. **Trust:** cambiar "solo los roles de ejecución de los conectores" por **`AccountPrincipal(mango)` + `aws:PrincipalArn` = broker(s) de la cuenta mango** + `aws:PrincipalOrgID` + `SourceIdentity` obligatorio. Motivos:
   - Instalar en cualquier orden.
   - No re-desplegar el StackSet en cientos de cuentas cada vez que se añade un conector.
   - No romper el trust si un rol de conector se recrea.
3. **StackSet como recurso CloudFormation** (`AWS::CloudFormation::StackSet`, `SERVICE_MANAGED`, auto-deployment) dentro de un stack `Mango-<ns>-OrgAccess`, con el template del spoke **como asset versionado**. Soportar `callAs: DELEGATED_ADMIN`. Así el cliente instala el StackSet con un solo `CreateStack` y hereda los upgrades por versión.
4. **Una sola región en el StackSet.** Los roles IAM son globales: desplegar la instancia del spoke en varias regiones con el mismo `RoleName` falla. La nota de "multi-región" de §4.10 aplica a los *conectores* en runtime, no al StackSet.
5. **Separar `OrgAccess` (StackSet) de `Payer` (rol de facturación)**, como en §7.1. `Payer` sigue siendo un stack aparte en la management, como ya propone §4.10 (coincide con el `OrgMgtRole` de ISB).
6. **Soporte del proveedor vía Identity Center:** concretarlo como un stack opcional en la **cuenta de IDC (management o delegated admin)**, siguiendo el patrón del IDC stack de ISB. El stack crea un permission set acotado a la cuenta mango **sin asignar**; el cliente asigna y quita el acceso cuando lo decide. Así la pregunta abierta de §8 queda resuelta.
7. **Añadir a los riesgos:** el estado de las instancias del StackSet. Con tolerancia a fallos alta, cuentas sin rol pasan desapercibidas: hay que monitorearlo y mostrarlo en el connectivity check.
8. **Checklist de prerrequisitos** en la guía de instalación: trusted access de StackSets, delegated admin (opcional), Cost Explorer habilitado (~24 h), región de la instalación y OUs objetivo.
