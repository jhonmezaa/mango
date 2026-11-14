# D127 · Agentes SRE y de bases de datos de la release, y sus packs

- **Estado:** propuesta
- **Fecha:** 2026-11-13 (pedido del dueño ese día: «con REA, sacar la lógica de los MCP de AWS para un agente SRE/SysOps/DevOps y uno de bases de datos, y desarrollarlos en Mango»; las opciones, elegidas por el agente principal la noche del 2026-11-13, por delegación del dueño para esa noche, «responde tú las preguntas», siempre la recomendada de los análisis; pendiente de que el dueño la acepte)
- **Precisa / reemplaza a:** precisa [D34](D034-guardrail-y-agentes-de-la-release.md) (dos agentes más en la release); [D51](D051-acceso-a-cuentas-miembro.md) (3) (acciones nuevas en `Mango-<ns>-ReadOnly`); [D54](D054-egress-de-packs.md) (3) y (6) (los endpoints de los packs nuevos se crean solo si la instalación habilita el pack; la región que el modelo omite la pone la guardia); [D55](D055-pack-de-cloudwatch.md) (3) (el pack de CloudWatch lee logs con límites duros). Usa [D126](D126-packs-de-codigo-propio.md) (packs de código propio)
- **Precisada por:** —

## Decisión

**Origen.** El análisis se hizo con REA sobre 30 wheels de `awslabs/mcp`: inventario, lectura del código y contraste de cada llamada con la referencia de servicios de IAM. Sus dos informes, uno de SRE y uno de bases de datos, están en la carpeta local del laboratorio, fuera del repositorio. Las acciones y los recursos de los manifiestos se comprueban otra vez al construir cada pack.

**(1) Dos agentes de la release.** Los dos son de solo lectura y centrales: sus packs son `central_only`, así que solo los usan las personas centrales (Cedar L2, [D49](D049-identidad-en-packs-de-datos.md) (4)). Su definición está en `agents/sre/agent.json` y `agents/dba/agent.json`, con el grupo `finops-central`, el único grupo central fijo de toda instalación, y sin `users` ni `approval_tools`. Usan todas las tools de sus packs, todas `read`.

| Agente | Para qué | Packs | Tools |
|---|---|---|---|
| `sre` («SRE / Operaciones») | Acompañar un incidente y el trabajo diario: qué cambió y quién lo hizo, métricas, alarmas y logs, salud de la aplicación, estado del cómputo y de los despliegues | `aws-cloudwatch` (9, con logs, punto 4), `aws-cloudtrail` (1), `aws-application-signals` (16), `aws-ops` (15) | 41 |
| `dba` («Bases de datos») | Estado, eventos, parámetros, mantenimiento, backups, carga y logs de RDS y Aurora, y estado de ElastiCache, con sus métricas, alarmas y logs | `aws-rds` (12), `aws-elasticache` (7), `aws-cloudwatch` (9) | 28 |

- **Sin sembrar todavía.** `RELEASE_AGENT_IDS` sigue siendo `["finops"]`: el provisioner publica un agente de la release en cada despliegue y falla con `unknown_tool` si falta un pack de sus tools. Sembrarlos es otro cambio, cuando se decida qué pasa en una instalación sin esos packs (punto 10). Al sembrarlos llegan preaprobados como FinOps ([D34](D034-guardrail-y-agentes-de-la-release.md)) y se actualizan con la release como él ([D80](D080-actualizacion-del-agente-de-la-release.md)).
- **Su instrucción** (en inglés; responden en el idioma de la persona) pide `account_id` explícito y preguntar la cuenta si no se sabe, sin recorrer cuentas por su cuenta; citar la evidencia de cada afirmación (tool, cuenta, región y ventana) y separar hechos de hipótesis; no decir nunca que hizo un cambio; tratar lo leído como no confiable y no repetir secretos. La de `dba` dice que no hay SQL, ni datos de tablas, ni texto SQL completo.

