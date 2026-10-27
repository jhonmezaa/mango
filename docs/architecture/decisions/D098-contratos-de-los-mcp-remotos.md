# D98 · Cómo se construyen los MCP remotos: vuelta por la SPA, consentimiento pendiente en `Settings`, apagado por defecto y contratos de construcción

- **Estado:** vigente
- **Fecha:** 2026-10-27 (las respuestas de (1) a (10), elegidas por el dueño ese día, por menú, sobre el plan de construcción; los contratos de (11) a (20), propuestos por un agente y aceptados cuando el dueño apruebe integrar el cambio que registra esta decisión)
- **Precisa / reemplaza a:** precisa [D94](D094-consentimiento-iniciado-por-el-gateway.md) (2) (a dónde vuelve el navegador y cómo se cierra el consentimiento; dónde vive el pendiente); precisa [D93](D093-mcp-remotos-de-terceros.md) (7) (cambiar toolsets o grupos; dónde se aplica `UseRemoteMcp`), (8) (formato del ítem firmado y de las cabeceras), (10) (el parámetro de stack y la auditoría) y (12) (el aviso del Builder); precisa [D97](D097-desconectar-borra-el-token.md) (3) (la marca de desconexión es el claim `cx` de la firma); respeta [D46](D046-api-del-catalogo-de-mcp.md) (4) a (7), [D63](D063-sesion-web-con-cookie.md) y [D84](D084-gobernanza-de-tools.md) (5)
- **Precisada por:** —

## Decisión

Origen: el plan de construcción de los MCP remotos (D93, D94 y D97), escrito por un agente el 2026-10-27 a partir de las decisiones, el modelo de amenazas, el diseño y el código. El plan está fuera del repositorio. Diez preguntas del plan las respondió el dueño ese mismo día, por menú; lo demás son los contratos que siguen los PR de construcción. Modelo de amenazas: [`remote-mcp-threat-model.md`](../../security/threat-models/remote-mcp-threat-model.md) (v0.3, TM-014 a TM-017).

### Lo que eligió el dueño (2026-10-27, por menú)

**(1) La vuelta pasa por la SPA (respondido: «Por la SPA (Recomendada)»).**
- **Por qué no vale como estaba.** D94 (2) mandaba la vuelta de Identity a `/api/oauth/callback` y exigía la sesión web de la persona. Pero la cookie de D63 es `SameSite=Strict`, así que no viaja en una navegación que llega redirigida desde AgentCore Identity. Además, D63 no deja que esa cookie autentique un endpoint de negocio.
- **Cómo queda.** El `defaultReturnUrl` del target, y la URL que se añade a `allowedResourceOauth2ReturnUrls` de la identidad de carga del Gateway, es la ruta `/conexiones/vuelta` de la SPA. Es la vista `connect-return` del diseño.
- **Qué hace la SPA en la vuelta:**
  - toma `session_id` de la URL y lo guarda solo en memoria;
  - borra la query de la barra con `history.replaceState`;
  - si hace falta, renueva su sesión como siempre;
  - llama a `POST /api/oauth/callback {session_id}` con el access token de la persona.
- **Qué hace `mango-api`:** exige un consentimiento pendiente de esa persona y llama a `CompleteResourceTokenAuth` con ese access token. Los controles de D94 (2) no cambian; cambian la ruta y el método.

**(2) Quién recibe las tools remotas (respondido: «No, y el Builder avisa (Recomendada)»).** `mango-api` no firma las tools remotas en la invocación de quien no tiene `UseRemoteMcp`, es decir, de quien no está en los grupos del registro: es «menos de lo aprobado», como D46 (1). Para esa persona, el agente responde sin ellas. El Agent Builder y la revisión avisan, sin bloquear, cuando el agente se comparte con grupos o personas fuera de los grupos del registro. El aviso es `remote_audience_outside_groups`, como `groups_without_access` en D88 (35).

