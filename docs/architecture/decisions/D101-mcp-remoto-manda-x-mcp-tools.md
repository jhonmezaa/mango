# D101 · Un MCP remoto recibe la lista exacta de tools aprobadas (`X-MCP-Tools`), no sus toolsets

- **Estado:** vigente
- **Fecha:** 2026-10-29 (elegida por el dueño ese día, por menú: «Pasar a X-MCP-Tools»; cómo convergen los registros existentes, el mismo día, por menú: «Automática tras instalar (Recomendada)» y «Rechazarlos (Recomendada)») · (7) precisado el 2026-10-29, al añadir el toolset «Repositorios» (D98 (6)), elegido ese día por menú: «Fijar re-firma»
- **Precisa / reemplaza a:** precisa [D98](D098-contratos-de-los-mcp-remotos.md) (6) (valores de `X-MCP-Toolsets`), (13) (las dos cabeceras forzadas del ítem firmado) y (16) (qué cabeceras devuelve el interceptor `REQUEST`); precisa [D93](D093-mcp-remotos-de-terceros.md) (8) (qué cabeceras inyecta el interceptor); respeta [D98](D098-contratos-de-los-mcp-remotos.md) (8) (cambiar toolsets o grupos sigue siendo una solicitud con doble aprobación)
- **Precisada por:** —

## Decisión

**(1) Por qué no vale como estaba.** En la instalación del cliente, la tool aprobada `search_code` del MCP remoto de Azure DevOps fallaba con `Unknown tool: 'search_code'.`
- El perfil mandaba `X-MCP-Toolsets: repos` para la búsqueda de código. Era un valor deducido de la documentación de Microsoft, que pone `search_code` en la tabla de *Repos* (D98 (6)).
- Un `tools/list` en vivo del 2026-10-29 (`X-MCP-Readonly: true`) mostró que `search_code` no está en ningún valor con nombre de `X-MCP-Toolsets`: `repos` trae 8 tools sin ella, y `wit,wiki,pipelines,repos`, 20 sin ella. Solo la exponen `all` (o no mandar la cabecera) y `X-MCP-Tools: search_code`.
- La documentación de Microsoft se equivoca, y no hay un valor de toolset que la pida sin pedir también todo lo demás.

**(2) Cómo queda.**
- **El interceptor `REQUEST` devuelve exactamente `X-MCP-Readonly: true` y `X-MCP-Tools: <las tools aprobadas del ítem firmado>`**: los nombres, ordenados y separados por `, ` como en la documentación del servidor. Nunca `X-MCP-Toolsets` y nunca `Authorization`, que pisaría el token del vault (TM-008).
- **El valor sale solo del ítem firmado.** El ítem lleva las tools aprobadas; la cabecera es esas tools, y un ítem cuya cabecera no sea exactamente esa lista no verifica. Lo que mande el cliente no sale del interceptor.
- **El target del Gateway solo deja pasar `X-MCP-Readonly` y `X-MCP-Tools`** (`metadataConfiguration.allowedRequestHeaders`). Al comparar el target con lo aprobado, se exigen esas dos y solo se aceptan encima las de AgentCore (`x-amzn-bedrock-agentcore-*`).
- **Los toolsets siguen siendo lo que elige un administrador** y cómo agrupa sus tools el perfil. Ya no tienen valor de cabecera: al servidor solo se le dicen las tools. Un registro tiene que elegir al menos un toolset que no sea `always`.
- **El perfil firmado declara `forced_headers: {X-MCP-Readonly: "true", X-MCP-Tools: "{tools}"}`.** El check del perfil rechaza cualquier otra cosa, y también un perfil cuyas tools no caben en la cabecera (4096 caracteres). La documentación no fija un límite; el de 4096 deja margen bajo los 8 KB que un servidor suele aceptar para todas las cabeceras. El perfil de Azure DevOps sube a `2026.10.27-2`, con el mismo esquema de tools.
- **El ítem firmado pasa a la versión 2 del payload.** Lleva `X-MCP-Tools` en `headers` y sigue llevando `toolsets`. Uno de la versión 1 (con `X-MCP-Toolsets`) no verifica.

**(3) Lo que está probado y lo que no.**
- **En vivo** (2026-10-29): `X-MCP-Tools: search_code` devuelve solo `search_code`.
- **Sin probar:** varias tools separadas por `, ` (la forma de la documentación), y si con `X-MCP-Tools` las tools de *core* llegan sin nombrarlas. Mango las nombra siempre (`core_list_projects` es la del sondeo), así que no depende de eso. Se ve en la instalación al usar «Mis conexiones» y una tool de cada toolset.