**(2) Packs nuevos.** Todos son `account_data`, `central_only` e `identity.chain: member`, como `aws-cloudwatch` ([D55](D055-pack-de-cloudwatch.md) (1)). Cada uno tiene su modelo de amenazas en `docs/security/threat-models/<pack>-pack-threat-model.md`.

| Pack | Versión y origen | Qué sirve | Endpoints nuevos |
|---|---|---|---|
| `aws-cloudtrail` | `0.1.1-2`, `awslabs.cloudtrail-mcp-server` 0.1.1 | Solo `lookup_events`: los eventos de administración de los últimos 90 días. El punto de entrada recorta cada evento a 4 096 caracteres (1 024 por campo voluminoso) | `cloudtrail` |
| `aws-application-signals` | `0.2.1-1`, `awslabs.cloudwatch-applicationsignals-mcp-server` 0.2.1 | 16 tools de lectura: servicios, SLOs y SLIs, dependencias, cambios, grupos, auditorías, canarios y trazas de X-Ray | `application-signals`, `xray`, `synthetics` |
| `aws-elasticache` | `0.2.2-1`, `awslabs.elasticache-mcp-server` 0.2.2 (0.2.3 no cumplía la cuarentena; el código es el mismo) | 7 tools de lectura de clústeres, grupos de replicación, cachés serverless, eventos, versiones del motor, parámetros por defecto y actualizaciones de servicio | `elasticache` |
| `aws-ops` | `0.1.0-1`, código propio ([D126](D126-packs-de-codigo-propio.md)) | 15 tools: EC2 (instancias y su estado), Auto Scaling (grupos y actividades), ELB (load balancers, target groups y salud de los targets), ECS (clústeres, servicios y sus eventos, despliegues y tareas paradas), CloudFormation (stacks y sus eventos) y Config (historial de un recurso) | `ec2`, `autoscaling`, `elasticloadbalancing`, `ecs`, `cloudformation`, `config` |
| `aws-rds` | `0.1.0-1`, código propio ([D126](D126-packs-de-codigo-propio.md)) | 12 tools: instancias y clústeres, eventos, parámetros cambiados, mantenimiento pendiente, snapshots, Performance Insights (métricas y mayores contribuyentes a la carga, con SQL **tokenizado**) y logs de la base (punto 5) | `rds`, `pi` |

Lo que cada pack deja fuera, y por qué, lo dice su manifiesto:

- `aws-cloudtrail`: fuera `lake_query` y sus tres tools de apoyo.
- `aws-application-signals`:
  - fuera las tools que leen logs de spans y de RUM, las de instrumentación dinámica (escriben, o leen valores de variables capturados) y las que firman peticiones fuera de botocore;
  - fuera `analyze_canary_failures`: descarga código del canario y lee la configuración de Lambda;
  - el punto de entrada neutraliza el log que el servidor escribe en disco.
- `aws-elasticache`:
  - fuera `test-migration`, que IAM clasifica Write aunque upstream la marque de solo lectura;
  - fuera la lectura de logs de cualquier log group;
  - el punto de entrada arregla el arranque con el perfil `default`.
- `aws-ops`, por lista permitida de campos en cada tool:
  - sin `ecs:DescribeTaskDefinition` (trae las variables de entorno), y las tareas paradas salen sin `overrides`, entorno ni IPs;
  - los stacks salen sin parámetros, los eventos sin `ResourceProperties` y el historial de Config sin valores de configuración;
  - de los tags, solo `Name`, `Environment` y los de AWS, y un valor con forma de secreto sale como `[redacted]`;
  - topes de elementos (50 por defecto), de ventana (168 h; 720 h en despliegues y Config) y de texto (500 caracteres).
- `aws-rds`, por lista permitida de campos:
  - nunca salen `MasterUserSecret`, `MasterUsername`, `KmsKeyId` ni la zona alojada;
  - fuera `pi:GetDimensionKeyDetails` (solo admite el SQL completo) y las recomendaciones;
  - toda respuesta cabe en 256 KB.