**(3) El consentimiento pendiente vive en `Settings` (respondido: «En Settings, partición propia (Recomendada)»).**
- **Dónde:** la partición `MCP_CONSENT#<sub>`, con una fila por registro y 10 minutos de vida (TTL).
- **Quién escribe:** solo el interceptor `RESPONSE` (`dynamodb:LeadingKeys`). Es un escritor más de `Settings`, como la función de salud de D84 (8).
- **Quién lee:** `mango-api`, que además lo borra.

**(4) Apagado hasta P9 (respondido: «Parámetro de stack, apagado (Recomendada)»).** El parámetro de stack `RemoteMcpEnabled` vale `false` por defecto (regla 8). Mientras vale `false`:
- `mango-api` responde 409 `remote_disabled` a toda escritura de registro y a «Conectar»;
- el catálogo muestra los perfiles de la release como no disponibles en la instalación;
- el provisioner de remotos no arranca.

Se pone en `true` en un cliente solo después de probar P9 (D97 (5)).

Volver a ponerlo en `false` no corta las llamadas de los registros que ya están activos: el parámetro solo frena las escrituras de registro, «Conectar» y el provisioner. Esto no lo eligió el dueño: lo dedujo un agente de lo anterior. Para cortar un registro activo se deshabilita el registro, lo que borra su proveedor (D93 (7)).

**(5) El esquema de tools se captura en vivo (respondido: «Capturado en vivo (Recomendada)»).** El `mcpToolSchema` del perfil sale de un `tools/list` real contra la organización de pruebas del dueño. Usa recursos temporales del laboratorio, cada uno aprobado por el dueño, y la captura la corre el agente principal. La captura se hizo el 2026-10-27, antes de construir el perfil (servidor `AzureDevOps.Mcp` 1.0.0.0, protocolo `2025-06-18`, con `X-MCP-Readonly: true`), así que el perfil del repositorio nunca llevó un esquema de prueba: `remotes/azure-devops/tool-schema.json` son las 13 tools de (6) tal como las devolvió el servidor. El procedimiento para refrescarlo a mano queda en `remotes/README.md`. El CI no puede comparar el perfil con el servidor (TM-005): el repositorio es público y no tiene credenciales de Microsoft.

**(6) Las tools del perfil v1 (respondido: «Lo anterior + pipelines y código»).**
- **Toolsets:**
  - `core` (proyectos y equipos);
  - work items, con su búsqueda;
  - wiki, con su búsqueda;
  - pipelines;
  - búsqueda de código.
- **Fuera de todo toolset:** `pipelines_artifact` y `wit_work_item_attachment` (TM-011).
- **Clase:** todas las tools son `read`.
- **Valores de `X-MCP-Toolsets`** (2026-10-27): la captura no los da; salen de la documentación del servidor remoto de Microsoft.
  - `wit` (con `search_workitem`), `wiki` (con `search_wiki`) y `pipelines`: los nombra la documentación.
  - `core` no tiene valor: sus tools llegan siempre, con cualquier toolset.
  - Búsqueda de código: la documentación no da un valor solo para `search_code`; la pone entre las tools de *Repos*. El perfil manda `repos`, marcado como deducido y a comprobar en vivo antes de habilitarlo en un cliente (elegido el 2026-10-27, por menú: «`repos`, pendiente de comprobar en vivo (Recomendada)»). El esquema del target y el ítem firmado solo traen `search_code`, así que el Gateway no expone ninguna otra tool de *Repos*.
  - Un registro tiene que elegir al menos un toolset con valor: sin `X-MCP-Toolsets`, el servidor sirve todos sus toolsets.

**(7) El vencimiento del secreto se ve solo en pantalla (respondido: «No, solo en pantalla (Recomendada)»).** `mango-api` calcula el nivel de aviso al leer, con 30 y 7 días antes y vencido, en el catálogo y en Ajustes › Conectividad. No hay función diaria ni aviso en la Bandeja.

