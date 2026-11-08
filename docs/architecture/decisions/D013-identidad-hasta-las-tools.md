# D13 · Propagación de identidad a las tools

- **Estado:** parcial. Rige todo salvo «Harness con `Memory: Disabled`», que contradice y reemplaza [D122](D122-memoria-de-agentcore-por-persona.md) (2026-11-07, elegida por el dueño por menú): la memoria de AgentCore pasa a ser por persona. Desde el 2026-11-08 D122 está construida y apagada hasta la prueba M0: mientras tanto todo harness sigue con `memory: disabled`.
- **Fecha:** 2026-09-28 · complemento del 2026-09-29
- **Precisa / reemplaza a:** —
- **Precisada por:** [D33](D033-autorizacion-de-agentes-y-tools.md) (firma v2 en lugar de la v1); [D93](D093-mcp-remotos-de-terceros.md) (un interceptor `RESPONSE` y el borrado de `_meta` hacia los MCP remotos; en estado propuesta); [D122](D122-memoria-de-agentcore-por-persona.md) (contradice y reemplaza «Harness con `Memory: Disabled`»: memoria de AgentCore por persona; el resto sigue rigiendo)

## Decisión

`mango-api` valida el access token y lo pasa por invocación al harness como header `Authorization` de una tool `remote_mcp` apuntando al Gateway (`CUSTOM_JWT` contra Cognito; Policy Cedar con claims como tags). Un **REQUEST interceptor** borra cualquier `_mango_ctx` que ponga el modelo e inyecta el token; el Lambda target **revalida el JWT** y solo confía en él. El budget se reserva en `mango-api` antes de cada invocación, más los topes del harness (`maxTokens`, `maxIterations`, `timeoutSeconds`), porque no hay hook antes de cada llamada al modelo. Harness con `Memory: Disabled` y `AllowedTools: ["@finops"]`.

**Complemento (2026-09-29, hallazgo F1):** `mango-api` firma cada invocación (`X-Mango-Invocation`, HMAC con llave en Secrets Manager) y el interceptor rechaza llamadas al Gateway sin firma válida, para que el token del usuario no permita saltarse autorización, budget y auditoría
