# D33 · Autorización de agentes y de sus tools

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** ajusta [D18](D018-creacion-y-publicacion-de-agentes.md); en el texto: la firma `X-Mango-Invocation` v2 sustituye a la v1 de [D13](D013-identidad-hasta-las-tools.md)
- **Precisada por:** [D70](D070-dos-tareas-y-limites-compartidos.md) (precisa: los límites de la consulta de personas se cuentan entre todas las tareas)
- **Tema en el registro original:** Autorización de agentes y de sus tools (ajusta [D18](D018-creacion-y-publicacion-de-agentes.md))

## Decisión

**`UseAgent` por datos:** `mango-api` pasa a Verified Permissions la entidad del agente con sus grupos y usuarios, y una política estática decide. El provisioner no escribe en el policy store.

**Tools por agente:** el Gateway solo ve al usuario (su JWT), no al agente, así que no hay Cedar L2 por agente. La lista de tools de la versión aprobada se aplica en `allowedTools` y en el interceptor, con una firma `X-Mango-Invocation` v2 que incluye agente, versión y tools; la firma v1 se rechaza. Cedar L2 queda por tool y por tipo de usuario. Solo el rol de `mango-api` puede llamar a `InvokeHarness`, porque esa llamada permite sobrescribir prompt y tools
