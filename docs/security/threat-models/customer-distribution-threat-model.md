# Distribución para clientes (release, instalación y desinstalación): modelo de amenazas (v0.1)

> Fecha: 2026-10-03 · Skill: `security-threat-model`. Diseño: `docs/specs/customer-distribution.md`. Decisiones: D3, D8, D9, D25, D36, D43, D48.
> **Escrito antes de construir; el componente ya existe (D58).** Están construidos la cuenta del proveedor (`infra/lib/stacks/provider-stack.ts`), la publicación (`deployment/dist.py`, `.github/workflows/release.yml`) y `UninstallGuard` (`infra/lib/constructs/uninstall-guard.ts`). En las tablas, «controles existentes» son los que había en el repo al escribir el modelo, y los del diseño van como mitigaciones recomendadas; cuáles se construyeron está en «Cuenta del proveedor: construida y revisada», al final.
> Alcance: `infra/` (synthesizer, plantillas con parámetros), `deployment/` (`dist`, `provider/`, scripts), `.github/workflows/` (`release.yml`, `packs.yml`), verificación de firmas (`packages/py/mango-packs`, `functions/provisioner`, `apps/api`), `UninstallGuard`.
> Decidido por el usuario el 2026-10-03: distribución como Innovation Sandbox (buckets y ECR en una cuenta de AWS del proveedor, fuera de la organización del cliente); firma de packs y del manifiesto con una llave KMS en la cuenta del proveedor (se descarta la firma sin llave); lectura por organización del cliente; red de packs en un stack propio; instalaciones solo de tipo `customer`; parámetros mínimos y el resto en la aplicación.

## Executive summary

Este componente decide **qué código corre en la cuenta de cada cliente**. Una release comprometida llega a todos a la vez, con los permisos de quien instala (`CAPABILITY_NAMED_IAM`, roles en la cuenta de gestión). Es el riesgo más alto del producto.

Temas dominantes:

1. **Compromiso de la cadena de publicación:** quien controle el workflow de release, el rol de publicación o los buckets del proveedor entrega plantillas o código alterados.
2. **Sustitución de artefactos ya publicados:** cambiar una plantilla, un zip o la imagen de una versión que los clientes ya usan o van a reinstalar.
3. **Llave de firma en la cuenta del proveedor:** quien pueda asumir el rol de firma (el workflow de este repo con su entorno) firma packs y manifiestos. La llave pública viaja en la release.
4. **Parámetros de instalación:** un valor mal puesto (cuenta de gestión, organización, primer admin, dominios de registro) abre confianza a quien no debe.
5. **`UninstallGuard`:** un recurso del stack con permiso para borrar todos los agentes y packs. Si se dispara fuera de una desinstalación, destruye la instalación.
6. **Dependencia del proveedor en runtime:** la imagen de `mango-api` se descarga del ECR del proveedor cada vez que arranca una tarea.

## Scope and assumptions

**En alcance:** construcción y publicación de la release, cuenta del proveedor, lectura desde las cuentas del cliente, instalación y actualización por CloudFormation, firma y verificación de packs y del manifiesto, desinstalación y purga.

**Fuera de alcance:** el comportamiento de Mango ya instalado (`mango-architecture-threat-model.md`), el contenido de los packs (`mcp-pack-pipeline-threat-model.md`, que habrá que actualizar por el cambio de firma), el acceso de soporte (§4.11).

**Supuestos:**

- El repo es privado, de una cuenta personal de GitHub, con pocos colaboradores. `main` está protegida y los entornos `release` y `pack-signing` exigen aprobación. **No comprobado**: la configuración de GitHub no está en el repo.
- Los clientes son pocos y conocidos; cada uno entrega el id de su organización.
- La cuenta del proveedor solo tiene esto y la administra una persona, con MFA.
- Quien instala en el cliente tiene permisos de administrador en la cuenta donde lanza cada stack.
- El laboratorio se comporta como un cliente: nada del proveedor vive en su organización.

**Respuestas del usuario (2026-10-03):** lectura por organización del cliente; **sin** firma sin llave (nada en registros públicos): llave KMS en la cuenta del proveedor; un único aprobador de los entornos por ahora (el usuario). TM-D7 y TM-D9 dejan de aplicar y se conservan como registro de por qué se descartó Sigstore.

## System model

### Primary components

- **Repositorio de GitHub** (privado): código, `release.yaml`, `packs/signing-key.pub` (llave pública de firma).
- **GitHub Actions:** `packs.yml` (construye y firma packs), `release.yml` (construye, firma el manifiesto y publica).
- **Cuenta del proveedor:** bucket global de plantillas, buckets regionales de assets, ECR de la imagen, llave KMS de firma, roles `Mango-provider-release-publisher` y `Mango-provider-pack-signing` (OIDC), alarmas.
- **Cuentas del cliente:** gestión (`Payer`, `OrgAccess`), Mango (`Core`), miembros (`Member` por StackSet).
- **Verificadores:** `verify-release.sh` (quien instala), provisioner de packs y `mango-api` (firma de packs, sin red).
- **`UninstallGuard`:** Lambda de `Core` invocada por CloudFormation al borrar el stack.

