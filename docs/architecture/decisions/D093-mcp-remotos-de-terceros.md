# D93 · MCP remotos de terceros: perfiles curados y firmados en la release, token de cada persona por 3LO y solo lectura (piloto Azure DevOps)

- **Estado:** propuesta
- **Fecha:** 2026-10-25 (los puntos 1 a 6, respondidos ese día por menú con la opción «(Recomendada)», por el agente principal en nombre del dueño, que pidió seguir con las recomendadas; el cómo, puntos 7 a 12, propuesto por un agente) · 2026-10-26 (el registro y el plan de la prueba en vivo, elegidos por el dueño ese día, por menú: «Registrar y planear prueba en vivo»; la llave que firma el catálogo aprobado, punto 9, elegida por el dueño ese día, por menú: «KMS propia, firma el provisioner (Recomendada)»)
- **Precisa / reemplaza a:** precisa [D19](D019-catalogo-de-mcp.md) (3) (los MCP remotos pasan a ser SaaS de terceros con perfil curado y firmado, no una URL del cliente); precisa [D84](D084-gobernanza-de-tools.md) (5) (el interceptor lee las tools `read` de un remoto de un catálogo aprobado y firmado, no de `PACK_TOOLS`); precisa [D54](D054-egress-de-packs.md) y R6 de [D11](D011-requisitos-de-seguridad.md) (para un target SaaS el control es el host fijo del perfil, no una red); precisa [D13](D013-identidad-hasta-las-tools.md) (un interceptor `RESPONSE` y el borrado de `_meta`); reutiliza [D46](D046-api-del-catalogo-de-mcp.md) (4) a (6); respeta [D25](D025-recursos-creados-en-runtime.md) y [D56](D056-tools-de-escritura-con-aprobacion.md) (5)
- **Precisada por:** —

## Decisión

