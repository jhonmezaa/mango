# D32 · Harness por agente e id del agente

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

**Un harness por agente** (necesario para el rol por agente, [D10](D010-modelo-de-roles.md)). Cada versión aprobada es un `UpdateHarness`, que crea una versión inmutable; `mango-api` invoca un endpoint con nombre (`live`) que el provisioner mueve cuando la versión está lista. No hay un harness por versión. El rollback sigue siendo una versión nueva aprobada ([D18](D018-creacion-y-publicacion-de-agentes.md)). `mango-api` sigue armando cada invocación desde la versión publicada, leída por su hash.

**Nombres:** harness `Mango_<ns>_a_<id>` y Runtime de packs `Mango_<ns>_mcp_<id>`, porque AgentCore no admite guiones y limita el nombre a 40 y 48 caracteres; los roles IAM siguen como `Mango-<ns>-agent-<id>` y `Mango-<ns>-mcp-<id>` (regla 6).

**Id del agente:** aleatorio de 16 caracteres en base32 (80 bits); un ULID no cabe. Los agentes que vienen en la release conservan su slug (`finops`). Se autoriza crear recursos temporales en el laboratorio para medir lo que falta de los spikes, con limpieza al terminar