**(8) Cambiar toolsets o grupos es una solicitud (respondido: «Sí, con una solicitud de cambio»).** Cambiar los toolsets o los grupos de un registro activo es una solicitud con doble aprobación, como los `params` de un pack (D46 (4)). **No borra el proveedor**, así que las personas conservan su conexión:
- el provisioner cambia el `mcpToolSchema` del target y sus políticas;
- vuelve a firmar el ítem;
- un cambio solo de grupos no toca el target, pero también pide aprobación.

La API se construye. La pantalla queda en «Próximamente» hasta que Claude Design la dibuje (D24).

Mientras tanto, la web no muestra una solicitud `params` pendiente que se haya creado por la API: queda en la API hasta que el diseño la dibuje (elegido por el dueño el 2026-10-27, por menú: «No mostrarla»). «Cambiar tenant o app» muestra los toolsets y los grupos del registro sin dejar editarlos, porque esa solicitud no los cambia (elegido ese día, por menú: «Mostrarlos sin editar (Recomendada)»).

**(9) El `session_id` fuera de los logs (respondido: «Quitarlo de los logs; si no se puede, excepción (Recomendada)»).**
- **Dónde queda hoy.** Identity añade el `session_id` en la query de la URL de vuelta. La distribución de CloudFront usa hoy el registro estándar *legacy*, que siempre guarda la query (`cs-uri-query`).
- **Qué se hace.** Antes de que exista la ruta de vuelta, el registro de CloudFront pasa al registro estándar v2, con selección de campos y sin `cs-uri-query`.
- **Dónde más podría quedar.** La SPA se sirve desde S3 con una política de caché que no reenvía la query al origen, y no hay logs de WAF.
- **Si no se puede.** Si al construir resulta que v2 no se puede usar, se registra la excepción en `AGENTS.md`, con su motivo y la fecha de ese día. El dueño aprobó esa alternativa.

**(10) Estado de esta decisión (respondido: «Vigente; los contratos se revisan en el PR (Recomendada)»).** Rige desde hoy para lo que eligió el dueño, de (1) a (9). Los contratos de (11) a (20) los propuso un agente y quedan aceptados cuando el dueño apruebe integrar el PR que registra esta decisión.

### Contratos de construcción (propuestos por un agente)

**(11) Nombres.**

| Cosa | Forma |
|---|---|
| Id de perfil | `^[a-z][a-z0-9-]{1,23}$`; es la carpeta `remotes/<id>/` |
| Id de registro | 12 caracteres base32 en minúsculas, aleatorios. Estable toda la vida del registro: un cambio de tenant, app, toolsets o grupos es una solicitud sobre el mismo registro, así que no se rompen los nombres de tool de los agentes |
| Target del Gateway | `remote-<reg>` |
| Tool del Gateway | `remote-<reg>___<tool>` |
| Proveedor de Identity | `Mango-<ns>-remote-<reg>-g<n>`; `n` sube con cada cambio de tenant o app, y el anterior se borra al aprobar el nuevo |
| Políticas Cedar L2 | `Mango_<ns>_remote_<reg>_<n>` |

**(12) Ítems de `Settings`.** El escritor de cada partición queda fijado por IAM.