### Data flows and trust boundaries

- Desarrollador → GitHub (`main`): código y definición de la release. HTTPS, autenticación de GitHub, revisión de PR. Sin validación automática del contenido más allá del CI.
- GitHub Actions → KMS del proveedor: hash de la declaración o del manifiesto a cambio de una firma. OIDC, rol limitado a `kms:Sign` sobre una llave.
- GitHub Actions → cuenta del proveedor: plantillas, zips, imagen. OIDC → `AssumeRoleWithWebIdentity`, limitado a repo, rama y entorno. Escritura condicional (`If-None-Match`).
- Cuenta del proveedor → principal del cliente: plantillas y assets por HTTPS de S3; imagen por ECR. Autorización por `aws:PrincipalOrgID`. Sin listado.
- Persona que instala → CloudFormation del cliente: URL de plantilla y parámetros. IAM del cliente. Validación por `AllowedPattern` y `Rules`.
- CloudFormation → recursos del cliente: crea IAM, red, datos. Con las credenciales de quien instala.
- CloudFormation → `UninstallGuard`: evento `Delete`. Solo CloudFormation puede invocarla.
- Release (dentro de la cuenta del cliente) → provisioner de packs: zip, declaración, bundle de firma, raíz de confianza. Verificación sin red.

#### Diagram

```mermaid
flowchart LR
  subgraph GitHub
    Repo[Repo main]
    CI[Actions release y packs]
  end
  subgraph Proveedor
    KMS[Llave de firma]
    Buckets[Buckets de release]
    ECR[ECR imagen]
  end
  subgraph Cliente
    Admin[Quien instala]
    CFN[CloudFormation]
    Core[Stack Core]
    Guard[UninstallGuard]
    Prov[Provisioner de packs]
  end
  Repo --> CI
  CI -->|firma| KMS
  CI -->|publica por OIDC| Buckets
  CI -->|sube imagen| ECR
  Admin -->|URL y parametros| CFN
  Buckets -->|plantilla y assets| CFN
  CFN --> Core
  ECR -->|imagen por digest| Core
  CFN -->|Delete| Guard
  Core --> Prov
```

## Assets and security objectives

| Asset | Why it matters | Security objective (C/I/A) |
|---|---|---|
| Plantillas de la release | Definen IAM, trusts y red en las cuentas del cliente, incluida la de gestión | I |
| Assets (Lambdas, SPA, packs) e imagen | Código que corre con los roles de Mango | I, C (repo privado) |
| Rol `Mango-provider-release-publisher` y workflow `release.yml` | Quien los controla publica para todos los clientes | I |
| Llave KMS de firma, sus roles y `packs/signing-key.pub` | Raíz de confianza de packs y manifiesto | I |
| Lista de organizaciones cliente | Decide quién lee el producto; es además un dato comercial | C, I |
| Parámetros de instalación | Fijan en quién confía cada trust y quién es el primer admin | I |
| Agentes, packs y datos de la instalación | Lo que `UninstallGuard` y la purga pueden borrar | A, I |
| Evidencia de auditoría (bucket con Object Lock) | No debe poder borrarse con la desinstalación sin un acto explícito | I, A |
| Disponibilidad del ECR y los buckets del proveedor | Sin ellos no se instala ni arrancan tareas nuevas | A |

## Attacker model

### Capabilities

- **Colaborador malicioso o cuenta de GitHub comprometida** con permiso de escritura en el repo: abre PR, y quizá ejecuta workflows en ramas.
- **Dependencia comprometida** (npm, PyPI, una action de GitHub) que corre dentro del build.
- **Atacante con credenciales de la cuenta del proveedor** (el administrador víctima de phishing, o el rol de publicación robado durante una ejecución).
- **Cliente o ex cliente** con lectura legítima de los buckets, o un principal cualquiera de su organización.
- **Persona de la cuenta del cliente** con permiso para actualizar o borrar stacks, pero no administradora de Mango.
- **Quien instala, por error:** parámetros equivocados.

### Non-capabilities

- No extrae la llave privada de KMS ni rompe ECDSA P-256.
- No controla AWS ni GitHub como plataformas.
- Un usuario de la aplicación (sin acceso a la consola de AWS del cliente) no alcanza nada de este componente: no hay ningún endpoint de `mango-api` que instale, actualice o desinstale (D21).
- Internet anónimo no lee los buckets ni el ECR (con lectura por organización).

## Entry points and attack surfaces

