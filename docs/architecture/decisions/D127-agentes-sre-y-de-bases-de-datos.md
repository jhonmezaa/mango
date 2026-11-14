# D127 · Agentes SRE y de bases de datos de la release, y sus packs

- **Estado:** propuesta
- **Fecha:** 2026-11-13 (pedido del dueño ese día: «con REA, sacar la lógica de los MCP de AWS para un agente SRE/SysOps/DevOps y uno de bases de datos, y desarrollarlos en Mango»; las opciones, elegidas por el agente principal la noche del 2026-11-13, por delegación del dueño para esa noche, «responde tú las preguntas», siempre la recomendada de los análisis; pendiente de que el dueño la acepte)
- **Precisa / reemplaza a:** precisa [D34](D034-guardrail-y-agentes-de-la-release.md) (dos agentes más en la release); [D51](D051-acceso-a-cuentas-miembro.md) (3) (acciones nuevas en `Mango-<ns>-ReadOnly`); [D54](D054-egress-de-packs.md) (3) y (6) (los endpoints de los packs nuevos se crean solo si la instalación habilita el pack; la región que el modelo omite la pone la guardia); [D55](D055-pack-de-cloudwatch.md) (3) (el pack de CloudWatch lee logs con límites duros). Usa [D126](D126-packs-de-codigo-propio.md) (packs de código propio)
- **Precisada por:** —

## Decisión

**Origen.** El análisis se hizo con REA sobre 30 wheels de `awslabs/mcp`: inventario, lectura del código y contraste de cada llamada con la referencia de servicios de IAM. Sus dos informes, uno de SRE y uno de bases de datos, están en la carpeta local del laboratorio, fuera del repositorio. Las acciones y los recursos de los manifiestos se comprueban otra vez al construir cada pack.

**(1) Dos agentes de la release.** Los dos son de solo lectura y centrales: sus packs son `central_only`, así que solo los usan las personas centrales (Cedar L2, [D49](D049-identidad-en-packs-de-datos.md) (4)). Llegan preaprobados como FinOps ([D34](D034-guardrail-y-agentes-de-la-release.md)) y se actualizan con la release como él ([D80](D080-actualizacion-del-agente-de-la-release.md)).

| Agente | Para qué | Packs |
|---|---|---|
| `sre` (SRE / Operaciones) | Acompañar un incidente y el trabajo diario: qué cambió y quién lo hizo, métricas, alarmas y logs, salud de la aplicación, estado del cómputo y de los despliegues | `aws-cloudwatch` (con logs, punto 4), `aws-cloudtrail`, `aws-application-signals`, `aws-ops` |
| `dba` (Bases de datos) | Estado, eventos, parámetros, mantenimiento, backups, carga y logs de RDS y Aurora, y estado de ElastiCache | `aws-rds`, `aws-elasticache`, `aws-cloudwatch` (métricas de RDS y ElastiCache) |

La lista final de tools de cada agente la fija su definición en `agents/<id>/agent.json`. Ninguno tiene tools de escritura.

**(2) Packs nuevos.** Todos son `account_data`, `central_only` e `identity.chain: member`, como `aws-cloudwatch` ([D55](D055-pack-de-cloudwatch.md) (1)). Ninguno cambia el provisioner.