**(4) Cómo convergen los registros que ya existen (elegido el 2026-10-29: «Automática tras instalar (Recomendada)»).** El registro de la instalación tiene su target con `X-MCP-Toolsets` permitido y un ítem firmado de la versión 1. La release trae una declaración firmada nueva del perfil, así que su digest cambia.
- **Qué lo arranca.** Al instalar una release cuyo catálogo de perfiles cambió, un custom resource de la plantilla arranca una ejecución del provisioner de remotos con `{release: <digest del catálogo>}`. El digest es el sha256 del JSON canónico de `REMOTE_CATALOG`. Vuelve a correr solo cuando el catálogo cambia, y no existe mientras `RemoteMcpEnabled` está apagado (D98 (4)): al encenderlo, se crea y corre.
- **Qué hace.** Lista los registros `active` y sin ejecución en curso cuyo catálogo firmado nombra otro perfil que el de la release. De uno en uno, toma el bloqueo del registro sin cambiar su estado y vuelve a planear el target con la misma organización y los mismos toolsets del catálogo firmado.
- **Solo si únicamente cambian las cabeceras:**
  - las tools, los toolsets, la tool de sondeo y la organización salen iguales a las del catálogo firmado;
  - el target guarda el mismo endpoint, los mismos scopes, el mismo esquema y el mismo proveedor;
  - el target sí difiere en las cabeceras permitidas.
  
  Entonces actualiza las cabeceras del target, espera a que esté `READY` y firma el catálogo otra vez: la misma `generation`, `revision` + 1 y el perfil de la release. No toca el proveedor ni las políticas, y las personas conservan su conexión.
- **Si algo más cambia** (por ejemplo, una release que añade tools a un toolset), el registro se queda con el catálogo que tiene y hace falta una solicitud con doble aprobación (D98 (8)). El fallo se audita y no marca el registro como fallido.
- **Auditoría:** `mcp_remote.enabled` con `kind: release`, `outcome` `applied` o `rejected` (con el código, p. ej. `release_needs_request`), y quién pidió y aprobó la última vez.
- **Sin aprobación nueva:** lo aprobado (organización, toolsets, grupos, tools y proveedor) no cambia; cambia el perfil que firma el proveedor en la release, verificado como siempre (D98 (14)).
- **IAM:** el provisioner de remotos lee además el índice de registros (`REMOTE_INDEX`) y el custom resource solo tiene `states:StartExecution` sobre esa máquina de estados. Lo que el provisioner escribe en un registro no cambia: el bloqueo, `updated_at` y `version`.

**(5) Entre la instalación y la convergencia (elegido el 2026-10-29: «Rechazarlos (Recomendada)»).** El interceptor nuevo rechaza un ítem de la versión 1 como cualquier ítem que no verifica (`remote_not_approved`), hasta que el provisioner lo firma otra vez. Falla cerrado: nunca sale `X-MCP-Toolsets` ni un ítem de otra forma. La plantilla actualiza el interceptor antes que el stack anidado `RemoteMcp`, así que el hueco dura lo que tarda el barrido (un minuto, más o menos, por registro).

**(6) Lo que se descartó.**
- **Mandar `all` o no mandar cabecera:** el servidor serviría todas sus tools de lectura. El esquema fijado, Cedar y el interceptor seguirían limitando a las aprobadas, pero se pierde el filtro del servidor.
- **Una solicitud de cambio con doble aprobación para converger:** es una acción manual en la cuenta del cliente para algo que no cambia lo aprobado.
- **Aceptar el ítem viejo y mandar `X-MCP-Tools`:** el target viejo no la deja pasar, así que el servidor serviría todo hasta converger.

**(7) Un toolset nuevo que el registro no eligió no cambia lo aprobado (precisado el 2026-10-29, al añadir «Repositorios», D98 (6)).**
- El target se planea solo con las tools de los toolsets aprobados (su esquema es el del perfil recortado a ellas). Si la release solo añade un toolset que el registro no eligió, salen las mismas tools, toolsets, sondeo, organización, esquema y cabeceras: el target no difiere en nada.
- El barrido lo trata como en (4): no escribe en el Gateway, firma otra vez el catálogo con el perfil de la release (`revision` + 1, `outcome: applied`) y las personas conservan su conexión. Sin esa firma, el ítem seguiría nombrando el perfil anterior y `retry` o una solicitud nueva responderían `release_changed`.
- `release_needs_request` sigue saliendo cuando la release cambia las tools o el esquema de un toolset aprobado. Añadir el toolset nuevo a un registro es una solicitud con doble aprobación (D98 (8)).
