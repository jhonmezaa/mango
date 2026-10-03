# @mango/api-client

Cliente TypeScript de `mango-api`, **generado** desde su OpenAPI (D6, D38). No se edita a mano: `src/` y `openapi.json` salen de un comando.

```
mise run api-client
```

Ese comando hace dos cosas y el resultado se versiona:

1. `python -m mango_api.openapi` exporta el OpenAPI de FastAPI a `openapi.json`. La app no lo sirve en runtime (`openapi_url=None`); se construye con servicios simulados y sin llamar a AWS.
2. `scripts/generate.mjs` genera `src/`:

| Archivo | Contenido | Import |
|---|---|---|
| `types.gen.ts` | Tipos de modelos, parámetros y respuestas | `@mango/api-client/types` |
| `zod.gen.ts` | Esquemas zod de lo mismo. Los modelos terminan en `Schema` (`zAgentOutSchema`); los de cada ruta, en `Path`, `Query`, `Body` o `Response` | `@mango/api-client/schemas` |
| `operations.gen.ts` | Una entrada por ruta que responde JSON: método, ruta y sus esquemas | `@mango/api-client/operations` |

Las rutas son relativas al prefijo de la API (`/api`, que la SPA recibe en su configuración). El nombre de cada operación es el de la función de la ruta en FastAPI (`get_agent` → `getAgent`). `POST /chat` no aparece en `operations` porque responde un stream SSE.

## Uso desde la web

`apps/web` no llama a `fetch` con estos tipos directamente. `client.call` (en `apps/web/src/api/operations.ts`) usa la tabla de operaciones con el mismo `fetch` autenticado del resto del cliente: valida parámetros, query y body antes de enviar, y la respuesta al recibirla.

```ts
const { items } = await api.call('listGroups');
const agent = await api.call('getAgent', { path: { agent_id: 'finops' } });
```

Una ruta nueva del backend queda disponible con solo regenerar.

## Cuándo regenerar

Siempre que cambie una ruta o un modelo de `apps/api`. Dos pruebas fallan si no se hizo:

- `apps/api/tests/test_openapi.py`: `openapi.json` no coincide con la app;
- `pnpm --filter @mango/api-client test`: `src/` no coincide con `openapi.json`.

Ambas corren en `mise run test` y en CI.

## Dependencia de desarrollo

`@hey-api/openapi-ts` (fijada a una versión exacta) genera los tipos y los esquemas zod. Solo corre al regenerar: no entra en el bundle de la web ni en ninguna imagen. En runtime el paquete solo usa `zod`, que la web ya tenía.
