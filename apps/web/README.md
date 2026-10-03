# @mango/web

SPA de la PoC FinOps de Mango: React 19 + TypeScript + Vite + Tailwind. Contrato con el backend: [`docs/specs/poc-api-contract.md`](../../docs/specs/poc-api-contract.md). UX: [`docs/specs/mvp-finops.md`](../../docs/specs/mvp-finops.md) §7.

## Scripts

| Comando                              | Qué hace                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @mango/web dev:mock`  | Dev server con **mock** de Cognito y de `mango-api` (sin AWS). Abre http://localhost:5173                                                                                             |
| `pnpm --filter @mango/web dev`       | Dev server contra un backend real: sirve `/config.json` desde `config.local.json` (no versionado) y hace proxy de `/api` a `MANGO_API_URL` (por defecto `http://localhost:8000`)      |
| `pnpm --filter @mango/web build`     | Typecheck + build de producción en `dist/`                                                                                                                                            |
| `pnpm --filter @mango/web lint`      | ESLint (0 warnings) + Prettier                                                                                                                                                        |
| `pnpm --filter @mango/web typecheck` | `tsc` de la app y de la configuración/mock                                                                                                                                            |
| `pnpm --filter @mango/web test`      | Vitest: la app en jsdom y el mock en Node (dos proyectos)                                                                                                                             |
| `pnpm --filter @mango/web e2e`       | Playwright (`e2e/`): crear → revisar → usar un agente en Chromium contra el mock. Levanta su propio dev server (puerto 5273). La primera vez: `pnpm exec playwright install chromium` |

Con `mise`: `mise exec -- pnpm --filter @mango/web <script>`.

`config.local.json` sigue el contrato de `docs/specs/poc-api-contract.md`, incluido el objeto `auth` (obligatorio).

