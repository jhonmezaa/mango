# D126 · Packs de código propio de Mango

- **Estado:** propuesta
- **Fecha:** 2026-11-13 (propuesta por el agente principal la noche del 2026-11-13, por delegación del dueño para esa noche, «responde tú las preguntas»: preguntas P3 del análisis SRE y P1 del de bases de datos, opción recomendada; pendiente de que el dueño la acepte)
- **Precisa / reemplaza a:** precisa [D19](D019-catalogo-de-mcp.md) (2) (un MCP pack puede ser código de Mango, no solo un servidor de terceros fijado por versión), [D36](D036-artefacto-y-firma-de-packs.md) (el zip lleva el código del repositorio en lugar del paquete upstream; el artefacto y la firma no cambian) y [D37](D037-packs-de-datos-de-cuentas.md) (un pack propio de datos de cuentas usa el mismo punto de entrada común y el mismo modo `central_only`)
- **Precisada por:** —

## Decisión

**(1) Qué.** Un MCP pack puede ser **código propio de Mango**: un servidor MCP escrito en el repositorio, dentro de `packs/<id>/`, en lugar de un paquete upstream de PyPI. Se usa solo cuando ningún servidor upstream cubre una necesidad de lectura, o el que existe no se puede acotar a la lista cerrada de un manifiesto. Los primeros son `aws-ops` (EC2, Auto Scaling, ELB, ECS, CloudFormation y Config) y `aws-rds` (plano de control de RDS y Aurora, Performance Insights y logs de la base), de [D127](D127-agentes-sre-y-de-bases-de-datos.md).

- Ningún servidor de `awslabs/mcp` da el plano de control de RDS ni el estado de EC2, Auto Scaling y ELB.
- `ecs-mcp-server` mezcla lectura y escritura en una misma tool según un argumento, con la escritura apagada solo por una variable de entorno, y monta un proxy a un host externo.
- **Descartados:**
  - `aws-api-mcp-server` (`call_aws`): una sola tool genérica cuyo argumento es una línea de CLI libre. Además descarga de internet su lista de operaciones de solo lectura. No cabe en «acciones exactas» del manifiesto ni en R6.
  - Envolver `ecs-mcp-server` con una lista de operaciones permitidas en el punto de entrada: frágil, y deja el proxy externo montado.

**(2) Formato.** Lo fija el agente de plataforma de packs (`packs/README.md`, «Packs de código propio», y `PackManifest` en `packages/py/mango-packs`). En resumen:

- `source` tiene una variante de código propio, sin wheel upstream. El código vive en `packs/<id>/` y viaja dentro del zip.
- Las dependencias (`mcp`, `boto3` y lo que haga falta) se fijan igual que las de un upstream: `requirements.in`, un `requirements.lock` con hashes y las mismas reglas de cuarentena (corte `exclude_newer`, 7 días).
- La versión es `<semver>-<revisión de Mango>`.
- El servidor usa el **SDK oficial de MCP** y `mango_pack_runtime`: el punto de entrada común, la cadena `member` (D55 (1)), la guardia de `account_id` y de región y los argumentos ocultos. Es el mismo que usan los packs upstream.
- `check`, `check-lock`, la construcción, el snapshot sin red y la declaración firmada aceptan la variante; ninguno se salta para ella.

**(3) Lo que no cambia.**

- El manifiesto firmado sigue siendo la fuente de las acciones IAM exactas, de las tools con su clase ([D84](D084-gobernanza-de-tools.md)), del nivel de datos, de la identidad y del `egress` ([D54](D054-egress-de-packs.md)).
- Siguen igual la firma y su llave ([D36](D036-artefacto-y-firma-de-packs.md), [D58](D058-distribucion-para-clientes.md)), el provisioner, el target del Gateway, Cedar L2 y la doble aprobación al habilitar un pack.
- Un pack propio de datos de cuentas es `central_only` como los demás ([D49](D049-identidad-en-packs-de-datos.md) (4)).

**(4) Reglas del código propio.**

- Solo lectura en v1: ninguna tool `write` ni `destructive`.
- Una lista cerrada de operaciones de boto3 por tool, cada una con su acción en el manifiesto.
- El servidor quita de la respuesta lo que no se debe leer. `aws-rds` no devuelve `MasterUserSecret`. `aws-ops` no llama a `ecs:DescribeTaskDefinition`, porque trae variables de entorno.
- Topes propios de filas, bytes y ventana de tiempo.
- No lanza procesos, no escribe archivos y no sale a la red fuera de su `egress`.
- No registra contenido en logs ([D16](D016-observabilidad-de-agentes.md)).
- Lo vigilan ruff, `mypy --strict` y pytest en el CI, como al resto del código Python del repositorio.

**(5) Riesgos.**

- El código lo mantiene Mango: nadie más lo revisa ni lo corrige upstream. Un cambio de una API de AWS o de `mcp` se ve en el CI o en una instalación, no en un aviso de terceros.
- Lo que reduce: no hay un paquete de terceros que fijar, revisar en cuarentena ni vigilar por cambios silenciosos de tools.
- Lo que no reduce: sus dependencias (`mcp`, `boto3`, `pydantic`…) siguen la cadena de suministro de los demás packs (SBOM, pip-audit, lock con hashes).

**(6) Falta ver en una instalación.** Nada de esto se instaló. Falta ver que un pack propio:

- se construye y se firma en el workflow `packs` desde `main`;
- se habilita con el provisioner, que crea el rol, el Runtime en la red de packs y el target;
- responde `tools/list` igual que su snapshot;
- y lee una cuenta miembro con la cadena `member`, con `SourceIdentity` de la persona en el CloudTrail de esa cuenta.