**(3) Lo que queda fuera, y por qué.**

- **CloudTrail Lake:**
  - `cloudtrail:StartQuery` es Write en IAM;
  - corre SQL libre que se cobra por GB escaneado;
  - el almacén de eventos suele estar en otra cuenta.
- **Redshift:** su Data API exige acciones que IAM clasifica Write (`redshift-data:ExecuteStatement`, `redshift:GetClusterCredentialsWithIAM`…). El rol de las cuentas miembro solo admite lectura exacta.
- **SQL sobre Aurora por la RDS Data API**, y los servidores de Postgres y MySQL:
  - piden `rds-data:*` (Write) y `secretsmanager:GetSecretValue`;
  - los servidores guardan el estado de conexión en memoria, compartido entre personas y cuentas.
- **Texto SQL completo de Performance Insights:** trae los literales de la sentencia, que es contenido. Solo se sirve el SQL tokenizado.
- **IAM de solo lectura:** lee los permisos de todas las cuentas objetivo. Se decide después, con su propio menú.
- **AWS Health:** no tiene endpoint de PrivateLink. Se hará como pieza de plataforma, con eventos de EventBridge guardados por Mango, sin pack.
- **`aws-network`:** está hecho con `fastmcp`, y servirlo en la cadena `member` exige ampliar `mango_pack_runtime`. Va después, si da tiempo.
- **Otros servidores de awslabs:**
  - ECS y EKS: mezclan escritura, o hablan con la API de Kubernetes.
  - Support: sin PrivateLink, y sus llamadas no heredan la identidad.
  - `call_aws`: genérico.
  - Prometheus: firma fuera de botocore.
  - Serverless: lanza procesos y descarga de GitHub.
  - SNS/SQS: una tool por operación de boto3.
  - Well-Architected de seguridad: estado global compartido entre personas.
  - DynamoDB, DocumentDB, Valkey, Memcached, Neptune, DSQL, Keyspaces, S3 Tables, Timestream, SQL Server, Oracle y Db2: conexión directa al motor, escritura, o no son de operación.

**(4) Leer logs con Logs Insights (precisa [D55](D055-pack-de-cloudwatch.md) (3)).** `aws-cloudwatch` pasa a `0.3.1-7` y de 7 a 9 tools; gana dos:

- `execute_log_insights_query`;
- `analyze_log_group`: detectores de anomalías y dos consultas fijas de patrones.

D55 (3) prohibía leer eventos de log. Era decisión del dueño, así que esta precisión queda `propuesta` hasta que él la acepte y no se instala antes. Cambia el `tools_hash` del pack: cada instalación lo vuelve a aprobar.

- **Límites duros en el punto de entrada** (`packs/aws-cloudwatch/entrypoint.py`), que upstream no trae. Se comprueban antes de llamar a AWS y también van en el esquema listado (`maximum`, `maxItems`, `required`):
  - ventana de 24 h como mucho, que empieza como mucho 30 días atrás; una hora sin zona se lee como UTC;
  - 5 log groups por consulta como mucho;
  - un ARN de log group solo de la cuenta que nombra `account_id` (los nombres, sin ARN, ya son de esa cuenta);
  - sin el comando `SOURCE logGroups(...)` en la consulta, que elige grupos por prefijo o por cuenta y se saltaría los dos límites anteriores;
  - `limit` obligatorio, de 200 filas como mucho;
  - `max_timeout` de 60 s como mucho.
- **Lo que vuelve al modelo:** las filas recortadas a `limit`, cada texto (mensajes, patrones y muestras de anomalías) cortado a 2 KB en UTF-8, y sin el `queryId`.
- **Fuera:**
  - `get_logs_insight_query_results` y `cancel_logs_insight_query`: aceptan el id de una consulta ajena de la misma cuenta;
  - el lote, que firma sin la identidad de quien llama;
  - las recomendaciones de índices.