Origen: D19 (3) dejaba para v1.x los «MCP remotos del cliente (hospedados por él, con OAuth vía AgentCore Identity)». El caso que se pidió es un SaaS de terceros, el servidor MCP remoto de Azure DevOps, GA desde el 2026-08-05 (https://devblogs.microsoft.com/devops/azure-devops-remote-mcp-server-ga/). AgentCore Gateway acepta un servidor MCP remoto como target (`mcp.mcpServer`) con OAuth `AUTHORIZATION_CODE` por persona; el token de cada persona queda en el vault de AgentCore Identity (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html, https://aws.amazon.com/blogs/machine-learning/connecting-mcp-servers-to-amazon-bedrock-agentcore-gateway-using-authorization-code-flow). Identity tiene un proveedor de Microsoft (`MicrosoftOAuth2`, con `tenantId`; https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-idp-microsoft.html). La guía de Microsoft admite desde el 2026-09-21 clientes de terceros con una app de Entra propia, con permisos delegados sobre la app «Azure DevOps MCP», y las cabeceras `X-MCP-Readonly` y `X-MCP-Toolsets` (https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server?view=azure-devops). Investigación y propuesta: informe de la tarea fuera del repositorio. **No se construye nada hasta la prueba en vivo del punto 11.** Modelo de amenazas: [`remote-mcp-threat-model.md`](../../security/threat-models/remote-mcp-threat-model.md).

**(1) Qué se puede registrar (respondido por menú: «Perfiles curados (Recomendada)»).** Solo **perfiles de MCP remoto curados en el CI de Mango y firmados** con la llave de los packs (D36), que viajan en la release. Cada perfil trae el host fijo (`mcp.dev.azure.com`) y la forma de la URL (`/{organización}`), el proveedor y sus scopes de lectura, los toolsets admitidos, el esquema de cada tool con su hash, la clase D84 de cada tool, las cabeceras que se fuerzan y la marca «los datos salen de AWS». Un administrador no puede registrar una URL libre: traería tool poisoning, rug pull y SSRF sin revisión. Va con el espíritu de D19 (2) («nunca paquetes arbitrarios»).

**(2) Solo lectura en v1 (respondido por menú: «Solo lectura (Recomendada)»).** En cuatro capas: la cabecera `X-MCP-Readonly: true` en cada llamada; el esquema del target solo con las tools `read`; el interceptor `REQUEST`, que solo deja pasar esas; y la app de Entra con permisos delegados de lectura. Las tools `destructive` (como mínimo `enterprise_live_migration_write` y `enterprise_live_migration_pipelines_write`) quedan fuera de todo perfil, como en D84. Así no se toca D56 (5). Abrir escrituras la contradiría y es una decisión aparte. La clase de `pipelines_write` (`write` o `destructive`) queda abierta: solo importa si llegan escrituras.

**(3) Esquema fijo (respondido por menú: «Esquema fijo del perfil (Recomendada)»).** El target se crea con `mcpToolSchema`, el esquema del perfil. Un target con esquema estático no se sincroniza con el servidor, así que una definición no cambia sin una release nueva y una nueva aprobación, como al actualizar un pack. Sincronizar con 3LO exigiría que un administrador autorice cada sincronización (estado `*_PENDING_AUTH`, en el que el target no se puede ni borrar). Queda el riesgo de que **la conducta** del servidor cambie detrás de un nombre ya aprobado; lo acotan solo lectura, los scopes y los permisos de la persona.

**(4) Consentimiento iniciado por `mango-api` (respondido por menú: «Lo inicia mango-api (Recomendada)»).** La URL de consentimiento nunca pasa por el modelo.
- `mango-api` pide la URL con la identidad de carga del Gateway y el token de la persona (`GetWorkloadAccessTokenForJWT` y `GetResourceOauth2Token`, flujo `USER_FEDERATION`, con `customState` y `resourceOauth2ReturnUrl`) y la muestra en el chat o en «Mis conexiones».
- Su callback (`/api/oauth/callback`) exige la sesión web de la persona (D63) y un `state` de un solo uso ligado a persona y registro, y llama a `CompleteResourceTokenAuth` (session binding: la URL y la sesión valen 10 minutos; https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/oauth2-authorization-url-session-binding.html).
- Red de seguridad: un interceptor `RESPONSE` (punto 8) cambia el error de consentimiento del Gateway (`-32042`, o `-32021` en la versión `2026-07-28`) por un `consent_required` sin URL, y deja una marca que `mango-api` lee para mostrar «Conectar».
- Depende de dos cosas sin documentar que se prueban antes de construir (punto 11, P3 y P4): qué hace el harness con el `-32042` y si un consentimiento iniciado fuera del Gateway sirve después al Gateway.

**(5) Egress: el host fijo del perfil (respondido por menú: «Host fijo del perfil (Recomendada)»).** Un target `mcpServer` con URL pública sale desde la red gestionada por AWS. El control de R6 para un target SaaS es el **host fijo** del target: lo pone el provisioner desde el perfil firmado, sin más parámetro libre que la organización (`^[A-Za-z0-9][A-Za-z0-9-]{0,48}$`), y el interceptor no deja cambiar la URL. Llevarlo por `privateEndpoint` (VPC Lattice) a una VPC con NAT y Network Firewall costaría varias centenas de USD al mes por zona (precio sin verificar) y no daría más control sobre un destino que ya es fijo. La VPC de los packs (D54) no cambia. La marca «los datos salen de AWS» se ve en el catálogo y en el agente.

**(6) La app de Entra (respondido por menú: «Sí, así (Recomendada)»).** Una app registrada **single-tenant**, en el tenant del cliente, con permisos delegados **de lectura** sobre la app «Azure DevOps MCP» y consentimiento de administrador. Su redirect URI es de tipo Web: el `callbackUrl` que devuelve `CreateOauth2CredentialProvider`, único por proveedor. Si la app «Azure DevOps MCP» falta en el tenant, un Application Administrator crea su service principal (https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server-troubleshooting?view=azure-devops). El secreto de la app es la credencial del cliente OAuth, no una identidad. Lo escribe un administrador una vez y `mango-api` lo entrega a Identity por API: nunca vuelve al navegador. Mango guarda su vencimiento (Entra lo hace vencer) y avisa antes. El destino ve a la persona con su propia identidad de Entra y sus permisos de Azure DevOps (regla 5). Es la preferencia (1) de la nota «Multinube» de §8: identidad del usuario por 3LO.

**(7) Registro con doble aprobación (propuesto por un agente).** Misma familia de solicitudes que los packs (D46 (4) a (6)):
- un administrador pide habilitar un perfil con la organización, `tenantId`, `clientId`, secreto (solo escritura), toolsets y los grupos que pueden usarlo;
- el secreto va a Identity al pedir. La respuesta devuelve el `callbackUrl`, que el administrador pega en Entra;
- **otro** administrador aprueba, y ve el `tenantId` y el `clientId`;
- al rechazar o retirar la solicitud se borra el proveedor;
- cambiar el `clientId` o el `tenantId` es una solicitud nueva; rotar solo el secreto no pide otra aprobación.

Acciones Cedar L1 nuevas: `ManageRemoteMcp` y `ApproveRemoteMcp` (solo administradores) y `UseRemoteMcp` (estar en los grupos del registro). Dar a un agente una tool remota exige `UseRemoteMcp` de quien lo crea, como las KBs (D88 (35)).

**(8) Interceptores (propuesto por un agente; precisa D13 y D84 (5)).**
- El interceptor `REQUEST`, para un target remoto:
  - solo deja pasar las tools `read` del catálogo aprobado y firmado (punto 9);
  - borra todo `_meta` que ponga el modelo: si no, el modelo podría elegir la URL de vuelta o forzar un consentimiento nuevo con `forceAuthentication`;
  - inyecta `X-MCP-Readonly` y `X-MCP-Toolsets`, que el target admite en `allowedRequestHeaders` (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-headers.html);
  - nunca copia el `Authorization` de entrada hacia el target;
  - la firma de la invocación (D13/D33) y la marca `pg` del Playground (D91) siguen igual.
- Un interceptor **`RESPONSE`** nuevo (un Gateway admite uno de cada tipo; https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors.html):
  - quita la URL de consentimiento (punto 4);
  - recorta el tamaño de los resultados (un artefacto o un adjunto en base64 puede pesar MB);
  - no escribe contenido en logs: los logs del Gateway siguen apagados.

  Es síncrono, así que le aplica la excepción ya acordada de `CKV_AWS_116`.

**(9) La firma del catálogo aprobado (elegida por el dueño el 2026-10-26, por menú: «KMS propia, firma el provisioner (Recomendada)»).** El provisioner, al crear el target tras la segunda aprobación, firma el ítem `MCP_REMOTE#<id>` de `Settings` con una llave KMS asimétrica propia, `alias/Mango-<ns>-remote-mcp` (unos USD 1 al mes). El ítem lleva las tools `read` aprobadas, los toolsets y el target. El interceptor verifica la firma con la llave pública. `mango-api` no puede firmar con ella, así que no puede inventar un catálogo. Reutilizar la llave de los approval tokens o confiar solo en IAM se descartó.

**(10) Lo que crea el provisioner, por SDK (propuesto por un agente; cumple D25).** El provisioner de packs, o uno hermano en la misma máquina de estados, crea:
- el target `mcpServer` (`remote-*`) con `AUTHORIZATION_CODE`, `mcpToolSchema` (solo las tools `read`), `defaultReturnUrl` y la allowlist de cabeceras;
- las políticas Cedar L2 del target, denegadas por defecto como las de los packs;
- el ítem firmado del punto 9;
- la URL del callback de Mango en `allowedResourceOauth2ReturnUrls` de la identidad de carga del Gateway.

Nada de CloudFormation en ejecución ni código descargado: el servidor corre en Microsoft. Los permisos nuevos de `mango-api` van en una política administrada propia, `Mango-<ns>-ApiRemoteMcp`, porque la en línea está llena. Todos los permisos van sobre ARNs concretos:
- `mango-api`: crear, cambiar y borrar los proveedores `Mango-<ns>-remote-*`; `GetWorkloadAccessTokenForJWT`, `GetResourceOauth2Token` y `CompleteResourceTokenAuth` sobre la identidad de carga del Gateway;
- el rol del Gateway: los de 3LO y el secreto que Identity crea para cada proveedor.

Auditoría sin contenido ni tokens: `mcp_remote.request`, `.approve`, `.reject`, `.consent_started`, `.consent_completed`, `.consent_failed`, `.disconnect`, `.secret_rotated` y `.disable`. Las llamadas a tools se ven en Actividad (D90) como las de cualquier tool. Las tareas (D78) y el Playground (D91) usan el mismo token del vault. Una tarea sin consentimiento falla con «Conecta Azure DevOps» en la Bandeja, nunca con una URL.

**(11) Antes de construir, una prueba en vivo (elegida por el dueño el 2026-10-26).** Con recursos temporales separados del Gateway de la instalación, y cada uno creado solo con la aprobación explícita del dueño. Qué se prueba:
- **P1:** qué audiencia y qué scopes de lectura acepta `mcp.dev.azure.com`, y si acepta el token que emite Identity.
- **P2:** el target con `mcpToolSchema` y dónde guarda Identity el secreto (para acotar el IAM).
- **P3:** qué hace el harness con el `-32042`.
- **P4:** si un consentimiento iniciado por `mango-api` sirve al Gateway, y qué claim del JWT identifica a la persona.
- **P5:** las versiones del Gateway y la elicitación por URL (D47).
- **P6:** que las cabeceras forzadas y el borrado de `_meta` se cumplen.
- **P7:** cómo se refresca el token y cómo se borra el de **una** persona.
- **P8:** que una persona no usa el token de otra (session binding).
- **P9:** el Acceso condicional del tenant.
- **P10:** una inyección en un work item.
- **P11:** latencia, límites y tamaño de los resultados.

Si P3 o P4 salen distinto de lo esperado, el punto 4 se vuelve a decidir antes de construir. El plan de la prueba está en el informe de la tarea, fuera del repositorio.

**(12) La interfaz (propuesto por un agente; D24).** Las pantallas que se tocan:
- en el catálogo de MCP, «Servicios externos» (hoy «Conectar MCP por URL», en «Próximamente»), la ficha del perfil y el alta en dos pasos;
- en el chat, la tarjeta «Conecta tu cuenta de Azure DevOps»;
- «Mis conexiones»;
- en Ajustes › Conectividad, los registros y el vencimiento del secreto;
- la Bandeja;
- en el Agent Builder, las tools remotas con la marca.

Ninguna está en el diseño: se piden a Claude Design en un brief aparte, y hasta entonces lo que no tenga diseño queda en «Próximamente». **Generalización:** el formato del perfil, el registro, el target 3LO, el consentimiento, los dos interceptores y la marca sirven igual para otros MCP remotos (GitHub, Atlassian). Lo propio de Azure DevOps es el proveedor de Microsoft, su app MCP, el requisito de una organización de Entra, las IPs del Acceso condicional y sus toolsets.