| Surface | How reached | Trust boundary | Notes | Evidence (repo path / symbol) |
|---|---|---|---|---|
| Workflow `release.yml` | Tag en `main` | GitHub → proveedor | Por construir. Modelo: job `sign` de `packs.yml` | `.github/workflows/packs.yml` |
| Workflow `packs.yml`, job `sign` | Merge a `main` | GitHub → KMS del proveedor | Firma con KMS por OIDC; la llave y el rol se mudan a la cuenta del proveedor | `.github/workflows/packs.yml`, `deployment/pack-builder/src/mango_pack_builder/kms.py` |
| Dependencias del build | `pnpm install`, `uv sync`, `docker build` | Internet → CI | Lockfiles con hashes; actions fijadas por SHA | `uv.lock`, `pnpm-lock.yaml`, `apps/api/Dockerfile` |
| Buckets y ECR del proveedor | API de S3 y ECR | Proveedor → cliente | Por construir | `deployment/provider/` (nuevo) |
| `TemplateURL` y parámetros de stack | Consola o CLI del cliente | Persona → CloudFormation | Hoy no hay parámetros: todo se hornea | `infra/bin/mango.ts`, `infra/lib/config/schema.ts` |
| Custom resources de siembra | CloudFormation | CloudFormation → DynamoDB | Put-if-absent, rol limitado por partición | `infra/lib/constructs/governance.ts` (`seedSettings`), `release-agents.ts` |
| Verificación de packs | Provisioner, `mango-api`, `dist` | Release → runtime | Hoy ECDSA con llave pública en la plantilla | `infra/lib/config/pack-release.ts`, `packages/py/mango-packs/src/mango_packs/signing.py` |
| `UninstallGuard` | Evento `Delete` de CloudFormation | CloudFormation → Lambda | Por construir; reutiliza el deprovisioner | `infra/lib/constructs/deprovisioner.ts`, `functions/provisioner/src/mango_provisioner/deprovision` |
| `purge-retained.sh` | Persona con credenciales de la cuenta | Persona → datos retenidos | Por construir | `deployment/` |

## Top abuse paths

1. **Release maliciosa por el workflow.** Atacante con escritura en el repo → logra un merge a `main` o un tag que dispara `release.yml` → el job publica plantillas con un trust de más en `Payer` → cada cliente que instala o actualiza le da acceso a su cuenta de gestión.
2. **Dependencia envenenada en el build.** Una action o un paquete comprometido corre en el job que construye → altera un zip de Lambda antes de calcular el manifiesto → el manifiesto firmado «certifica» código alterado.
3. **Sustitución en el bucket.** Atacante con credenciales de la cuenta del proveedor → sobrescribe `Core.template.json` de una versión publicada → el próximo `CreateStack` o `UpdateStack` de esa versión instala su plantilla.
4. **Imagen retirada o cambiada.** El mismo atacante borra la imagen o cambia la política del repositorio → las tareas de `mango-api` de todos los clientes no pueden reemplazarse → caída escalonada.
5. **Firma cruzada.** Quien controla el rol de firma de packs firma un manifiesto de release (o al revés) → si el verificador no distingue el tipo de lo firmado, un rol con menos controles vale para publicar.
6. **Parámetro de confianza equivocado.** Quien instala pone en `Payer` un `MangoAccountId` que no es el suyo → `Mango-<ns>-BillingReader` confía en otra cuenta (acotado por `aws:PrincipalOrgID` y `aws:PrincipalArn`).
7. **Primer admin ajeno.** `FirstAdminEmail` mal escrito → Cognito envía la contraseña temporal a un tercero, que entra como admin único.
8. **Borrado por reemplazo.** Una release cambia una propiedad o el id lógico de `UninstallGuard` → `UpdateStack` lo reemplaza → el `Delete` del recurso viejo borra todos los agentes y packs de una instalación en producción.
9. **Desinstalación como ataque.** Persona del cliente con `cloudformation:DeleteStack` pero sin rol en Mango → borra `Core` → agentes y packs desaparecen; con la purga, también los datos y la evidencia.
10. **Llave pública cambiada.** `packs/signing-key.pub` se cambia en un PR poco revisado por la llave del atacante → todo lo que él firme verifica.

## Threat model table

