# MCP packs

Un **MCP pack** es un servidor MCP de terceros (hoy, los de `awslabs/mcp`) que Mango fija, revisa, empaqueta y firma en su CI para hospedarlo en AgentCore Runtime de la instalación (D19, `docs/specs/marketplace-v1.md` §4).

Aquí vive el **formato** y el **pipeline**. Habilitar un pack en una instalación (rol, Runtime, target del Gateway) es trabajo del provisioner de packs: ver «Instalación».

Nunca se instala un paquete `uvx`/pip en la cuenta del cliente: lo único que llega es el zip firmado de esta carpeta.

Modelo de amenazas: `docs/security/threat-models/mcp-pack-pipeline-threat-model.md`.

## Qué hay en un pack

```
packs/<id>/
├── manifest.yaml        # qué es el pack y qué puede hacer (fuente de su IAM y de sus tools)
├── requirements.in      # una línea: el paquete upstream con versión exacta
├── requirements.lock    # todas las dependencias, con versión y hashes
├── entrypoint.py        # punto de entrada propio para AgentCore Runtime
├── tools.snapshot.json  # lo que respondió tools/list, para revisar cambios en un diff
├── constraints.txt      # opcional: cotas superiores para el lock (ver «Restricciones del lock»)
└── build.yaml           # opcional: zip comprimido (ver «Tamaño del zip»)
```

`packs/signing-key.pub` (ver «Firma») es la llave pública con la que se verifican todos los packs.

### Manifiesto

El esquema es `PackManifest` en `packages/py/mango-packs/src/mango_packs/manifest.py`. Es estricto: un campo desconocido es un error.

| Campo | Regla |
|---|---|
| `id` | Igual al nombre de la carpeta |
| `version` | `<versión upstream>-<revisión de Mango>`, p. ej. `1.1.1-2`. La revisión sube cuando cambia algo nuestro (punto de entrada, tools permitidas) sin cambiar la versión upstream |
| `source` | Paquete, versión, `sha256` del wheel y `exclude_newer` (corte de la resolución) |
| `data_tier` · `identity_mode` | `public` va con `service` y solo con él. `account_data` y `write` exigen `central_only` o `per_user_adapter` |
| `identity.chain` | Solo en packs `central_only`. `payer` (por defecto; no se escribe): broker de Billing → `Mango-<ns>-BillingReader` en la pagadora. `member`: broker de lectura → `Mango-<ns>-ReadOnly` de la cuenta miembro que pide cada llamada (D51). Va firmado; cambiarlo en un pack instalado exige deshabilitar y habilitar de nuevo |
| `iam` | Acciones **exactas** (`servicio:Acción`), sin comodines. `resources: ["*"]` solo con `reason`. En un pack `service` son los permisos de su rol. En uno `central_only` son el tope de cada llamada (session policy): su rol no recibe ninguna |
| `egress` | Todo lo que el Runtime puede alcanzar (R6). `aws`: servicios de una lista cerrada (`AwsEndpoint`), cada uno con su endpoint de VPC en la red de packs. `hosts`: nombres de host fuera de AWS, sin comodines ni IP; **un pack que declare alguno no se instala todavía**. Obligatorio, aunque esté vacío. Un pack `central_only` necesita `sts`. Ver «Red de los Runtimes» |
| `tools` | Lista cerrada de tools, cada una `read` o `write`. Las `write` solo en `data_tier: write` |
| `tools_hash` | Hash del snapshot de `tools/list` |
| `config` | Parámetros que el admin puede fijar: clave, valores permitidos y valor por defecto. Nunca secretos |

`runtime` tiene un único valor posible (Python 3.13, arm64, MCP en `0.0.0.0:8000/mcp`): es el contrato de AgentCore Runtime.

### Punto de entrada

Los servidores de awslabs solo hablan stdio. El punto de entrada importa el objeto `mcp` del paquete y lo sirve por streamable HTTP sin estado. No hace falta fork ni puente stdio→HTTP.

Además **quita toda tool que no esté en el manifiesto** antes de arrancar, y no arranca si falta una de las permitidas. La lista permitida viaja dentro del zip (`pack.json`, generado desde el manifiesto).

Quedan fuera las tools que leen o escriben el sistema de archivos del servidor y las que salen a la web (R6).

### Packs de datos de cuentas (`central_only`, D37)

Un pack que lee datos de cuentas actúa **como la persona que preguntó**, nunca con su propio rol (regla 5). Su punto de entrada usa el código común `mango_pack_runtime` (`packages/py/mango-pack-runtime`), que el build copia dentro del zip junto con `mango_aws`:

```python
from mango_pack_runtime.server import load

pack = load()  # antes de importar el servidor: nada de lo que cree verá el rol del pack

from awslabs.some_mcp_server.server import mcp  # noqa: E402

pack.serve(mcp)
```

Qué hace en cada `tools/call`:

1. Solo sirve las tools del manifiesto y quita el argumento reservado `_mango_ctx` antes de llamar a la tool upstream.
2. Exige en `_mango_ctx` una **aserción de identidad** firmada por el interceptor del Gateway (usuario, pack, tool, agente, 60 s) y la verifica con la llave pública que recibe del provisioner. El pack nunca recibe el token del usuario ni puede firmar.
3. Asume el broker de la instalación con `SourceIdentity` = usuario y una session policy igual a las sentencias `iam` del manifiesto. Las credenciales valen para esa llamada.
4. Mientras corre la tool, **cualquier** cliente de boto3 del proceso firma con esas credenciales (también uno creado antes o guardado entre llamadas). Fuera de una llamada con identidad verificada, firmar falla: no hay vuelta al rol del pack, que de todos modos no tiene permisos de datos.

Reglas para un pack así:

- `requirements.lock` debe fijar `boto3` y `cryptography` (el código común no añade dependencias; `check` lo comprueba).
- Las acciones `iam` deben estar en la lista del rol detrás del broker (`BILLING_READER_DATA_ACTIONS` en `infra/lib/stacks/payer-stack.ts`). Si faltan, se añaden ahí y se despliega el stack de la cuenta pagadora. Ese rol también lo usan el conector de Cost Explorer y la sonda de administración, así que añadir una acción es un cambio de IAM con revisión de seguridad: solo acciones exactas de lectura que existan en la referencia de servicios de IAM, con ARN donde el servicio los admita (un test de infra lo comprueba).
- El servidor debe ejecutar sus tools en la tarea de la petición o en hilos que hereden su contexto (`anyio.to_thread`, `asyncio.to_thread`). El servidor de prueba de `packages/py/mango-pack-runtime/tests/test_server.py` cubre los patrones de awslabs; un servidor con otra librería repite esa prueba antes de publicarse.
- Los prompts y recursos de MCP no pasan por la guardia: un pack así no sirve ninguno.
- **Sus esquemas de entrada no pueden ser cerrados** (`additionalProperties: false`). El Gateway valida los argumentos contra el esquema que lista el pack **después** de que su interceptor añade `_mango_ctx`, y con un esquema cerrado rechaza todas las llamadas (visto en el laboratorio con Billing). `snapshot` falla si un pack de datos de cuentas lista uno.
- Sin los datos que entrega el provisioner (broker, región y llave pública), el pack lista sus tools y **rechaza toda llamada**. Así corre el snapshot del build.

Modelo de amenazas: `docs/security/threat-models/pack-identity-threat-model.md`.

#### Packs sobre cuentas miembro (`identity.chain: member`, D51)

Un pack de esta cadena lee **una cuenta miembro por llamada**. Todo lo anterior aplica; además:

- **`account_id` es un argumento de Mango**, no del servidor upstream. El punto de entrada lo añade como obligatorio al esquema de cada tool (12 dígitos) y la guardia lo quita antes de la tool. Si una tool upstream ya tiene un argumento con ese nombre, el pack no arranca.
- **El destino es siempre `Mango-<ns>-ReadOnly` de esa cuenta.** El Runtime recibe el nombre del rol (`MANGO_PACK_TARGET_ROLE_NAME`), nunca un ARN, y el broker de lectura (`MANGO_PACK_BROKER_ROLE_ARN`).
- **La cuenta se valida por formato y por IAM** (usuario, 2026-10-02): 12 dígitos y nunca la cuenta Mango; que sea una cuenta que Mango puede leer lo decide IAM en esa misma llamada (el rol solo existe donde el StackSet lo desplegó y el broker solo asume dentro de la organización). La sesión se asume **antes** de que corra la tool, y cualquier fallo responde el mismo mensaje fijo.
- **`region`** pasa a la tool, pero solo si tiene forma de nombre de región (el esquema listado lleva el mismo patrón) y **es la región de la instalación**. La red de packs solo tiene endpoints de esa región (R6): otra región se rechaza antes de asumir la sesión, con un mensaje que dice cuál se puede leer (usuario, 2026-10-02).
- **Argumentos ocultos.** El punto de entrada nombra los argumentos de upstream que el modelo nunca debe fijar (`load(hidden_arguments=…)`): no se listan y la guardia los quita. En CloudWatch: `profile_name` (otras credenciales) y `account_identifiers` e `include_linked_accounts` (otras cuentas, por la observabilidad entre cuentas).
- Las acciones `iam` deben estar en la lista del rol de las cuentas miembro (`MEMBER_READ_ONLY_STATEMENTS` en `infra/lib/stacks/member-stack.ts`). Añadir una exige desplegar de nuevo el StackSet (`deployment/deploy-org-access.sh`) y es un cambio de IAM en **todas** las cuentas objetivo: solo acciones exactas de lectura, con decisión registrada si leen contenido.
- Solo lo sirve `mango_pack_runtime.server` (SDK oficial de MCP). El adaptador de `fastmcp` no arranca un pack de esta cadena.
- La prueba está en `packages/py/mango-pack-runtime/tests/test_member.py`.