Para probar el bundle de producción con el mock: `pnpm build && pnpm exec vite preview --mode mock` (http://localhost:4173).

### Mock local

`mock/` es un plugin de Vite (`mockBackend.ts`): solo existe en el dev/preview server y **no entra en el bundle**. Está partido por dominio: `cognito.ts`, `chat.ts`, `admin.ts`, `mfaResets.ts`, `audit.ts`, `agents.ts` (agentes de ejemplo, compartidos) y un archivo por pantalla del marketplace (`marketplace.ts`, `agentBuilder.ts`, `agentReview.ts`, `orgChart.ts`). `mockBackend.ts` solo los conecta. `mockBackend.test.ts` comprueba las respuestas contra el contrato generado. La app ejecuta su flujo real (SRP contra la API de Cognito y, para SSO, OAuth code + PKCE) contra un Cognito simulado; no hay bypass de autenticación en el código de la app. En el login del mock cualquier contraseña entra (la prueba SRP solo se valida en forma; la matemática la cubren los vectores de `srp.test.ts`) y el correo elige el camino: `mfa@example.com` pide código TOTP, `enroll@example.com` hace el alta de MFA, `temp@example.com` tiene contraseña temporal ("Crea tu contraseña"), `nogroup@example.com` y las cuentas creadas con "Crear cuenta" no tienen grupo. El `config.json` del mock trae `aiPolicyUrl`, así que el registro pide aceptar la política de uso de IA. En Ajustes › General › Autenticación el admin del mock puede proponer y retirar resets de MFA (aprobar exige otro admin). Los códigos de verificación y recuperación son `123456`; los TOTP, cualquier 6 dígitos salvo `000000`. Mensajes especiales del chat:

- un mensaje que contenga `presupuesto agotado` devuelve `402 budget_exceeded`;
- uno que contenga `error` emite un evento SSE `error`.

La respuesta simulada incluye enlaces `javascript:`, HTML crudo e imágenes remotas para comprobar el renderizado seguro.

## Estructura

```
src/
  api/        cliente HTTP, parser SSE, eventos del chat, esquemas zod del contrato, `operations.ts` (llamadas por nombre al cliente generado)
  auth/       login propio (cognito/: API de Cognito, SRP, flujos), SSO bajo demanda (oidc-client-ts), AuthProvider, sesión (/api/me, historial)
  components/ shell (sidebar, topbar), chat/, admin/, markdown seguro, diálogo de enlace externo, iconos y piezas comunes del diseño (Tabs, Alert, Badge, SidePanel, Modal)
  config/     carga y validación de /config.json
  hooks/      estado del chat (reducer), streaming, focus trap, media queries
  i18n/       i18next (es): `locales/es.ts` junta un módulo por vista de `locales/es/`
  layouts/    AppLayout (sidebar colapsable, rail <1200 px, off-canvas <900 px), navegación y `screens.ts` (registro de pantallas)
  lib/        formato de fechas y duraciones
  pages/      login (login/: pasos del diseño), chat, administración, 404 y una carpeta por pantalla del marketplace
  agents/     lo que comparten las pantallas de agentes: ids, agentes fijados y códigos de las reglas de envío
  preferences/ tema, sidebar, grupos de navegación, agentes fijados y vista del Marketplace en localStorage (único módulo que lo usa; nunca tokens)
  security/   validación de URLs
  styles/     design system de Mango (tokens, componentes, shell, chat, login) y un archivo por pantalla
mock/         mock de Cognito + mango-api (solo desarrollo), partido por dominio
e2e/          tests de Playwright contra el mock
```

### Cliente de API

`packages/ts/api-client` se genera desde el OpenAPI de FastAPI con `mise run api-client` (ver su README). `client.call('<operación>', …)` llama a cualquier ruta JSON por su nombre y valida la petición y la respuesta con los esquemas generados. Los métodos anteriores (`getMe`, `getBudgets`…) conservan sus esquemas zod escritos a mano, que son más estrictos que los modelos de respuesta actuales del backend.

### Pantallas del marketplace

Marketplace, Agent Builder, Revisión de agentes, Org Chart y Brains están construidas según el diseño (D24). Cada una tiene su carpeta `src/pages/<pantalla>/` con `screen.ts` (rutas, vista de la navegación y `available`) y su página. Lo que el diseño muestra y todavía no tiene backend aparece como «Próximamente», sin datos de ejemplo. Para cambiar una pantalla solo se tocan sus archivos:

| Qué                    | Dónde                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Rutas y disponibilidad | `src/pages/<pantalla>/screen.ts` (`available: true` la activa en la navegación) |
| Página y componentes   | `src/pages/<pantalla>/` y `src/components/<pantalla>/`                          |
| Textos                 | `src/i18n/locales/es/<pantalla>.ts`                                             |
| Estilos                | `src/styles/<pantalla>.css`                                                     |
| Rutas del mock         | `mock/<pantalla>.ts` (los agentes de ejemplo están en `mock/agents.ts`)         |

`App.tsx`, `layouts/navigation.ts`, `locales/es.ts`, `index.css` y `mock/mockBackend.ts` ya las registran: no hace falta editarlos.

Reglas comunes a estas pantallas:

- **El servidor decide.** `is_admin`, `can.create_agent`, `is_author`, `retryable` y `violations` solo muestran u ocultan controles. Autoriza y valida la API.
- **Texto de creadores como texto.** Nombres, descripciones, roles, prompts y motivos se pintan con JSX; nunca como HTML.
- **Enlaces al Builder siempre con versión** (`/admin/<id>/<versión>`): `/admin/<id>` necesita `UseAgent` para saber cuál es la publicada, y el creador puede no tenerlo.
- **Reglas de envío:** los códigos están en `src/agents/rules.ts` (un test de `apps/api` comprueba que son los de la API). Cada pantalla tiene su redacción: el Builder le habla a quien crea; Revisión, a quien revisa. Un 422 `validation_failed` trae las reglas en `ApiError.violations`.
- **Estilos compartidos** (`mk-name`, `mk-avatar`, `mc-table`, `ap-bar`, `sr-link`…) viven en `styles/agents.css`; cada pantalla solo tiene los suyos.
- **Preferencias de UI** (vista de tarjetas o lista, agentes fijados) pasan por `src/preferences/storage.ts` y se validan al leerlas.

## Seguridad

- **Login propio (D20):** SRP (`USER_SRP_AUTH`) implementado sin dependencias (`BigInt` + WebCrypto) y llamadas a la API pública de Cognito con `fetch`; nunca `USER_PASSWORD_AUTH`. Contraseñas, códigos y el secreto TOTP solo viven en el estado de los componentes: nunca en storage, URL, consola ni telemetría. El QR del alta de MFA se genera en el navegador (`qrcode-generator`, chunk bajo demanda).
- **Tokens solo en memoria** (`AuthProvider`). Al recargar, se vuelve a iniciar sesión. Con SSO, solo el `state` y el `code_verifier` de PKCE, que son transitorios y de un solo uso, pasan por `sessionStorage` durante el redirect. Al salir se revoca el refresh token (`RevokeToken`).
- Se envía el **access token** (nunca el ID token) como `Bearer`, con `credentials: 'omit'`. Antes de cada llamada se renueva si le quedan menos de 360 s (TM-I5).
- `apiBasePath` debe ser una ruta del mismo origen, y `cognitoDomain` debe ser https (http solo en localhost).
- **Markdown del LLM** (TM-012): `react-markdown` con `skipHtml` y sin `rehype-raw`. Solo se aceptan URLs http(s) y todo enlace pide confirmación mostrando la URL completa. Las imágenes se reemplazan por un texto. No hay Mermaid ni KaTeX.
- Diseño: tokens y componentes portados de `docs/design/mango-hub` (v0.11/v0.12). Tema claro por defecto y oscuro opcional (`data-theme` en `<html>`; la preferencia guardada manda). Solo tipografías del sistema (sans y mono): no se cargan fuentes externas ni empaquetadas.
- ESLint prohíbe `dangerouslySetInnerHTML`, asignaciones a `innerHTML`/`outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` y el uso de `localStorage`/`sessionStorage`.
- zod corre en modo `jitless` para no necesitar `eval` (compatible con CSP y Trusted Types).
- El build no publica source maps e inyecta un `<meta>` CSP como defensa en profundidad: `script-src 'self'; object-src 'none'; base-uri 'none'; img-src 'self' data:; require-trusted-types-for 'script'; trusted-types 'none'`.

### Cabeceras que debe poner CloudFront (infra)

El `<meta>` no admite `frame-ancestors` ni reportes, y `connect-src` depende del dominio de Cognito del cliente. La política autoritativa va en el response headers policy de CloudFront:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://<cognitoDomain>; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

HSTS en producción según la excepción acordada en `AGENTS.md`. `config.json` e `index.html` con `Cache-Control: no-store`, y `assets/*` como inmutables.