- **Acciones:**
  - `logs:StartQuery` y `logs:GetQueryResults` sobre los log groups de la propia cuenta (`arn:aws:logs:*:${AWS::AccountId}:log-group:*`, sid `QueryLogGroups`);
  - `logs:ListLogAnomalyDetectors` y `logs:ListAnomalies` sobre sus detectores (`anomaly-detector:*`, sid `ListLogAnomalies`);
  - sin `logs:StopQuery`, `logs:DescribeQueries` ni `logs:Unmask`: los grupos con política de protección de datos siguen enmascarados.
- **Contenido:** lo que se lee entra en el contexto del modelo y en la conversación guardada, con su retención. Nunca va a logs operativos: [D16](D016-observabilidad-de-agentes.md) no cambia.

**(5) Logs y carga de la base.**

- `aws-rds` lee la cola de un archivo de log de una instancia (`tail_db_log_file`) con `rds:DescribeDBLogFiles` y `rds:DownloadDBLogFilePortion`, sobre el recurso `db` de la cuenta:
  - solo un archivo que esa instancia lista, por su nombre exacto;
  - solo la cola, sin paginar hacia atrás;
  - 200 líneas como mucho, cada una cortada a 2 KB, y 256 KB en total.
- Los logs de PostgreSQL y MySQL pueden traer sentencias con literales, usuarios e IP.
- Performance Insights agrupa la carga solo por `db.wait_event`, `db.wait_event_type`, `db.sql_tokenized` y `db.user`, con 25 grupos como mucho y cada sentencia cortada a 2 000 caracteres. `db.sql` lo rechazan el esquema y el código: IAM no lo puede impedir con las mismas acciones de PI, y el manifiesto no admite condiciones.

**(6) Rol de las cuentas miembro (precisa [D51](D051-acceso-a-cuentas-miembro.md) (3)).** Las acciones de los packs nuevos entran en `Mango-<ns>-ReadOnly`, en `MEMBER_READ_ONLY_STATEMENTS` (`infra/lib/stacks/member-stack.ts`), que pasa a 63 acciones:

- solo lectura exacta, comprobada en la referencia de servicios de IAM (todas Read o List);
- con el ARN de la propia cuenta donde la referencia da tipo de recurso, y `*` solo donde la API no lo admite, con un reconocimiento de `AwsSolutions-IAM5` por patrón, como [D55](D055-pack-de-cloudwatch.md) (4);
- sids nuevos: logs `QueryLogGroups` y `ListLogAnomalies`; `CloudTrailLookupEvents`; `ApplicationSignalsRead`, `ApplicationSignalsSlo` y `SyntheticsCanaryRuns`; `ElastiCacheResources` y `ElastiCacheCatalog`; `OpsInventory`, `OpsEcsClusters`, `OpsEcsServices`, `OpsEcsDeployments`, `OpsEcsTasks` y `OpsStackEvents`; `RdsInstances`, `RdsClusters`, `RdsParameters`, `RdsMaintenanceAndBackups`, `RdsEvents` y `PerformanceInsights`.

El test del rol (`infra/test/member-access.test.ts`) fija la lista exacta y sigue admitiendo solo `Get|List|Describe`, con cuatro excepciones nombradas con su decisión: `logs:StartQuery`, `cloudtrail:LookupEvents`, `xray:BatchGetTraces` y `rds:DownloadDBLogFilePortion`. Sigue prohibiendo `logs:StopQuery`, `DescribeQueries`, `FilterLogEvents`, `GetLogEvents`, `GetLogRecord`, `StartLiveTail` y `Unmask`, `pi:GetDimensionKeyDetails`, `ecs:DescribeTaskDefinition`, `cloudtrail:StartQuery` y los prefijos `rds-data`, `secretsmanager`, `redshift`, `lambda`, `s3` y `kms`.