Tools que sirve `aws-cloudwatch` (revisión `0.3.1-2`: las mismas tools que la `-1`; declara su `egress` y solo lee la región de la instalación), todas de lectura:

| Tools | Servicio | Notas |
|---|---|---|
| `get_metric_data`, `analyze_metric`, `get_recommended_metric_alarms` | CloudWatch (`GetMetricData`) | `GetMetricData` se cobra por métrica pedida, en la cuenta miembro |
| `get_metric_metadata` | — | Lee un archivo del propio paquete; aun así exige `account_id` y asume la sesión, como toda llamada |
| `get_active_alarms`, `get_alarm_history` | CloudWatch (`DescribeAlarms`, `DescribeAlarmHistory`) | — |
| `describe_log_groups` | CloudWatch Logs (`DescribeLogGroups`, `DescribeQueryDefinitions`) | Nombres, retención y tamaño de log groups y las consultas guardadas. **Ningún evento de log** |

Quedan fuera, a propósito: Logs Insights y todo lo que lee contenido de logs (usuario, 2026-10-02), las recomendaciones de índices (ejecutan consultas) y PromQL (firma peticiones HTTP propias con `requests`, fuera de botocore). El motivo de cada una está en el manifiesto.

Lo que el punto de entrada de `aws-cloudwatch` cambia del servidor, además: **sin logs de upstream** (registra argumentos, nombres de alarmas y la lista completa de log groups y consultas guardadas).

Al revisar una versión nueva: los argumentos de cada tool servida (uno nuevo que elija credenciales, cuenta o endpoint se añade a `HIDDEN_ARGUMENTS`), qué operaciones de AWS llama y `aws_common.py`.

Una cuenta objetivo que sea **cuenta de monitoreo** (observabilidad entre cuentas de CloudWatch) deja ver, con Metrics Insights, métricas de sus cuentas origen aunque no sean objetivo (TM-CW5).

Modelo de amenazas: `docs/security/threat-models/aws-cloudwatch-pack-threat-model.md`.

#### Servidores hechos con `fastmcp` (Billing)

El servidor de Billing no usa el SDK oficial de MCP sino la librería `fastmcp`, y monta un servidor por familia de tools con un paso `setup()`. Su punto de entrada usa `mango_pack_runtime.fastmcp_server`:

```python
from mango_pack_runtime.server import load

pack = load()

from awslabs.billing_cost_management_mcp_server.server import mcp, setup  # noqa: E402

from mango_pack_runtime.fastmcp_server import serve  # noqa: E402

setup()
serve(pack, mcp)
```

- **Lista de permitidos, no de quitados.** `serve` deja visibles solo las tools del manifiesto. Las demás tools, los prompts y los recursos del servidor y de los servidores montados quedan ocultos y no se pueden llamar. Si después de eso el servidor lista algo distinto del manifiesto, no arranca.
- **La guardia es el primer middleware.** Ningún otro código del servidor ve `_mango_ctx`, y una tool de un servidor montado corre dentro de ella.
- **Esquemas abiertos en `tools/list`.** `fastmcp` lista esquemas cerrados; `serve` quita `additionalProperties: false` de lo que lista un pack de datos de cuentas, para que el Gateway deje pasar `_mango_ctx`. Solo cambia el listado: el servidor sigue validando cada llamada con el esquema propio de la tool, ya sin `_mango_ctx`, y rechaza argumentos que la tool no declara.
- **Logs.** `fastmcp` copia al log del servidor todo mensaje que una tool envía al cliente (`ctx.info`, `ctx.error`), sea cual sea el nivel; ese logger se descarta. Solo queda el registro `pack.call` (quién llamó a qué, D16).
- La prueba de aislamiento está en `packages/py/mango-pack-runtime/tests/test_fastmcp_server.py`, con la misma versión de `fastmcp` que fija el lock del pack (`fastmcp==` en el `pyproject.toml` de la raíz). **Al actualizar el pack, se actualiza esa versión y se repite la prueba.**

Tools que sirve `aws-billing` (revisión `0.0.38-5`: las mismas tools que la `-3`; la `-4` cambió el código común que viaja en su zip y la `-5` declara su `egress`), todas de lectura:

| Tools | Servicio | Notas |
|---|---|---|
| `cost-explorer`, `cost-anomaly`, `sp-performance`, `ri-performance`, `cost-comparison` | Cost Explorer | — |
| `budgets`, `budget-notifications` | AWS Budgets | Solo los presupuestos de la cuenta pagadora |
| `compute-optimizer` | Compute Optimizer | Necesita el servicio activo en la pagadora. Acepta `region`. AWS comprueba además al llamador contra las acciones que listan cada tipo de recurso (EC2, Auto Scaling, RDS, ECS): están en el manifiesto y en el rol, pero ninguna tool las llama. **`lambda:ListFunctions` no está, a propósito** (devuelve las variables de entorno de las funciones de la pagadora): las recomendaciones de Lambda pueden responder `AccessDenied` |
| `cost-optimization` | Cost Optimization Hub | Necesita la pagadora inscrita |

Mango nunca inscribe la pagadora en un servicio. Quedan fuera las tools que guardan estado entre llamadas (`session-sql`), las que escriben o arrancan trabajos (`storage-lens`, `sp-recommendation`, `sp-purchase-analyzer`) y las que piden acciones que el rol detrás del broker no tiene; la lista y el motivo de cada una están en el manifiesto.

Lo que el punto de entrada de `aws-billing` cambia del servidor, además:

- **Sin base de datos de sesión.** Upstream guarda en un SQLite del proceso las respuestas de más de 25 KB, para leerlas con la tool `session-sql`: un usuario leería lo que consultó otro. El umbral se fija por encima de cualquier respuesta, `session-sql` no se sirve y el pack no arranca si upstream deja de respetar el umbral.
- **Sin logs de upstream.** Escribe un archivo de log junto a su código y registra argumentos y errores de AWS, con los valores de las variables en los tracebacks. Se quitan todos sus destinos.
- Al revisar una versión nueva: `utilities/sql_utils.py` y `utilities/logging_utils.py` de upstream, además de las tools. Por cada tool servida: qué operaciones de AWS llama (cada una debe tener su acción en el manifiesto y ninguna puede escribir) y qué argumentos acepta. Si una acepta `region`, comprobar con el botocore del lock nuevo que un valor que no sea un nombre de host se rechaza.

Modelo de amenazas: `docs/security/threat-models/aws-billing-pack-threat-model.md`.

## Pipeline

`deployment/build-pack.sh` ejecuta estos pasos, en este orden. Localmente: `mise run pack -- packs/aws-pricing dist/packs`.

| Paso | Qué comprueba |
|---|---|
| `check` | Manifiesto válido; `requirements.in` fija solo el paquete declarado; el lock fija **todo** por hash y contiene el wheel declarado; cuarentena cumplida; `constraints.txt` y `build.yaml`, si existen, son válidos |
| `check-lock` | Volver a resolver con el mismo corte da el mismo lock. Nadie editó el lock a mano |
| `build` | Zip reproducible con wheels `aarch64-manylinux2014` (`uv pip install --require-hashes --no-deps --only-binary :all:`) |
| `pip-audit` | Sin vulnerabilidades conocidas en las versiones fijadas. Genera el SBOM (CycloneDX) |
| segundo `build` | El zip es idéntico byte a byte |
| `snapshot` | Arranca el servidor **en un contenedor sin red** y compara su `tools/list` con el manifiesto: mismas tools y mismo `tools_hash` |
| `statement` | Escribe lo que se va a firmar: manifiesto + hash del zip, del SBOM y del lock + commit |

### Cuándo se construye y cuándo se firma

El workflow `.github/workflows/packs.yml` construye los tres packs en cada ejecución y, en `main`, los firma. Cada firma espera la aprobación del dueño (entorno `pack-signing`), así que un `push` a `main` solo lo arranca por lo que puede cambiar un byte de un zip o de una declaración firmada (D36, 2026-10-09):

| Ruta | Qué pone en un pack |
|---|---|
| `packs/**` | Manifiesto, lock, punto de entrada, `build.yaml`, `constraints.txt` y la llave pública con la que `sign` verifica |
| `deployment/build-pack.sh`, `deployment/pack-builder/**` | Los pasos y el builder: qué se instala, qué se copia, cómo se escribe el zip y la declaración |
| `packages/py/mango-packs/**` | El esquema del manifiesto y la forma de la declaración que se firma |
| `packages/py/mango-pack-runtime/**`, `packages/py/mango-aws/**` | Se copian dentro del zip de los packs de datos de cuentas |
| `.github/workflows/packs.yml` | El runner, los pasos y la firma |

**`mise.toml` y `uv.lock` no arrancan el workflow en un `push`.** Casi nada de ellos llega a un pack: las dependencias del zip salen del `requirements.lock` de cada pack, nunca de `uv.lock`. Lo que sí llega está anotado en el archivo testigo `deployment/pack-builder/toolchain.toml`:

- de `mise.toml`, la versión de **Python** (el builder escribe el zip con su `zipfile` y su zlib) y la de **uv** (desempaqueta los wheels);
- de `uv.lock`, las de **`pydantic`, `pydantic-core` y `pyyaml`** (leen el manifiesto y escriben la declaración).