| Threat ID | Threat source | Prerequisites | Threat action | Impact | Impacted assets | Existing controls (evidence) | Gaps | Recommended mitigations | Detection ideas | Likelihood | Impact severity | Priority |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TM-D1 | Colaborador o cuenta de GitHub comprometida | Escritura en el repo o capacidad de crear tags | Dispara `release.yml` con contenido alterado | Código o IAM maliciosos en todos los clientes | Plantillas, assets, rol de publicación | Actions por SHA; entorno `pack-signing` para el job de firma (`packs.yml`) | No hay workflow de release ni reglas escritas para `main` y tags | Entorno `release` con aprobación manual; el rol confía solo en `repo:…:environment:release`; tags protegidos; el job que publica no ejecuta código del PR; `CODEOWNERS` sobre `.github/`, `deployment/provider/`, `packs/signing-key.pub` | Aviso por cada ejecución de `release.yml`; CloudTrail del proveedor: `AssumeRoleWithWebIdentity` fuera de una release | Media | Alta | **critical** |
| TM-D2 | Dependencia o action comprometida | Corre en el job de build | Altera un asset antes del manifiesto | El manifiesto firmado cubre código alterado | Assets, imagen | Lockfiles con hashes (`uv.lock`, `pnpm-lock.yaml`), wheels binarios (`bundle-python.sh`), `mise run audit` | El build no es verificable por un tercero; imagen base por tag (`python:3.13-slim`) | Build sin credenciales y job de publicación aparte que solo recibe artefactos; imágenes base por digest; builds deterministas (zips con orden y fechas fijas) para poder reconstruir y comparar; SBOM de la imagen | Reconstrucción periódica y comparación de hashes con el manifiesto | Baja | Alta | high |
| TM-D3 | Atacante con credenciales del proveedor | Administrador comprometido o rol robado | Sobrescribe o borra una clave publicada | Instalación de contenido alterado; reinstalaciones rotas | Plantillas, assets | Ninguno (no existe) | Todo | Política de bucket: `PutObject` solo con `s3:if-none-match`; versionado + Object Lock; el rol de publicación sin `DeleteObject*` ni `PutBucketPolicy`; manifiesto firmado y `verify-release.sh` antes de `CreateStack`; MFA y sin llaves de acceso en la cuenta | EventBridge sobre `PutBucketPolicy`, `DeleteObjectVersion`, `PutObjectRetention`; inventario diario comparado con los manifiestos | Baja | Alta | high |
| TM-D4 | El mismo | Ídem | Borra la imagen o cambia la política del repositorio | `mango-api` no reemplaza tareas en ningún cliente | Disponibilidad | Ninguno | Dependencia en runtime del proveedor | Tags inmutables; el rol de publicación no borra; parámetro `ApiImageRepository` para copiar la imagen a un ECR del cliente; documentarlo como dependencia | Alarma del cliente sobre tareas que no arrancan (`CannotPullContainerError`) al topic `Mango-<ns>-Alerts` | Baja | Media | medium |
| TM-D5 | Atacante con acceso a un rol de firma | Puede ejecutar el workflow con el entorno, o robar la sesión del rol | Firma un pack o un manifiesto ajeno; o usa la firma de un tipo como si fuera del otro | Pack o release ajenos aceptados | Llave de firma | Rol con trust por repo y entorno, solo `kms:Sign`; el job de firma no ejecuta código del pack; llave pública fija y catálogo por digest en la plantilla (`packs.yml`, `pack-release.ts`, D43); reglas de alerta de uso indebido | La llave vive hoy en la cuenta de gestión del cliente simulado; el manifiesto no se firma | Mudar llave, roles y alertas a la plantilla del proveedor; `payload_type` distinto para packs y manifiesto, comprobado por cada verificador; roles separados (el de packs no publica); política de la llave sin `kms:*` para administradores salvo gestión | Alertas de `kms:Sign` fuera de una ejecución de workflow; CloudTrail del proveedor | Baja | Alta | high |
| TM-D6 | PR malicioso o descuidado | Revisión débil | Cambia `packs/signing-key.pub` | Todo lo que firme el atacante verifica | Raíz de confianza | Revisión de PR | Sin protección específica | `CODEOWNERS` sobre `packs/signing-key.pub`; test que compara su huella con la de la llave del proveedor publicada en el runbook; `dist` falla si los packs no verifican con ella | Diff de la llave marcado en CI | Baja | Alta | medium |
| TM-D7 | (No aplica: firma sin llave descartada) | n/a | Dependencia de Sigstore para firmar y envejecimiento de su raíz | n/a | n/a | n/a | n/a | Motivo adicional del descarte | n/a | n/a | n/a | low |
| TM-D8 | Cliente, ex cliente o principal de su organización | Estar en la lista de lectura | Descarga el producto completo; un ex cliente sigue leyendo | Fuga del código (repo privado) | Assets, imagen, lista de clientes | Ninguno | Baja de clientes no definida | Lectura por `aws:PrincipalOrgID`; sin `ListBucket`; procedimiento de baja (quitar de la lista); aceptar que un cliente legítimo tiene el código que instala | Access logs del bucket: lecturas de organizaciones dadas de baja (denegadas) | Media | Baja | low |
| TM-D9 | (No aplica: firma sin llave descartada) | n/a | El registro público de Sigstore guardaría repo, workflow, rama y SHA para siempre | Divulgación permanente de metadatos | Confidencialidad del repo | n/a | n/a | Motivo del descarte (usuario, 2026-10-03) | n/a | n/a | n/a | low |
| TM-D10 | Quien instala (error) o atacante que le pasa valores | Parámetros de `Payer`, `OrgAccess` o `Core` | `MangoAccountId`, `OrganizationId` o `ManagementAccountId` equivocados | Trust hacia otra cuenta, o instalación que no funciona | Trusts cross-account | Trust con `AccountPrincipal` + `aws:PrincipalArn` + `aws:PrincipalOrgID` + `SourceIdentity` (`payer-stack.ts`, `member-stack.ts`) | Hoy los valores se validan al sintetizar (zod), no al instalar | `AllowedPattern` en cada parámetro; `Rules`: cuenta de gestión ≠ cuenta Mango, la cuenta Mango nunca es objetivo; `OrganizationId` siempre en la condición del trust; prueba de conectividad tras instalar | Ajustes › Conectividad muestra la cadena rota | Media | Media | medium |
| TM-D11 | Quien instala (error) | `FirstAdminEmail` o `SecondAdminEmail` ajeno | Un tercero recibe la contraseña temporal | Admin único de la instalación en manos ajenas | Primer admin | MFA obligatorio; contraseña temporal de 3 días (`identity.ts`) | El primer admin registra su TOTP sin segundo control | `AllowedPattern`; runbook: confirmar el correo antes de lanzar; el correo debe ser de `SignUpDomains` (`Rules` no puede comparar: lo comprueba un custom resource o el runbook); auditar el primer ingreso | Evento de primer ingreso de admin al topic de alertas | Baja | Alta | medium |
| TM-D12 | Quien instala | `SignUpDomains` con un dominio público | Cualquiera se registra | Cuentas sin rol (deny por defecto), ruido, costo de Cognito Plus | Directorio | Lista de dominios públicos en zod (`schema.ts`); sin grupo no hay acceso (D20) | La lista se aplica al sintetizar: con parámetros deja de aplicarse | Llevar la lista a la Lambda *pre sign-up* (rechaza aunque el parámetro lo permita) y a un custom resource que falle el stack | Métrica de registros por dominio | Media | Baja | low |
| TM-D18 | AgentCore retiene ENI | Packs habilitados poco antes de desinstalar | El borrado de la red de packs falla durante horas | Stack `PackNetwork` en `DELETE_FAILED`; reinstalación con el mismo namespace bloqueada | Disponibilidad de la reinstalación | Red de packs estática y aislada (`pack-network.ts`, D54) | Hoy bloquea el borrado de `Core` entero | Stack propio `Mango-<ns>-PackNetwork` importado por `Core`; runbook: repetir el borrado | Estado del stack | Media | Baja | low |
| TM-D13 | Release con un cambio en `UninstallGuard` | `UpdateStack` que reemplaza el recurso | CloudFormation envía `Delete` al recurso viejo | Se borran todos los agentes y packs de una instalación viva | Agentes, packs | Ninguno | El recurso no existe | El handler solo actúa si `DescribeStacks` dice `DELETE_IN_PROGRESS`; id físico fijo; sin propiedades que cambien; test de snapshot que falla si cambian su id lógico o sus propiedades; prueba e2e de actualización | Auditoría: evento por cada borrado del guard; alarma si ocurre con el stack en `UPDATE_*` | Baja | Alta | high |
| TM-D14 | Principal de la cuenta del cliente | `lambda:InvokeFunction` o poder pasar el rol del guard | Invoca el guard a mano o asume su rol | Borrado de agentes y packs sin desinstalar | Agentes, packs | Patrón del deprovisioner: rol propio que solo borra, por prefijo (`deprovisioner.ts`) | Por construir | Política de recurso: solo CloudFormation, con `aws:SourceArn` del stack; rol que solo confía en Lambda; permisos por prefijo `Mango-<ns>` y sin acceso a datos; la comprobación de TM-D13 también cubre este caso | CloudTrail: `Invoke` del guard fuera de un `DeleteStack` | Baja | Media | medium |
| TM-D15 | Principal del cliente con `DeleteStack`, sin rol en Mango | Permisos de CloudFormation | Borra `Core` y ejecuta la purga | Pérdida de la instalación y de la evidencia | Datos, auditoría | `RETAIN` + `deletionProtection` + PITR (AGENTS.md); Object Lock en auditoría (`governance.ts`) | La purga es un script: nada la frena salvo IAM | `EnableTerminationProtection` en `Core` (runbook); la purga exige `--confirm` y el namespace, y nunca fuerza `COMPLIANCE`; recomendar una SCP o permiso separado para borrar stacks `Mango-*` | CloudTrail: `DeleteStack` sobre `Mango-*` al topic de alertas | Baja | Alta | medium |
| TM-D16 | Atacante en la red de quien instala o enlace falso | La persona sigue un «Launch stack» que no es el de las notas | `TemplateURL` de un bucket del atacante con nombre parecido | Instalación de una plantilla maliciosa | Plantillas | Ninguno | Enlaces por definir | URL solo en las notas del release del repo; `verify-release.sh`; nombre de bucket publicado en el runbook; `Rules` no puede evitarlo: es educación y verificación | Revisión del `TemplateURL` en el evento `CreateStack` | Baja | Alta | medium |
| TM-D17 | Secreto en la release | Un valor sensible acaba en plantilla, asset o imagen | Lo leen todos los clientes | Fuga | Secretos | gitleaks en CI; regla «secretos solo en Secrets Manager»; `config.json` de la SPA con esquema estricto (`edge.ts`) | Las plantillas publicadas no se escanean | gitleaks sobre `dist/release/`; test: ninguna plantilla contiene ids de cuenta de 12 dígitos salvo el del proveedor, ni correos | Fallo del job de release | Baja | Media | low |
| TM-D19 | Cualquiera con cuenta de GitHub | El repositorio es público (D59): los logs de `release.yml` y de `packs.yml` se pueden leer | Lee el id de la cuenta del proveedor, el ARN del rol de publicación o el nombre del bucket de releases | Reconocimiento de la cuenta que distribuye a todos los clientes. No da acceso por sí solo (trust por `sub` y entorno; lectura del bucket por organización) | Identificadores de la cuenta del proveedor | Desde el 2026-10-05 (D59 (6)): rol, bucket y cuenta son secretos del entorno `release`; Actions enmascara cada aparición exacta, también dentro de una URL, del nombre del bucket regional o del registro de ECR; `mask-aws-account-id` en la action de credenciales; test que impide leerlos de `vars` (`test_workflows.py`) | Una forma transformada del valor (base64, otra codificación) no se enmascara. El manifiesto publicado nombra la cuenta y el bucket: lo leen los clientes, es necesario para instalar | No imprimir valores codificados en pasos nuevos; revisar los logs de la primera ejecución real de `release.yml` | Buscar el id de la cuenta y el nombre del bucket en los logs tras cada cambio del workflow | Baja | Baja | low |
| TM-D20 | Release anterior (fallida, de laboratorio o publicada con el rol robado) | Los assets de todas las releases comparten el prefijo `mango/assets/` y una clave no se sobrescribe (D69) | Deja bajo el nombre de un asset bytes que no son los que la release siguiente construye; la siguiente da la clave por buena | Una release con manifiesto firmado instalaría código que no construyó | Assets | El nombre sale del contenido (`assetHashType: OUTPUT`, bundle igual en todo checkout); `dist.py` sube con `If-None-Match` y, si la clave existe, compara su sha256 con el construido y **termina la release** si difiere, antes de subir plantillas o manifiesto (`put_asset`, tests en `deployment/tests/test_dist.py`); S3 comprueba el cuerpo contra el sha256 declarado al subir; el manifiesto firmado sigue nombrando el sha256 de cada asset | Quien tenga el rol de publicación puede ocupar el nombre de un asset futuro que conozca (el repositorio es público: los nombres se pueden calcular) y bloquear esa release. No instala nada: la release falla. `verify-release.py --bucket` no descarga los assets | Si una clave queda ocupada con otros bytes: publicar con otra sal de nombres (`-c @aws-cdk/core:assetHashSalt=<valor>` al sintetizar), que cambia todos los nombres una vez. Verificación de los assets publicados contra el manifiesto, desde el cliente | El mensaje de `dist.py` nombra la clave y los dos sha256; inventario del bucket de assets comparado con los manifiestos | Baja | Media (disponibilidad de la publicación; la integridad no baja) | medium |
| TM-D21 | Sesión robada del rol de publicación | El rol lee `mango/assets/*` del bucket regional (`s3:GetObject`, D69) | Descarga assets publicados | Ninguno nuevo: son los archivos que el propio rol sube y que leen las organizaciones cliente | Assets | Solo ese prefijo de ese bucket; sin listado; sin lectura de plantillas ni manifiestos, que se escriben una vez y no se comparan (`provider-stack.ts`, test en `provider.test.ts`) | Ninguno relevante | Ninguna | Access logs del bucket | Baja | Baja | low |
| TM-D22 | Quien opera una instalación (error) | La descripción de los stacks ya no nombra la release (D69) | Cree que `Payer` u `OrgAccess` corren una versión que no es | Una actualización de permisos que no se aplica, o una que se aplica sin hacer falta | Trusts entre cuentas | El manifiesto firmado da el sha256 de cada plantilla: dos releases con el mismo sha256 de `Payer` no necesitan actualizarlo; `Core` muestra la etiqueta en Ajustes › Instalación (`MANGO_RELEASE`); `MemberTemplateSha256` en `OrgAccess` | No hay un dato en el stack de la cuenta de gestión que diga su release | Runbook: comparar los sha256 de las plantillas entre el manifiesto instalado y el nuevo. Antes la descripción mentía (mostraba etiquetas viejas porque CloudFormation no acepta un cambio solo de descripción): no se pierde un control | Change set vacío al actualizar | Baja | Baja | low |