**Techos del provisioner.** Con estas acciones, el techo de la cadena `member` no cabía en el entorno de la Lambda del provisioner (4 KB). Los dos techos (`member` y `payer`) pasan a constantes en su código (`functions/provisioner/src/mango_provisioner/packs/ceilings.py`); un test de infra los compara acción por acción con el rol de las cuentas miembro y con el lector de Billing.

Cambiar el rol es cambiar IAM en **todas** las cuentas miembro (StackSet de `OrgAccess`). Integrarlo en `main` no lo despliega. Desplegarlo en una instalación lo decide el dueño.

**(7) Endpoints condicionados por pack (precisa [D54](D054-egress-de-packs.md) (3)).**

- Los packs siempre encendidos son los que ya existían: `aws-pricing`, `aws-billing` y `aws-cloudwatch`. Sus endpoints no cambian.
- Cualquier otro pack de la release tiene en `Mango-<ns>-PackNetwork` un parámetro `Pack<Id>Network` (`Enabled` o `Disabled`, por defecto `Disabled`; por ejemplo `PackAwsRdsNetwork`). Sus endpoints, con su security group, y las reglas de salida de su grupo solo se crean si está encendido. Un endpoint que comparten varios packs existe si alguno está encendido. La allowlist del DNS Firewall sigue la misma condición.
- El security group de cada pack existe siempre: no cuesta nada y Core importa su export. Con el pack apagado solo alcanza sus logs y S3.
- Actualizar una instalación con los parámetros por defecto no crea ni borra ningún endpoint; solo añade el security group de cada pack nuevo, sus reglas hacia `logs` y S3, y su interruptor. Lo fija `infra/test/pack-network-switch.test.ts`.
- **Fallo cerrado.** La red escribe el interruptor de cada pack en SSM (`/Mango-<ns>-pack-network/<pack>`). El provisioner lo lee al verificar el pack (`ssm:GetParameter` sobre esos ARN, sid `ReadPackNetworkSwitches`) y, si no existe o no vale `Enabled`, falla con `pack_network_disabled`, que el catálogo muestra.
- **Encender uno:** `UpdateStack` de `PackNetwork` con el parámetro en `Enabled`, por change set, que solo debe añadir el endpoint, su security group, las reglas y la lista del DNS; después, habilitar el pack en la app. Apagarlo es al revés, esperando a que AgentCore suelte las ENI. En una instalación es un cambio en la cuenta del cliente: lo decide el dueño.
- Core con la red dentro (síntesis sin release) no conmuta nada: el etiquetador de [D77](D077-tags-del-stack-en-lo-que-cloudformation-no-etiqueta.md) espera a cada recurso de su stack y `DependsOn` no admite recursos condicionales.
- **Costo:** USD 7,30 por endpoint y zona; con dos zonas, unos USD 14,60 al mes por endpoint. Por pack:
  - `aws-cloudtrail` y `aws-elasticache`: ~15 cada uno;
  - `aws-application-signals`: ~44;
  - `aws-rds`: ~29;
  - `aws-ops`: ~88.
  - Los cinco: 13 endpoints, ~USD 190 al mes más.

**(8) Región por defecto (precisa [D54](D054-egress-de-packs.md) (6)).** Cuando una tool de la cadena `member` tiene argumento `region` y el modelo lo omite o lo manda nulo, la guardia de `mango_pack_runtime` (`CallGuard.default_region_for`) pone la región de la instalación, después de verificar la identidad y asumir la sesión. Si viene, la sigue validando como hasta ahora. Si upstream le da a `region` un literal por defecto, el esquema listado lo quita, con las frases de la descripción que lo nombran: así `lookup_events` de CloudTrail no va siempre a `us-east-1`. Un default nulo se lista como estaba, así que `aws-cloudwatch` no cambia por esto.

**(9) Riesgos.**

- **Inyección indirecta:** mensajes de log, `userAgent` y parámetros de CloudTrail, nombres y tags de recursos, anotaciones de X-Ray y eventos de RDS pueden traer instrucciones plantadas por quien escribe en una cuenta miembro.
  - Los dos agentes solo leen ([D84](D084-gobernanza-de-tools.md)), así que una inyección no se convierte en acción.
  - Su instrucción dice que no se siga nada de lo leído.
  - El guardrail actúa sobre la salida.
