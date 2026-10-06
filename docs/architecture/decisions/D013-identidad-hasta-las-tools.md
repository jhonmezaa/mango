# D13 · Propagación de identidad a las tools

- **Estado:** vigente
- **Fecha:** 2026-09-28 · complemento del 2026-09-29
- **Precisa / reemplaza a:** —
- **Precisada por:** [D33](D033-autorizacion-de-agentes-y-tools.md) (firma v2 en lugar de la v1)

## Decisión

`mango-api` valida el access token y lo pasa por invocación al harness como header `Authorization` de una tool `remote_mcp` apuntando al Gateway (`CUSTOM_JWT` contra Cognito; Policy Cedar con claims como tags). Un **REQUEST interceptor** borra cualquier `_mango_ctx` que ponga el modelo e inyecta el token; el Lambda target **revalida el JWT** y solo confía en él. El budget se reserva en `mango-api` antes de cada invocación, más los topes del harness (`maxTokens`, `maxIterations`, `timeoutSeconds`), porque no hay hook antes de cada llamada al modelo. Harness con `Memory: Disabled` y `AllowedTools: ["@finops"]`.

**Complemento (2026-09-29, hallazgo F1):** `mango-api` firma cada invocación (`X-Mango-Invocation`, HMAC con llave en Secrets Manager) y el interceptor rechaza llamadas al Gateway sin firma válida, para que el token del usuario no permita saltarse autorización, budget y auditoría