| PK / SK | Escribe | Lee | Contenido |
|---|---|---|---|
| `REMOTE#<reg>` / `REGISTRATION` | `mango-api`; el provisioner de remotos, solo los estados del ciclo de vida | `mango-api`, provisioner | Perfil, organización, `tenantId`, `clientId`, toolsets, grupos, estado, `version` (bloqueo optimista), `generation`, proveedor, `callbackUrl`, vencimiento del secreto, quién pidió y quién aprobó. Nunca el secreto ni su ARN |
| `REMOTE_CHANGE#<reg>` / `CHANGE#<id>` y `PENDING` | `mango-api` | `mango-api` | Una solicitud (`enable`, `replace_app` o `params`) y su decisión, 90 días. Una `params` guarda también los toolsets y los grupos de antes, para que quien aprueba vea los dos; el marcador `PENDING` garantiza una sola pendiente por registro, como D46 (7). Vence a los 7 días |
| `REMOTE_ORG#<profile>#<org>` / `CURRENT` | `mango-api` | `mango-api` | Un solo registro por perfil y organización |
| `MCP_REMOTE#<reg>` / `APPROVED` | solo el provisioner de remotos | interceptor `REQUEST`, `mango-api`, provisioner de agentes | El catálogo aprobado y firmado (13) |
| `MCP_CONSENT#<sub>` / `REMOTE#<reg>` | solo el interceptor `RESPONSE`, con el `sub` de la firma de la invocación verificada; a `mango-api` IAM le niega `PutItem` y `UpdateItem` en la partición | `mango-api`, que lo borra | La URL de consentimiento, su origen (`chat`, `task`, `playground` o `connect`) y su vencimiento (10 minutos, TTL) |

Precisado al construir el registro (2026-10-27):
- **Índice de registros:** `REMOTE_INDEX` / `REGISTRATIONS`, un conjunto con los ids de todos los registros, para listarlos sin recorrer la tabla. Lo escribe y lo lee solo `mango-api`, en la misma transacción que crea o borra un registro; admite como mucho 50 (los vivos siguen limitados a 10).
- **Generaciones del proveedor:** `REGISTRATION` guarda la mayor generación creada (`provider_generations`), y cada solicitud que crea un proveedor usa la siguiente: un nombre no se repite nunca, porque el secreto de un proveedor borrado puede seguir en borrado programado en Secrets Manager.
- **La entrada del provisioner de remotos** es exactamente `{registration_id, approval_id}`, como `enablement_id` en los packs (elegido el 2026-10-27, por menú: «Mirror packs (approval_id)»). Cada aprobación o deshabilitación escribe un `approval_id` aleatorio en `REGISTRATION`, junto con `change_id` y `change_kind` de la solicitud aprobada; el provisioner rechaza una ejecución cuyo `approval_id` ya no es el del registro. Un reintento usa el mismo.
- **Tags del proveedor:** `mango-api` copia los tags del stack `Core` al proveedor que crea, con las reglas de los provisioners, más `mango:namespace`, `mango:component` y `mango:remote` (D76; elegido el 2026-10-27, por menú: «Copy stack tags too»).

Precisado al construir «Mis conexiones» (2026-10-27):
- **«Conectar» con la cuenta ya en el vault** responde `already_connected` (la tool de sondeo contestó; no se abre Microsoft, diseño A6) y escribe la conexión. Una conexión nueva solo nace en la vuelta.
- **«Desconectar» no borra la conexión: la sobrescribe** con `disconnected_at`. La política de sesión de las credenciales RLS no da `DeleteItem`, y no se amplía para esto.
- **La vuelta sin `session_sha256`** (hasta V-3) cierra el pendiente más reciente de la persona: Identity ya exige que la sesión sea suya.
- **Con `RemoteMcpEnabled` apagado** se pueden listar las conexiones y desconectar; «Conectar» y la vuelta responden `remote_disabled`.
- **(9), hecho:** el registro de CloudFront es el estándar v2 (entrega de logs vendidos de CloudWatch al bucket de logs de acceso, prefijo `cloudfront/`) con los campos del registro *legacy* menos `cs-uri-query` y `cs(Cookie)`; el *legacy* se quitó. No hace falta la excepción.

La conexión de cada persona (desde cuándo, y con qué `generation` del proveedor) va en `Conversations`, en `USER#<sub>` / `REMOTE#<reg>`. La escribe `mango-api` con las credenciales RLS de esa persona. Sirve para mostrar «Conectado» sin llamar a Microsoft. Una conexión de otra `generation` cuenta como «Sin conectar».