## Criticality calibration

- **Critical:** un tercero consigue que una release oficial lleve código o IAM suyos (TM-D1); o lee o escribe en la cuenta de gestión de un cliente a través de un trust mal puesto por la plantilla.
- **High:** alterar artefactos ya publicados (TM-D3), aceptar firmas de otra identidad (TM-D5), borrar una instalación en producción por una actualización (TM-D13), build envenenado (TM-D2).
- **Medium:** una clave de asset ocupada que bloquea una publicación (TM-D20); errores de parámetros que abren confianza acotada por otras condiciones (TM-D10, TM-D11), caída por dependencia del proveedor (TM-D4), borrado por alguien del cliente con permisos de CloudFormation (TM-D15).
- **Low:** lectura de assets por el rol que los publica (TM-D21), stacks sin etiqueta en la descripción (TM-D22), metadatos públicos del repo (TM-D9), identificadores del proveedor en logs públicos (TM-D19), lectura del código por clientes legítimos (TM-D8), registro abierto sin rol (TM-D12).

## Focus paths for security review

| Path | Why it matters | Related Threat IDs |
|---|---|---|
| `.github/workflows/release.yml` (nuevo) | Único camino de publicación; separación entre build y job con credenciales | TM-D1, TM-D2 |
| `.github/workflows/packs.yml` | Firma con el rol y la llave de la cuenta del proveedor | TM-D5 |
| `deployment/provider/` (nuevo) | Políticas de bucket y repositorio, trust del rol OIDC | TM-D1, TM-D3, TM-D4, TM-D8 |
| `packs/signing-key.pub` | Raíz de confianza de packs y manifiesto | TM-D5, TM-D6 |
| `packages/py/mango-packs/src/mango_packs/signing.py` | Verificación de firmas y del `payload_type` | TM-D5 |
| `infra/lib/config/pack-release.ts` | Catálogo por digest que fija la plantilla | TM-D5 |
| `infra/lib/params.ts` (nuevo) y `infra/lib/config/schema.ts` | Validaciones que pasan de zod a `AllowedPattern` y `Rules` | TM-D10, TM-D11, TM-D12 |
| `infra/lib/stacks/payer-stack.ts`, `member-stack.ts`, `org-access-stack.ts` | Trusts que pasan a depender de parámetros | TM-D10 |
| `functions/pre-sign-up` | Debe rechazar dominios públicos por sí misma | TM-D12 |
| `infra/lib/constructs/deprovisioner.ts` y el nuevo `UninstallGuard` | Permisos de borrado y condición de `DELETE_IN_PROGRESS` | TM-D13, TM-D14 |
| `deployment/purge-retained.sh` (nuevo) | Borra datos y evidencia | TM-D15 |
| `apps/api/Dockerfile` | Imágenes base por digest y fecha fija de los archivos | TM-D2 |
| `deployment/dist.py` (`put_asset`, `zip_directory`) y `deployment/bundle-python.sh` | Una clave de asset que ya existe se compara, no se supone; el bundle y el zip no dependen del checkout | TM-D20 |
| `infra/lib/release-target.ts`, `infra/lib/constructs/python-function.ts` | Prefijo de los assets y de qué sale su nombre | TM-D20 |