| Pack | Origen | Qué sirve | Endpoints nuevos |
|---|---|---|---|
| `aws-cloudtrail` | `awslabs.cloudtrail-mcp-server` 0.1.1 | Solo `lookup_events`: los eventos de administración de los últimos 90 días | `cloudtrail` |
| `aws-application-signals` | `awslabs.cloudwatch-applicationsignals-mcp-server` 0.2.1 | 16 tools de lectura: servicios, SLOs, dependencias, cambios, auditorías, canarios y trazas de X-Ray | `application-signals`, `xray`, `synthetics` |
| `aws-elasticache` | `awslabs.elasticache-mcp-server` 0.2.3 | 7 tools de lectura de clústeres, grupos de replicación, cachés serverless y eventos | `elasticache` |
| `aws-ops` | Código propio ([D126](D126-packs-de-codigo-propio.md)) | EC2 (instancias y su estado), Auto Scaling (grupos y actividades), ELB (target groups y salud de los targets), ECS (clústeres, servicios, despliegues y tareas, con su motivo de parada), CloudFormation (stacks y sus eventos) y Config (historial de un recurso y estado de las reglas). Sin `ecs:DescribeTaskDefinition` | `ec2`, `autoscaling`, `elasticloadbalancing`, `ecs`, `cloudformation`, `config` |
| `aws-rds` | Código propio ([D126](D126-packs-de-codigo-propio.md)) | Instancias y clústeres (sin `MasterUserSecret`), eventos, parámetros cambiados, mantenimiento pendiente, recomendaciones, snapshots, Performance Insights (carga, métricas y top SQL **tokenizado**) y logs de la base (punto 5) | `rds`, `pi` |

Lo que cada pack upstream deja fuera, y por qué, lo dice su manifiesto:

- `aws-cloudtrail`: fuera `lake_query` y sus tres tools de apoyo.
- `aws-application-signals`:
  - fuera las tools que leen logs de spans y de RUM, las de instrumentación dinámica (escriben, o leen valores de variables capturados) y las que firman peticiones fuera de botocore;
  - fuera `analyze_canary_failures`: descarga código del canario y lee la configuración de Lambda;
  - el punto de entrada neutraliza el log que el servidor escribe en disco.
- `aws-elasticache`:
  - fuera `test-migration`, que IAM clasifica Write aunque upstream la marque de solo lectura;
  - fuera la lectura de logs de cualquier log group;
  - el punto de entrada arregla el arranque con el perfil `default`.

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

**(4) Leer logs con Logs Insights (precisa [D55](D055-pack-de-cloudwatch.md) (3)).** `aws-cloudwatch` gana dos tools:

- `execute_log_insights_query`;
- `analyze_log_group`: detectores de anomalías y dos consultas fijas de patrones.

D55 (3) prohibía leer eventos de log. Era decisión del dueño, así que esta precisión queda `propuesta` hasta que él la acepte y no se instala antes.

- **Límites duros en el punto de entrada**, que upstream no trae:
  - ventana de 24 h como mucho;
  - 5 log groups por consulta como mucho;
  - `limit` obligatorio, de 200 filas como mucho;
  - cada mensaje truncado a 2 KB;
  - `max_timeout` de 60 s como mucho;
  - un ARN de log group solo de la cuenta que nombra `account_id`.
- **Fuera:**
  - `get_logs_insight_query_results` y `cancel_logs_insight_query`: aceptan el id de una consulta ajena de la misma cuenta;
  - el lote, que firma sin la identidad de quien llama;
  - las recomendaciones de índices.
- **Acciones:**
  - `logs:StartQuery` y `logs:GetQueryResults` sobre los log groups de la propia cuenta (`arn:aws:logs:*:${AWS::AccountId}:log-group:*`);
  - `logs:ListLogAnomalyDetectors` y `logs:ListAnomalies` sobre sus detectores;
  - sin `logs:StopQuery` ni `logs:DescribeQueries`.
- **Contenido:** lo que se lee entra en el contexto del modelo y en la conversación guardada, con su retención. Nunca va a logs operativos: [D16](D016-observabilidad-de-agentes.md) no cambia.

**(5) Logs de la base.** `aws-rds` lee los archivos de log de una instancia con `rds:DescribeDBLogFiles` y `rds:DownloadDBLogFilePortion`, sobre el recurso `db` de la cuenta. Los límites son los del punto 4: la cola del archivo, 200 líneas como mucho y cada una truncada a 2 KB. Los logs de PostgreSQL y MySQL pueden traer sentencias con literales, usuarios e IP.