**(13) El ítem firmado.**
- **Payload:** JSON canónico con:
  - el registro, `generation` y `revision`;
  - el perfil (id, versión y hash de su declaración firmada);
  - el Gateway y el target;
  - la organización y los toolsets;
  - las dos cabeceras forzadas;
  - las tools `read` aprobadas;
  - la tool de sondeo;
  - la fecha de emisión.
- **Firma:** ECDSA P-256 con `alias/Mango-<ns>-remote-mcp` (D93 (9)), sobre `SHA-256("mango.remote-mcp.v1\n" + payload)`, el mismo esquema que la aserción de los packs.
- **Verificación en el interceptor:** comprueba la firma con la llave pública, que lee una vez por contenedor, y exige que target, Gateway y registro coincidan con la llamada. Guarda el ítem en caché 30 segundos. Si falta, no verifica o no se puede leer, rechaza.
- **Orden:** el provisioner lo escribe en último lugar al habilitar y lo borra en primer lugar al deshabilitar.

**(14) El perfil firmado en la release.**
- **Archivos:** `remotes/<id>/profile.yaml`, con un esquema estricto, y `tool-schema.json`, que es el `mcpToolSchema` del target.
- **Qué trae `profile.yaml`:**
  - el host fijo y la forma de la URL;
  - los hosts de los enlaces del servicio;
  - el proveedor (`MicrosoftOauth2`) con sus scopes;
  - los toolsets con su valor de cabecera;
  - cada tool con su toolset y su clase;
  - el hash del esquema;
  - la tool de sondeo y sus argumentos;
  - el recorte de resultados;
  - la marca «los datos salen de AWS».
- **El check del pipeline falla si:**
  - una tool no es `read`;
  - no cuadran los nombres o el hash;
  - el host lleva comodín;
  - el esquema trae una anotación MCP que lo contradice (D84 (4)).
- **Firma:** sobre DSSE (`application/vnd.mango.remote-profile.v1+json`), con el esquema dentro, firmado con la llave y el entorno de los packs (D93 (1)).
- **Carga en la instalación:** la síntesis verifica cada sobre y lo sube al bucket de packs. El catálogo de la release, `REMOTE_CATALOG`, nombra un sobre por perfil por su digest.

**(15) La firma de la invocación: el claim `cx`.**
- **Qué es:** la marca de D97 (3). `cx` vale `connect` o `disconnect` y va solo en las llamadas que hace `mango-api` desde «Mis conexiones».
- **Cómo se firma:** con un id de agente reservado (`mangoconn`), que ningún agente puede tener, y una sola tool, que debe ser la de sondeo del ítem firmado. Sin `cx`, la firma queda igual que hoy.
- **Qué hace el interceptor `REQUEST`:**
  - con `cx = disconnect`, deja pasar solo el `_meta` documentado con `forceAuthentication: true`, y nunca `returnUrl`;
  - en todo lo demás, borra `_meta` en los targets remotos.
- **Qué hace el interceptor `RESPONSE`:** con `cx = disconnect` no escribe el consentimiento pendiente.
- **Protocolo MCP:** esas llamadas usan `2025-11-25`, la versión que se probó.

**(16) Interceptores.**
- **`REQUEST`:**
  - devuelve en `headers` exactamente `X-MCP-Readonly` y `X-MCP-Toolsets` del ítem firmado, y nunca una clave `Authorization`, que pisaría el token del vault;
  - no pone `_mango_ctx` a un target remoto.
- **`RESPONSE`:**
  - verifica la firma de la invocación;
  - cambia el `-32042` (o el `-32021`) por un error `consent_required` sin URL. Es la forma probada en P3: código `-32001` y `data` con el target;
  - acepta la URL solo si es `https` y su host es `bedrock-agentcore.<región>.amazonaws.com`, y la guarda bajo el `sub` de la firma verificada, nunca uno tomado del cuerpo; si la firma no verifica, no escribe nada;
  - recorta los textos largos y cambia el binario por un aviso;
  - quita las URL de los errores de un remoto;
  - registra solo la forma de cada respuesta.