`deployment/pack-builder/tests/test_toolchain.py` falla mientras el testigo no diga lo mismo que esos dos archivos. **Para subir una de esas versiones se cambia también el testigo, en el mismo commit:** el testigo sí está entre las rutas, y los packs se construyen y se firman de nuevo. Un cambio en cualquier otra parte de `mise.toml` o `uv.lock` (una tarea, una dependencia de la API) no deja firmas esperando.

Un pull request no firma nunca. Conserva los dos archivos entre sus rutas: construye los packs y comprueba que el zip sale idéntico dos veces y que `tools/list` es el del manifiesto.

`test_workflows.py` fija las dos listas de rutas y que cada paquete del repositorio que el builder usa esté en la de `push`. Un pack o un paquete nuevo que entre en un zip añade su ruta a las dos.

La release toma los packs firmados de la última ejecución correcta de este workflow en `main` (`release.yml`); sus artefactos se conservan 90 días.

### Snapshot sin red

El servidor upstream es código de terceros. En CI (`.github/workflows/packs.yml`, runner arm64) el snapshot arranca **el zip construido** dentro de un contenedor:

- `--network none`: no puede salir a internet ni alcanzar el runner;
- sistema de archivos de solo lectura; el zip se monta en solo lectura; sin capabilities, sin escalar privilegios y como usuario `nobody`;
- sin variables de entorno del runner;
- imagen `python:3.13.15-slim` fijada por digest (`CONTAINER_IMAGE` en `snapshot.py`).

Dentro corre `probe.py` (solo librería estándar): arranca el punto de entrada, pide `tools/list` e imprime el resultado. El builder, fuera del contenedor, trata esa salida como dato no confiable y la compara con el manifiesto.

En una máquina de desarrollo se usa por defecto el mismo lock en un venv local, que basta para comparar `tools/list`. Con Docker en arm64 (p. ej. un Mac con Apple silicon) se puede usar el mismo contenedor que el CI:

```sh
MANGO_PACK_SNAPSHOT=container mise run pack -- packs/aws-pricing dist/packs
```

**Cuarentena de 7 días.** `source.exclude_newer` debe tener al menos 7 días. Con ese corte, `uv` ignora todo lo publicado después, también en las dependencias transitivas. Un parche de seguridad puede saltarla declarando `source.quarantine_exception` con el CVE o GHSA; queda en el manifiesto firmado y se revisa en la PR.

**Reproducible** quiere decir que cualquiera, con este repositorio en el mismo commit, obtiene el mismo zip y puede comparar su hash con el firmado. Por eso el zip va sin comprimir por defecto (60 MB en Pricing; el límite del Runtime es 250 MB): la salida de la compresión depende de la librería que comprime.

### Tamaño del zip

Un pack que no cabe sin comprimir declara `compression: deflate` en su `build.yaml` (usuario, 2026-10-02). Hoy, solo `aws-cloudwatch`: 304 MB sin comprimir por `numpy`, `pandas`, `scipy` y `statsmodels`; 97 MB comprimido.

- Nivel fijo (9), mismas entradas, mismo orden y mismas fechas que un zip sin comprimir.
- Los bytes son los mismos con cualquier versión del zlib de referencia, que es el que trae CPython (comprobado con 1.2.12 y 1.3.1). Con otra librería (p. ej. zlib-ng) el zip sale distinto: el job `sign` reconstruye el zip y lo compara byte a byte con el que probó `build`, así que ese caso **falla el build**, nunca firma otra cosa.
- `build.yaml` no forma parte del manifiesto firmado: la firma cubre el hash del zip que produce.

### Restricciones del lock

`constraints.txt` (opcional) acota por arriba la versión de una dependencia cuando su última versión no publica wheel para la plataforma del Runtime (`aarch64-manylinux2014`). Solo admite líneas `nombre<versión`: no puede añadir paquetes, índices, URLs ni hashes, y no puede nombrar el paquete upstream. El lock sigue fijando todo por hash, y `check-lock` lo vuelve a resolver con las mismas cotas.

En `aws-cloudwatch`: `numpy`, `pandas`, `scipy` y `statsmodels` solo publican wheels arm64 para `manylinux_2_28` desde hace varias versiones. `pip-audit` no reporta vulnerabilidades en las versiones fijadas. **Al actualizar el pack, revisar si las cotas siguen haciendo falta** (si AgentCore documenta otra plataforma) y repetir la auditoría.

Los cambios en `packs/`, `packages/py/mango-packs/`, `deployment/` y `.github/workflows/` requieren revisión de sus dueños (`.github/CODEOWNERS`).

## Firma

Se firma una declaración por pack con una **llave asimétrica de KMS** (`ECC_NIST_P256`, `ECDSA_SHA_256`) de la cuenta del proveedor. La llave privada no sale de KMS.

El resultado es `<id>-<versión>.pack.json`: un sobre DSSE con la declaración y la firma. La instalación solo necesita la **llave pública**: el provisioner verifica sin llamar a KMS ni salir de la cuenta (`mango_packs.signing.verify_envelope` y `verify_file`).