**(6) Rol de las cuentas miembro (precisa [D51](D051-acceso-a-cuentas-miembro.md) (3)).** Las acciones de los packs nuevos entran en `Mango-<ns>-ReadOnly`:

- en `MEMBER_READ_ONLY_STATEMENTS`, con un `sid` por pack;
- solo lectura exacta, con el ARN de la propia cuenta donde la referencia de IAM admite recurso;
- `*` solo donde la API no lo admite, con reconocimientos granulares de `AwsSolutions-IAM5` como [D55](D055-pack-de-cloudwatch.md) (4).

El test del rol, que hoy solo admite `Get|List|Describe` y que ningún permiso lea contenido de log, se amplía solo para lo decidido aquí, citando esta decisión. Las acciones nuevas que no empiezan por esos verbos son `logs:StartQuery`, `cloudtrail:LookupEvents`, `xray:BatchGetTraces` y `rds:DownloadDBLogFilePortion`. La lista exacta de acciones y recursos está en `infra/lib/stacks/member-stack.ts`.

Cambiar el rol es cambiar IAM en **todas** las cuentas miembro (StackSet de `OrgAccess`). Integrarlo en `main` no lo despliega. Desplegarlo en una instalación lo decide el dueño.

**(7) Endpoints condicionados por pack (precisa [D54](D054-egress-de-packs.md) (3)).**

- Cada pack nuevo tiene un parámetro del stack `PackNetwork`, apagado por defecto. Sus endpoints, y las reglas de security group que dependen de ellos, solo se crean si está encendido. Un endpoint que comparten varios packs existe si alguno de ellos está encendido.
- Los endpoints de los packs que ya existían (`aws-pricing`, `aws-billing`, `aws-cloudwatch`) no cambian. Actualizar una instalación con los parámetros por defecto no crea ni borra nada.
- Habilitar en la app un pack cuya red está apagada falla cerrado, con un mensaje que lo dice.
- Encender uno en una instalación es un cambio en la cuenta del cliente: lo decide el dueño.
- **Costo:** USD 7,30 por endpoint y zona; con dos zonas, unos USD 14,60 al mes por endpoint. Por pack:
  - `aws-cloudtrail` y `aws-elasticache`: ~15 cada uno;
  - `aws-application-signals`: ~44;
  - `aws-rds`: ~29;
  - `aws-ops`: ~88.
  - Los cinco: 13 endpoints, ~USD 190 al mes más.

**(8) Región por defecto (precisa [D54](D054-egress-de-packs.md) (6)).** Cuando una tool tiene argumento `region` y el modelo lo omite, la guardia de `mango_pack_runtime` lo rellena con la región de la instalación. Si viene, la sigue validando como hasta ahora. Sin esto, `lookup_events` de CloudTrail iría siempre a `us-east-1`, el valor fijo de upstream.

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
- **IAM:** la referencia de servicios de hoy da a `logs:GetQueryResults` recurso `log-group`, y [D113](D113-observabilidad-con-logs-insights.md) la trató como «sin recurso».
  - Si en una instalación no autoriza por ARN, las tools de logs no funcionan.
  - En ese caso no se pone `*`: hacerlo sería una excepción nueva, que decide el dueño.

**(10) Falta ver en una instalación.** Nada se instaló. Falta ver:

- que los 13 endpoints existen y admiten política de endpoint en la región de la instalación;
- que cada acción acotada por ARN autoriza la llamada real, sobre todo `logs:GetQueryResults` sobre `log-group` y las de Performance Insights sobre `metrics/rds/*`;
- que cada pack lee una cuenta miembro por la cadena `member`, con la persona en el CloudTrail de esa cuenta;
- que la guardia rellena la región;
- los límites de logs con datos reales y el costo real de una consulta;
- que Config y Performance Insights están activos en las cuentas del cliente: sin ellos, esas tools responden vacío;
- y que un agente de la release con un pack sin habilitar se comporta como se espera.