**(17) Rutas de `mango-api`.** Todas declaran su autorización, y el router de remotos va antes que el de packs.
- **Catálogo y registro:**
  - `GET /api/mcp/remotes`;
  - `POST /api/mcp/remotes/{profile}/registrations`: crea el proveedor de Identity con el secreto y devuelve el `callbackUrl`;
  - `POST /api/mcp/remotes/registrations/{reg}/requests`: cambio de tenant o app, o volver a pedir;
  - `POST …/params`: (8);
  - `POST …/requests/{change}/approve`, `reject` (con motivo) y `withdraw`;
  - `POST …/secret`: rotar, sin aprobación;
  - `POST …/retry`;
  - `DELETE …/{reg}`: deshabilitar, con motivo.
- **Conexiones de cada persona:**
  - `GET /api/me/connections`;
  - `POST /api/me/connections/{reg}/connect`: devuelve el pendiente vigente o hace el sondeo;
  - `POST /api/me/connections/{reg}/disconnect`: D97 (3);
  - `POST /api/oauth/callback`: (1).

  `mango-api` vuelve a validar la URL antes de entregarla (D94 (2)).
- **Cuerpos:** prohíben campos extra. El secreto es de solo escritura y nunca vuelve en una respuesta, un log ni la auditoría.
- **Límites:**
  - 10 escrituras por minuto por administrador y 10 registros vivos;
  - 20 «Conectar» y 20 vueltas por minuto por persona;
  - 10 «Desconectar» por minuto.

**(18) Cedar L1.**
- **Entidad nueva:** `Mango::RemoteMcp`, con sus grupos.
- **`ManageRemoteMcp` y `ApproveRemoteMcp`:** solo administradores. Que quien pide no apruebe lo comprueba `mango-api`, como en los packs.
- **`UseRemoteMcp`:** estar en uno de los grupos del registro. Ser administrador no basta, como con las knowledge bases.
- **Dónde se exige `UseRemoteMcp`:** al dar una tool remota a un agente, al firmar cada invocación (2), al conectar, al desconectar y en la vuelta.
- **Cedar L2 de cada target remoto:** permite las tools del ítem firmado a todo usuario con sesión, como un pack público (D33). Los grupos se aplican en L1 y en la firma.

**(19) Auditoría.** Nunca lleva secretos, tokens, `session_id`, la URL ni contenido.
- **Eventos de D93 (10):** `mcp_remote.request`, `.approve`, `.reject`, `.consent_started`, `.consent_completed`, `.consent_failed`, `.disconnect` (solo si el Gateway confirma, D97 (3)), `.secret_rotated` y `.disable`.
- **Eventos nuevos:** `mcp_remote.withdraw`, `.retry`, `.enabled`, `.create_failed` y `.disabled`.

**(20) Errores que muestra la web.**
- **Del alta y del registro:** `remote_exists`, `same_approver`, `remote_profile_not_in_release`, `remote_disabled`, `pending_exists`, `version_conflict`, `expired` y `release_changed`.
- **De quien usa el servicio:** `remote_not_usable`, `secret_expired`, `consent_expired`, `consent_not_yours`, `consent_denied`, `conditional_access` y `disconnect_not_confirmed`.
- **De disponibilidad:** `identity_unavailable`, `gateway_unavailable`, `provisioner_unavailable` y `rate_limited`.
- **Aviso del Builder:** `remote_audience_outside_groups`.
- **En el chat y en las tareas:** el evento `remote_connection_required` (sin URL) y el aviso de la Bandeja `remote_connect`.

Los textos los pone el diseño (D24). Los que falten van al brief siguiente.