## Cuenta del proveedor: construida y revisada (2026-10-03)

Stack `Mango-provider` (`infra/lib/stacks/provider-stack.ts`), desplegado en una cuenta temporal de otra organización. Controles construidos, por amenaza:

- **TM-D1:** cada rol confía en un único `sub` exacto (repo por id y entorno) y `aud`; sin patrones. El rol de publicación solo tiene `s3:PutObject` en `mango/*`, subir la imagen y firmar. En GitHub, los entornos `pack-signing` y `release` están limitados por rama y exigen un revisor, y `main` está protegida (D59 (5); comprobado el 2026-10-05).
- **TM-D3:** deny de `PutObject` a todo principal que no sea el rol de publicación, y a toda escritura sin `If-None-Match`; versionado; en cuenta definitiva, Object Lock y deny de borrado. Alertas sobre cambios de política.
- **TM-D4:** tags inmutables; el rol de publicación no borra imágenes; alerta sobre `BatchDeleteImage` y cambios de política del repositorio.
- **TM-D5:** la política de la llave es toda la autorización: solo los dos roles firman, con `ECDSA_SHA_256` sobre un digest; `kms:Sign` y `kms:CreateGrant` negados al resto, administradores incluidos. Alerta de firma por otro principal. **Pendiente:** `payload_type` distinto para el manifiesto (al construir la firma del manifiesto).
- **TM-D8:** lectura solo por `aws:PrincipalOrgID`, sin listado; baja de un cliente con un `UpdateStack`.