El job `sign` del workflow:
- solo corre en `main`, dentro del environment `pack-signing`, que solo admite esa rama, y solo cuando el `push` cambia algo que entra en un pack o lo construye (ver «Cuándo se construye y cuándo se firma»);
- **no ejecuta código del pack**: reconstruye el zip y la declaración desde el commit y exige que el zip sea idéntico al que probó el job `build`;
- asume el rol de firma por OIDC justo antes de firmar, sin llaves de larga duración;
- verifica la firma con `packs/signing-key.pub` antes de publicar nada.

Mientras la variable del repositorio `PACK_SIGNING_ENABLED` no valga `true`, el job no corre y los packs quedan sin firmar. Sin `packs/signing-key.pub`, además, ninguna instalación puede habilitar un pack.

### Infraestructura de firma

Vive en la **cuenta de AWS del proveedor**, fuera de la organización de cualquier cliente (D58), región `us-east-1`, dentro del stack `Mango-provider`. No forma parte de ninguna instalación. El ARN del rol es un secreto del entorno `pack-signing`, no está en el código ni en una variable del repositorio: los logs de un repositorio público son públicos, y Actions imprime las variables y solo enmascara los secretos (D59). La llave se nombra por su alias, porque el sobre firmado guarda el id de la llave (`signature.key_id`) y se sube como artefacto, donde nada se enmascara. Hasta el 2026-10-03 estuvo, creada a mano, en la cuenta de management del laboratorio: esa llave se retiró y los packs se firmaron de nuevo con la actual.

| Recurso | Nombre | Qué hace |
|---|---|---|
| Llave de KMS | `alias/mango-provider-signing` | `ECC_NIST_P256`, `SIGN_VERIFY`. Su política solo deja firmar a los roles de firma, con `ECDSA_SHA_256` sobre un digest. La cuenta la administra pero tiene `kms:Sign` y `kms:CreateGrant` denegados |
| Proveedor OIDC | `token.actions.githubusercontent.com` | Audiencia `sts.amazonaws.com` |
| Rol | `Mango-provider-pack-signing` | Confía solo en ese proveedor, con `aud` y `sub` exactos. Sin política propia: la política de la llave le da `kms:Sign` y `kms:GetPublicKey` |
| Regla de EventBridge | `Mango-provider-signing-misuse` | Avisa de un `kms:Sign` sobre la llave hecho por otro principal (también los denegados) (TM-P9) |
| Regla de EventBridge | `Mango-provider-signing-key-change` | Avisa de cualquier `PutKeyPolicy`, `CreateGrant`, `DisableKey` o `ScheduleKeyDeletion` |
| Regla de EventBridge | `Mango-provider-role-change` | Avisa de cambios en el trust o en los permisos del rol de firma |
| Topic de SNS | `Mango-provider-alerts` | Destino de las reglas. Necesita al menos una suscripción confirmada |
| Environment de GitHub | `pack-signing` | Solo despliega la rama `main` |
| Secreto del entorno `pack-signing` | `PACK_SIGNING_ROLE_ARN` | Lo lee el job `sign`. Secreto y no variable: lleva el id de la cuenta y los logs son públicos |
| Variables del repositorio | `PACK_SIGNING_ENABLED` (`true` activa el job), `PACK_SIGNING_REGION` | Sin datos de la cuenta: un `if:` de job no puede leer secretos |

Detalles que no son obvios:

- **`sub` inmutable.** El repositorio emite el `sub` con identificadores numéricos: `repo:<owner>@<owner id>/<repo>@<repo id>:environment:pack-signing`. El trust usa ese valor exacto, no `repo:<owner>/<repo>:…`. Renombrar o recrear el repositorio no hereda la confianza. El prefijo se consulta con `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`.
- **Sesión.** IAM no admite menos de 3600 s como máximo del rol; el workflow pide 900 s.
- **Revisores y protección de `main`: hay que activarlos.** El repositorio es público (D59), así que GitHub ofrece ambos sin costo. Deben quedar activos antes de crear el secreto de firma y poner `PACK_SIGNING_ENABLED` en `true`: `main` protegida (PR obligatorio, revisión de los dueños de `CODEOWNERS`, checks de CI obligatorios, sin force-push) y el environment `pack-signing` limitado a `main` con un revisor obligatorio. Sin eso, todo `push` a `main` que toque los packs se firma sin aprobación manual.
- **El trust apunta al repositorio público.** El `sub` del trust de `Mango-provider-pack-signing` es el del repositorio nuevo (D59), con sus identificadores numéricos, y es el único: el del repositorio privado anterior se quita. Cómo cambiarlo: `deployment/provider/README.md`.
- **Rotar la llave** es crear otra, cambiar la política, las variables y `packs/signing-key.pub` por PR, y volver a firmar los packs. KMS no rota llaves asimétricas.