**Cómo los muestra la web de administración** (elegido por el dueño el 2026-10-27, por menú, al construir la web):
- **La ficha muestra solo lo que trae el perfil firmado** (nombre, operador, host, toolsets con sus tools y permisos): la descripción del servicio, los requisitos y la descripción de cada permiso del diseño no están en el perfil y no se muestran («Ocultar lo que falta (Recomendada)»).
- **Las solicitudes de alta en la Bandeja de los administradores las compone la web** desde `GET /api/mcp/remotes`: no tienen estado de leído ni de archivado en el servidor y salen de la Bandeja cuando alguien las decide («Componer en la web (Recomendada)»).
- Los códigos sin texto en el diseño (`identity_unavailable`, `remote_disabled` de la instalación, `too_many_remotes`) se muestran con el error genérico.

**Cómo los muestra la web de las personas** (precisado al construirla, 2026-10-27; ninguna decisión cambia):
- **La vuelta** (`/conexiones/vuelta`, P-1): la SPA lee el `session_id` al arrancar, antes de pintar nada, lo guarda solo en memoria y lo quita de la URL con `history.replaceState`; nunca va a Web Storage (P-9). Sin sesión de Mango muestra «Inicia sesión en Mango para terminar»: el inicio de sesión propio no recarga la página y la vuelta se cierra al terminar. Tras un inicio federado, que recarga, o al recargar la vuelta, la página dice «El enlace venció» y la persona vuelve a pulsar «Conectar». Si la vuelta no trae `session_id`, un `error=access_denied` es «no autorizó» y cualquier otra cosa, el error genérico, sin leer el texto del proveedor (V-5 sigue abierto).
- **«Conectar»** abre la URL que da `mango-api` en la misma pestaña, después de comprobar otra vez que es `https` y del host de AgentCore de la región de la instalación.
- **La tarjeta del chat y del Playground** sale del evento o del mensaje guardado y de «Mis conexiones», nunca del texto del modelo, y fuera del Markdown. Cuenta los 10 minutos del pendiente desde que llegó el evento (o desde la hora del mensaje guardado). Si el registro no está en «Mis conexiones» de la persona, no se muestra.
- **«Leyó {servicio}» y la clasificación de enlaces (A1)** salen de `remote_sources` del mensaje guardado, con las organizaciones y los hosts de los registros que la persona puede usar (no los de toda la instalación). El turno en vivo no los trae: se ven al recargar la conversación, y mientras tanto sus enlaces pasan por el diálogo normal.
- **El Builder** solo lista los registros que la API devuelve a quien edita: la fila del diseño «no está habilitado para tus grupos» no sale, porque la API no dice los grupos de un registro a quien no está en ellos. El aviso de grupos sin el servicio es el `remote_audience_outside_groups` de la versión guardada, más las personas sueltas del borrador.
- **El aviso `remote_connect` de la Bandeja** se muestra como la tarjeta del diseño («Conecta tu cuenta de {servicio}», «Ir a Mis conexiones») cuando el registro está en «Mis conexiones»; si no, como la ejecución fallida que también es.
- «Desconectar» sigue en «Próximamente» (D97).

### Lo que queda por ver en vivo antes de habilitarlo en un cliente

Junto con P9, con recursos temporales aprobados por el dueño:
- el IAM mínimo de crear, cambiar y borrar el proveedor, de `CompleteResourceTokenAuth` y de crear un target con OAuth, porque el laboratorio usó credenciales de administrador;
- si `UpdateGatewayTarget` acepta otro proveedor;
- si la URL de consentimiento trae la sesión, para distinguir «no es tuyo» de «venció»;
- la versión del protocolo que negocia el harness: con `2026-07-28`, un `tools/call` sin `_meta` falla;
- qué devuelve Identity a la vuelta si la persona cancela;
- si el Gateway entrega la respuesta en streaming al interceptor `RESPONSE`.