Revisión del diff (`security-audit`, modo guía), dos ajustes aplicados: deny de borrado de objetos publicados (cuenta definitiva) y alerta de firma que también cubre principales que no son sesiones de rol.

Riesgos que quedan:

- Un administrador de la cuenta del proveedor puede cambiar la política de la llave o de los buckets. No se puede impedir desde el stack; se detecta (alertas), y exige que la cuenta tenga un trail de CloudTrail y que alguien lea el topic.
- `LocalPublisherArn` (opcional) deja que un rol humano de la cuenta publique. Solo para releases de laboratorio: vacío en la cuenta definitiva.
- En la cuenta temporal no hay Object Lock ni deny de borrado: un administrador puede borrar versiones.
- Reconocimiento de cdk-nag `AwsSolutions-ECR1` en el repositorio (principal `*` con condición de organización): **aprobado por el usuario el 2026-10-03** y registrado en la tabla de excepciones de `AGENTS.md`.

Comprobado con lecturas y escrituras reales: `deployment/provider/README.md` › «Comprobado».

## Assets compartidos entre releases e imagen reproducible: construido y revisado (2026-10-05)

D69. Los assets de todas las releases viven en `mango/assets/<hash>.zip` del bucket regional; las plantillas, el manifiesto y su firma siguen en `mango/<etiqueta>/` del bucket de plantillas.