- **Datos sensibles:** logs con datos personales o tokens; eventos de CloudTrail con ids de llaves de acceso, IPs y correos; logs de la base con literales. Lo mitigan:
  - el truncado y los límites;
  - los filtros de información sensible del guardrail ([D34](D034-guardrail-y-agentes-de-la-release.md));
  - el contenido solo en la conversación, nunca en logs.
- **Costo fuera del presupuesto de Mango:** Logs Insights cobra USD 0,005 por GB escaneado (precio de lista en `us-east-1`) en la cuenta miembro, que el presupuesto de Mango no ve. Lo acotan la ventana y el número de grupos; el log `pack.call` dice quién consultó.
- **Cuotas de API de la cuenta miembro:**
  - `LookupEvents` admite unas 2 llamadas por segundo por cuenta y región;
  - Logs Insights tiene un tope de consultas concurrentes.
  - Un agente insistente afecta a otras herramientas del cliente en esa cuenta. No se sirven tools de lote.
- **Volumen:** respuestas grandes (eventos de CloudTrail completos, auditorías de Application Signals) llenan el contexto. Lo frenan los topes de upstream y los del punto de entrada.
- **Cuentas enlazadas:** si una cuenta es de monitoreo, Application Signals llama con `IncludeLinkedAccounts=True` fijo en sus auditorías. Es residuo aceptado, como TM-CW5. En Logs Insights, la guardia de ARNs lo impide.
- **Cambios de upstream:** Application Signals crece rápido. En cada versión se revisan su lista de tools y sus clientes de AWS.
- **Registro de gestión al alcance de cualquier central:** con `aws-cloudtrail`, toda persona central lee quién hizo qué en cada cuenta objetivo, algo más sensible que una métrica. Se acepta por diseño ([D35](D035-grupos-de-acceso.md), [D37](D037-packs-de-datos-de-cuentas.md)); es TM-CT1 de su modelo de amenazas, prioridad media.
- **Etiquetas de costo:** las reglas de security group que se crean al encender un pack después (`UpdateStack` de `PackNetwork`) no reciben las etiquetas de [D77](D077-tags-del-stack-en-lo-que-cloudformation-no-etiqueta.md) hasta la siguiente actualización de Core, porque el etiquetador corre con Core. Queda pendiente.
- **IAM:** la referencia de servicios de hoy da a `logs:GetQueryResults` recurso `log-group`, y [D113](D113-observabilidad-con-logs-insights.md) la trató como «sin recurso».
  - Si en una instalación no autoriza por ARN, las tools de logs no funcionan.
  - En ese caso no se pone `*`: hacerlo sería una excepción nueva, que decide el dueño.

**(10) Falta ver en una instalación.** Nada se instaló. Falta ver:

- que los 13 endpoints existen en la región de la instalación, y que `application-signals` y `config` admiten política de endpoint (la documentación no lo dice; si no la admiten, el `UpdateStack` que enciende el pack falla y se revierte, y quitar la política sería una excepción de seguridad);
- que cada acción acotada por ARN autoriza la llamada real, sobre todo `logs:GetQueryResults` sobre `log-group` y las de Performance Insights sobre `metrics/rds/*`;
- que cada pack lee una cuenta miembro por la cadena `member`, con la persona en el CloudTrail de esa cuenta;
- que la guardia rellena la región;
- los límites de logs con datos reales, que el enmascaramiento sin `Unmask` se mantiene y el costo real de una consulta;
- que Config y Performance Insights están activos en las cuentas del cliente: sin ellos, esas tools responden vacío;
- y cómo se siembran los dos agentes en una instalación que no tiene sus packs: dejar la versión `failed` hasta un `retry`, o sembrar sin publicar mientras falten, lo que cambia el provisioner.