Packs de la release: `aws-pricing` (datos públicos, modo `service`), `aws-billing` (datos de cuentas, modo `central_only`, cadena `payer`) y `aws-cloudwatch` (datos de cuentas, modo `central_only`, cadena `member`).

Verificar a mano un pack firmado (los tres archivos en la misma carpeta):

```sh
uv run python -m mango_pack_builder verify \
  --envelope dist/packs/aws-pricing-1.1.1-1.pack.json --public-key packs/signing-key.pub
```

## Instalación

Lo hace el provisioner de packs (`functions/provisioner/src/mango_provisioner/packs/`, máquina de estados `Mango-<ns>-PackProvisioner`), por SDK. Modelo de amenazas: `docs/security/threat-models/mcp-pack-provisioner-threat-model.md`.

**Cómo llega un pack a la instalación (D36).** La release trae, en `dist/packs/`, el sobre firmado (`<id>-<versión>.pack.json`), el zip y el SBOM. Al sintetizar la plantilla:
- se verifica cada sobre con la llave pública de la release (`packs/signing-key.pub`) y que el zip sea el firmado;
- CloudFormation copia los tres archivos a `packs/<id>/<versión>/` del bucket de packs de la instalación;
- la plantilla lleva la llave pública y el **catálogo de la release**: por cada pack, su versión y el sha256 de su declaración firmada.

Sin llave pública el catálogo queda vacío y no se puede instalar nada. Una instalación de cliente solo confía en la llave de la release; el laboratorio puede indicar otra en su configuración (`packs.signingPublicKey`).

**Qué comprueba antes de instalar.** Nada de esto sale de la petición del admin:
- la firma del sobre, con la llave de la plantilla, y que la declaración sea **exactamente** la que nombra el catálogo. Un pack antiguo, aunque esté bien firmado, no se instala (sin rollback);
- el zip, leído en una versión concreta del objeto de S3, contra el hash y el tamaño firmados. El Runtime se crea con esa misma versión;
- que el pack solo tenga tools de lectura y sea `public` (modo `service`) o de datos de cuentas en modo `central_only`. Las tools de escritura y `per_user_adapter` se rechazan;
- que el pack tenga su red (R6): la plantilla construye un security group por pack de la release a partir de su `egress` firmado, y sin él no se instala (`egress_unavailable`). Un pack que declare hosts fuera de AWS se rechaza (`external_egress_unsupported`); la síntesis de una release que lo traiga falla. Ya no hay excepción de laboratorio: ningún Runtime de pack usa la red `PUBLIC`;
- que todas las acciones IAM del manifiesto estén en la lista cerrada de su modo: la del permissions boundary de packs (`PACK_DATA_ACTIONS` en `infra/lib/constructs/pack-platform.ts`) para un pack `service`, o la del rol detrás del broker de su cadena para uno `central_only` (`BILLING_READER_DATA_ACTIONS` en la cadena `payer`, `MEMBER_READ_ONLY_DATA_ACTIONS` en la cadena `member`). **Un pack nuevo que necesite otras acciones las añade ahí, en la misma PR**;
- que una actualización no cambie la cadena de un pack instalado (`identity_chain_changed`): se deshabilita y se habilita de nuevo;
- que los parámetros pedidos sean claves del manifiesto con un valor de su lista. Llegan al Runtime como `MANGO_PACK_CONFIG_<CLAVE>`; el entorno del Runtime es una lista cerrada.

**Qué crea**, en este orden: rol `Mango-<ns>-mcp-<id>` (con el boundary `Mango-<ns>-mcp-boundary`), Runtime `Mango_<ns>_mcp_<id>` desde el zip en modo `VPC` (subnets de la red de packs y el security group del pack; una versión con otra red no se expone: `runtime_network_mismatch`), comprobación de `tools/list` contra `tools_hash`, endpoint `live`, log groups con KMS y retención, target `<id>` del Gateway con SigV4 y, al final, las políticas Cedar `Mango_<ns>_mcp_<id>_<n>`. Hasta ese último paso las tools están denegadas.

Si algo falla, deshace lo creado (o vuelve a la versión instalada, si era una actualización) y deja el paso y el código del error en la habilitación. Deshabilitar borra políticas, target, Runtime y rol.

Un pack **nunca recibe el token del usuario**: el interceptor del Gateway solo lo inyecta en los conectores de Mango. Un pack `central_only` recibe en su lugar la aserción de identidad descrita arriba; su rol solo puede asumir el broker de su cadena (nunca los dos), sus políticas Cedar solo permiten a usuarios centrales (y lo repiten como `forbid`), y el Runtime recibe además `MANGO_PACK_BROKER_ROLE_ARN`, `MANGO_PACK_REGION`, `MANGO_PACK_IDENTITY_PUBLIC_KEY` y el destino: `MANGO_PACK_TARGET_ROLE_ARN` (cadena `payer`) o `MANGO_PACK_TARGET_ROLE_NAME` (cadena `member`). El trust de cada broker nombra el ARN exacto de los roles de los packs de su cadena. El puntero de lo instalado guarda el nivel de datos y el modo de identidad de la versión que sirve.