**Qué cambia al compartir el prefijo, y qué no:**

- **No cambia quién lee ni quién escribe.** Las políticas de los buckets ya cubrían `mango/*`: no se tocaron. Ninguna etiqueta puede llamarse `assets` (las etiquetas empiezan por `v`).
- **No cambia la garantía del manifiesto:** sigue firmado y sigue nombrando clave, sha256 y tamaño de cada asset; `verify-release.py` falla igual ante cualquier diferencia.
- **Cambia que una clave ya publicada se reutiliza** (TM-D20). Antes cada release escribía todas sus claves; ahora la mayoría ya existen. Por eso `dist.py` dejó de omitir en silencio (`aws s3 cp --no-overwrite`): compara el sha256 y falla. El nombre de un asset garantiza su contenido solo desde D69; antes salía del directorio fuente y cinco assets conservaron el nombre con otros bytes entre dos releases.
- **Cambia el permiso del rol de publicación:** `s3:GetObject` sobre `mango/assets/*` del bucket regional (TM-D21). **Aprobado por el usuario el 2026-10-05.** Es más estrecho que lo aprobado (`mango/*` de los dos buckets): las plantillas y el manifiesto no se comparan, se escriben una vez.
- **Retirar una release ya no es borrar su prefijo:** sus assets pueden ser los de otras. En la cuenta definitiva nadie borra (Object Lock y deny); en una temporal, borrar por etiqueta solo quita plantillas y manifiesto.
- **El zip depende de la herramienta que comprime.** El mismo bundle comprimido con otra versión de zlib daría otros bytes bajo el mismo nombre: la release fallaría (TM-D20, disponibilidad). Las versiones de Python y uv están fijadas en `mise.toml`.

**TM-D2, imagen:** las imágenes base van por digest (`apps/api/Dockerfile`) y la imagen se construye con una fecha fija: las mismas fuentes dan el mismo digest (tres builds sin caché en dos checkouts, 2026-10-05). Un tercero puede reconstruirla y comparar. **No se reutiliza una imagen del registro por un tag derivado de sus entradas:** quien tuviera el rol de publicación una vez podría dejar una imagen bajo el tag de unas entradas futuras, y una release posterior, firmada, la nombraría. Se construye siempre; si nada cambió, el digest es el mismo y el push solo añade el tag de la etiqueta.

Revisión del diff (`security-audit`, modo guía): ver el informe de la tarea; hallazgos y ajustes en la descripción del PR.

## Desinstalación: construida y revisada (2026-10-03)

`UninstallGuard` (`infra/lib/constructs/uninstall-guard.ts`, `functions/provisioner/src/mango_provisioner/uninstall.py`) y el stack `Mango-<ns>-PackNetwork`.

- **TM-D13:** el recurso no tiene propiedades propias y la función solo actúa si `DescribeStacks` dice `DELETE_IN_PROGRESS`; en cualquier otro estado responde `SUCCESS` sin tocar nada (tests con cuatro estados de actualización). Un test falla si el recurso gana propiedades.
- **TM-D14:** sin `AWS::Lambda::Permission`: solo la invocan CloudFormation y ella misma. Su rol solo borra, por los prefijos de nombre de la instalación; los roles, además, solo si llevan uno de los dos boundaries de Mango. Sin `GetHarness` (un harness guarda el prompt), sin DynamoDB, S3 ni secretos. No toca los targets ni las políticas del Gateway que declara el stack, ni nada de otra instalación de la misma cuenta.
- **TM-D18:** la red de packs está en su propio stack; `Core` la importa y CloudFormation impide borrarla antes.
- Revisión del diff (`security-audit`, modo guía): un error que no sea «ya no existe» u «ocupado» hace fallar el borrado (fail-closed) y solo se registra el código, nunca el mensaje de AWS.

**Sin probar en AWS:** una desinstalación real con agentes y packs vivos, y que cuatro invocaciones encadenadas quepan en la hora de CloudFormation.

## Supuestos sin validar

- La protección de `main`, de los tags y de los entornos de GitHub.
- El pull de la imagen desde ECS Fargate en otra organización (la autorización del repositorio sí está comprobada).
- Que el handler del guard pueda distinguir siempre un borrado de stack de un reemplazo (estado del stack en el momento del evento).

Las prioridades reflejan las respuestas del usuario del 2026-10-03 (ver «Scope and assumptions»).

## Quality check

- Puntos de entrada cubiertos: workflows (TM-D1, D2, D5), buckets y ECR (D3, D4, D8), parámetros (D10–D12), enlace de instalación (D16), verificación (D5–D7), guard y purga (D13–D15), contenido publicado (D17), assets compartidos entre releases (D20–D22).
- Cada frontera aparece en al menos una amenaza: GitHub → proveedor (publicación y firma), proveedor → cliente, persona → CloudFormation, CloudFormation → guard, release → provisioner.
- CI y publicación separados del runtime: ningún endpoint de la aplicación participa.
- Supuestos explícitos; las preguntas abiertas las respondió el usuario el 2026-10-03.
