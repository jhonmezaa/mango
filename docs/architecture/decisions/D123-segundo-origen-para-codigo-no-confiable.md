# D123 · Segundo origen para código no confiable y espejo de dependencias en la release

- **Estado:** vigente
- **Fecha:** 2026-11-07 (el punto 1, elegido por el dueño ese día, por menú: «Dominio registrable aparte (Recomendada)» en producción y, en la PoC, una segunda distribución `*.cloudfront.net`; el cómo, puntos 2 a 7, propuesto por un agente y aceptado cuando el dueño apruebe integrar el cambio que registra esta decisión)
- **Precisa / reemplaza a:** precisa [D25](D025-recursos-creados-en-runtime.md) y [D69](D069-assets-por-contenido-y-prefijo-unico.md) (el espejo de dependencias viaja en la release, nombrado por su contenido; nada se descarga en ejecución); precisa [D15](D015-red-de-la-poc.md) (una distribución de CloudFront más); precisa la CSP de la SPA (`frame-src` del segundo origen) y la excepción `CKV_AWS_174` de `AGENTS.md` (punto 6)
- **Precisada por:** —

## Decisión

Origen: el plan de capacidades del chat ([`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md)). La vista previa de Canvas ([D124](D124-canvas.md)) y las MCP Apps ([D125](D125-mcp-apps-de-solo-lectura.md)) ejecutan código que Mango no escribió. La SPA no puede hacerlo: su CSP tiene `script-src 'self'` y Trusted Types, y así se queda.

**(1) Dónde (elegido por el dueño, por menú: «Dominio registrable aparte (Recomendada)»).** En producción, el código no confiable se sirve desde un dominio registrable distinto del de la SPA. En la PoC, sin dominio propio, desde una segunda distribución `*.cloudfront.net`: `cloudfront.net` está en la Public Suffix List, así que cada distribución es otro sitio registrable. Sin dominio no hay subdominios por app: el aislamiento entre apps va por un iframe interior de origen opaco.

**(2) La distribución (propuesto por un agente).** Con OAC hacia un bucket de la release, su propia Response Headers Policy (CSP de hasta 1.783 caracteres) y `frame-ancestors` puesto por una CloudFront Function con KeyValueStore, para no cerrar un ciclo de dependencias entre las dos distribuciones. CORS solo en `/vendor/*`. Con dominio propio, un alias comodín y la validación del `Host`. La CSP de la SPA gana solo `frame-src` hacia ese origen: nunca `unsafe-eval` ni pierde Trusted Types. Un test impide que la distribución de la SPA sirva el runner.

**(3) El espejo (propuesto por un agente).** Las dependencias del navegador (React, Recharts, esbuild-wasm, Babel, `@tailwindcss/browser` y el núcleo de Pyodide con numpy, pandas y matplotlib; unos 100 MB) tienen versión fija y sha256, se arman en el build de la release y viajan en ella, nombradas por su contenido ([D69](D069-assets-por-contenido-y-prefijo-unico.md)). Nada se descarga de internet ni se compila en la cuenta del cliente ([D25](D025-recursos-creados-en-runtime.md)). `.wasm` se sirve como `application/wasm`, con un test.

**(4) El runner (propuesto por un agente).** Doble iframe en el segundo origen: `init` con un `initId` aleatorio, validación de `source`, `origin` y del conjunto exacto de puertos, RPC por `MessageChannel` (`CALL`, `RESOLVE`, `REJECT`, `ABORT`) con límites de tamaño y de tiempo, y una CSP del iframe interior que solo se endurece. `unsafe-eval` solo dentro del sandbox.

**(5) Antes de construir (propuesto por un agente).** Modelo de amenazas `ui-sandbox-threat-model.md` y pruebas en AWS (V0 del plan, con autorización del dueño): que dos distribuciones son dos sitios, el tamaño de la CSP, `.wasm` con su tipo, y Worker y Pyodide en origen opaco.

**(6) La excepción de TLS (propuesto por un agente).** Mientras la segunda distribución use el certificado por defecto `*.cloudfront.net`, le aplicaría la misma excepción de la PoC que a la de la SPA (`CKV_AWS_174`). No se registra ni se suprime todavía: se consulta con el dueño en el PR de infraestructura (V1 del plan), como toda excepción.

**(7) Cuotas (propuesto por un agente).** 20 Response Headers Policies por cuenta: el segundo origen usa una.