### Red de los Runtimes (R6)

Un pack es código de terceros que lee datos de cuentas. Su Runtime corre en una **VPC propia sin internet gateway ni NAT** (`infra/lib/constructs/pack-network.ts`): lo único que alcanza son endpoints de VPC. Modelo de amenazas: `docs/security/threat-models/pack-egress-threat-model.md`.

- **Qué alcanza cada pack lo dice su manifiesto firmado** (`egress.aws`). La plantilla crea un endpoint de interfaz por servicio declarado en la release y un security group por pack, que solo deja salir por HTTPS hacia los endpoints de ese pack, el de CloudWatch Logs (sus propios logs) y S3 (de donde AgentCore carga el código). Cada endpoint solo acepta a los packs que lo declaran.
- **Solo principals de la organización.** La política de cada endpoint exige `aws:PrincipalOrgID`: una credencial que el pack traiga de fuera se rechaza. El endpoint de S3 solo deja a AgentCore leer sus buckets de código: un pack no puede usar S3.
- **DNS Firewall** con allowlist de los nombres de esos endpoints; el resto responde `NXDOMAIN`.
- **Solo la región de la instalación.** Un endpoint de interfaz sirve la API de su región y de ninguna otra.
- **Todo es estático en la plantilla (D25):** el provisioner solo nombra las subnets y el security group del pack (`PACK_NETWORK`). La red solo existe si la release trae packs.
- **IAM también lo exige:** el rol del provisioner solo puede crear o actualizar un Runtime con subnets y security groups de la red de packs. Una petición en modo `PUBLIC` se deniega. Sin packs en la release no puede crear Runtimes.
- **Configuración** (`packs.network` de la instalación): `cidr` (un `/22` privado; por defecto `10.210.0.0/22`) y `availabilityZoneIds` (dos o tres **ids** de zona donde AgentCore admite el modo VPC; por defecto `use1-az1` y `use1-az2`).
- **Costo:** USD 0,01 por hora por endpoint y zona (~USD 7,30 al mes). Con los tres packs de hoy son 8 endpoints en 2 zonas: ~USD 117 al mes, más USD 0,01 por GB.
- **Servicio nuevo:** añadirlo a `AwsEndpoint` (`manifest.py`) y a `PACK_EGRESS_SERVICES` (`pack-network.ts`), con el nombre DNS que usa el SDK. Un test compara las dos listas. Debe existir como endpoint de interfaz en la región, con política de endpoint.
- **Borrar un pack de la release:** AgentCore conserva las interfaces de red de un Runtime borrado hasta 8 horas, y mientras tanto CloudFormation no puede borrar su security group. Deshabilitar el pack y esperar antes de desplegar una release que ya no lo trae.

Prueba: `tests/e2e/pack_egress.py` (ver `docs/runbooks/poc-deploy.md`).

## Actualizar un pack

1. Cambiar `source.version` y `version` en el manifiesto y la línea de `requirements.in`. Poner `source.exclude_newer` en una fecha de hace 7 días o más, posterior a la publicación de esa versión.
2. `uv run python -m mango_pack_builder lock packs/<id>` y copiar a `source.sha256` el hash del wheel.
3. `uv run python -m mango_pack_builder snapshot packs/<id> --update`.
4. Revisar el diff de `tools.snapshot.json`: es lo que leerá el modelo. Si hay tools nuevas, decidir si se permiten y con qué acciones IAM. Actualizar `tools_hash`.
   - Para `aws-billing`: poner la misma versión de `fastmcp` del lock nuevo en el `pyproject.toml` de la raíz, `uv lock` y correr `packages/py/mango-pack-runtime/tests/test_fastmcp_server.py`.
5. `mise run pack -- packs/<id> dist/packs`.

Un `tools_hash` distinto obliga a aprobar de nuevo el pack en cada instalación (D19, D26).

## Agregar un pack

Copiar la estructura de `aws-pricing`, añadir el pack a la matriz de `.github/workflows/packs.yml` y, antes, revisar el código upstream: qué tools leen archivos, salen a la web o aceptan `profile`, `region` o rutas como argumentos del modelo, y **a qué APIs llama** (su `egress`: si falta un servicio, la llamada no sale; si el servidor necesita internet para arrancar, no arranca). Un pack de datos de cuentas usa el punto de entrada común (arriba) y necesita además su modelo de amenazas. Uno sobre cuentas miembro declara `identity.chain: member` y oculta los argumentos que elijan credenciales, cuenta o endpoint.
