# Revisión de seguridad: `feat/web-design-system` (2026-09-29)

**Alcance:** cambios sin commitear de la rama `feat/web-design-system` frente a `main` (`git diff main` más los ficheros sin seguimiento). Cubre `apps/web/**`, `apps/api/src/mango_api/harness.py` con su test y `pnpm-lock.yaml`. `docs/design/mango-hub/**` queda fuera; solo se comprobó que no se construye ni se sirve.

**Tipo:** revisión enfocada del diff (modo guidance de `security-audit`), sin auditoría completa. Es estática, más la ejecución local de los tests, el lint y un build de la SPA a un directorio temporal.

**Contexto leído:**
- `AGENTS.md`, con sus reglas y la tabla de excepciones.
- `docs/security/threat-models/mango-architecture-threat-model.md` (TM-001, TM-012).
- `infra/lib/constructs/edge.ts` (CSP y cabeceras de CloudFront).
- `apps/web/vite.config.ts` (CSP en `<meta>`).
- `apps/web/src/{auth,api,security,i18n}` como dependencias del código cambiado.

## Resumen ejecutivo

El diff es un rediseño visual. Porta el design system de Mango: tokens, shell, sidebar, chat, login con carrusel, visor de auditoría y tema claro/oscuro. **No introduce vulnerabilidades críticas, altas, medias ni bajas.** Los controles de seguridad existentes siguen intactos:

- Markdown del LLM con `skipHtml` y `urlTransform`.
- Enlaces solo http(s) y con confirmación.
- Tokens únicamente en memoria.
- `sessionStorage` solo para el estado PKCE (excepción documentada).
- Retorno post-login validado.
- Autorización de admin aplicada en el servidor.
- CSP estricta con Trusted Types.

Además, el diff reduce la superficie:
- Elimina `@tailwindcss/typography` y sus dependencias transitivas (`postcss-selector-parser`, `cssesc`, `util-deprecate`).
- No añade paquetes.
- No carga fuentes externas ni empaquetadas.

El único uso nuevo de `localStorage` es para preferencias de UI (tema, sidebar colapsado, grupos abiertos). Está encapsulado en un módulo, con try/catch, y cada lectura se valida contra valores permitidos. Cumple JS-STORAGE-001 y REACT-AUTH-001 sin necesidad de excepción.

Hay 5 observaciones **informativas o de hardening**. Casi todas son preexistentes o de higiene y ninguna bloquea el merge.

**Verificación ejecutada:**
- `pnpm --filter @mango/web test`: 13 ficheros, 96 tests OK.
- `pnpm --filter @mango/web lint`: ESLint sin warnings y Prettier OK.
- `uv run pytest tests/test_app.py`: 15 OK.
- `vite build` a un directorio temporal, ya borrado:
  - `index.html` sin `<script>` ni `<style>` inline, con el `<meta>` CSP inyectado.
  - Sin source maps.
  - El CSS no referencia URLs externas; solo contiene un `data:image/svg+xml`.

## Hallazgos

### Crítico

Ninguno.

### Alto

Ninguno.

### Medio

Ninguno.

### Bajo

Ninguno.

### Informativo / hardening

#### I-1. El salto de párrafo del harness altera el texto persistido y puede partir bloques de markdown

- **Ubicación:** `apps/api/src/mango_api/harness.py:111` (`PARAGRAPH_BREAK`) y `:128-132`.
- **Evidencia:** al empezar un bloque `toolUse`, si `result.text` no termina en `\n`, se añade `"\n\n"` a `result.text` y se emite como `delta`.
- **Análisis de seguridad:** es una constante del servidor, sin datos del usuario ni del modelo. No hay inyección y el estado está acotado a `result` de ese turno. El texto persistido (`conversations.stored`) ya no es literalmente la salida del modelo, pero no es el audit trail: `audit.py` no guarda prompts ni respuestas. El test se actualizó en consecuencia (`apps/api/tests/test_app.py:291,298`).
- **Impacto:** solo de presentación. Si el modelo abre un bloque de código o una tabla antes de invocar una tool y lo cierra después, el `\n\n` parte el bloque.
- **Propuesta (opcional):** no insertar el salto si hay un fence de código sin cerrar, es decir, si el número de líneas que empiezan por tres backticks en `result.text` es impar. También se puede documentar que el contenido guardado es el de visualización.

#### I-2. El prototipo de diseño contiene un ID de cuenta de 12 dígitos y emails de un dominio que podría ser real

- **Ubicación:**
  - `docs/design/mango-hub/src/observability.jsx:400` (`"account_id", "719283740192"`).
  - `docs/design/mango-hub/src/other-views.jsx:825,845` (`platform-ops@grupomango.com`, `finops@grupomango.com`).
  - `docs/design/mango-hub/src/data.js:6` (`amorales@acme.corp`).
- **Contexto:** la carpeta no se construye ni se despliega. `edge.ts:17` solo publica `apps/web/dist`, y Vite tiene `root` y `publicDir` en `apps/web`. Aun así, se va a commitear.
- **Impacto:** si el ID o el dominio son reales, se divulgarían datos no secretos pero identificativos. AGENTS.md exige no publicar IDs de cuenta ni emails reales.
- **Propuesta:** confirmar antes del commit que son ficticios. Si no hay certeza, sustituirlos por `123456789012` / `111122223333` y dominios `example.com`.

#### I-3. Los enlaces externos del LLM no tienen allowlist de dominios (TM-001) y aceptan `http:` hacia cualquier host (preexistente)

- **Ubicación:**
  - `apps/web/src/security/safeUrl.ts:14-24`: `parseExternalHttpUrl` acepta `http:` para cualquier host.
  - `apps/web/src/components/ChatMarkdown.tsx:10-41`.
  - `apps/web/src/components/ExternalLinkDialog.tsx:48-50`.
- **Contexto:** el diff solo reestiliza el diálogo, que se renderiza ahora mediante un portal. Siguen presentes el host en negrita, la URL completa con `break-all`, el foco inicial en "Cancelar" y `window.open(..., 'noopener,noreferrer')`. `URL.host` muestra los IDN en punycode, así que los homógrafos quedan a la vista.
- **Impacto:** una prompt injection indirecta puede proponer `https://atacante/?d=<datos>`. La exfiltración requiere que el usuario confirme en el diálogo, por lo que el riesgo está mitigado pero no eliminado. Es la mitigación "allowlist de dominios" que TM-001 recomienda y que aún no está implementada.
- **Propuesta (siguiente iteración):**
  - Añadir una allowlist opcional de dominios en `config.json`, validada con zod. Fuera de la allowlist, mostrar un aviso reforzado o bloquear.
  - Rechazar `http:` fuera de loopback en `parseExternalHttpUrl`, reutilizando `isAllowedOrigin`.

#### I-4. En el historial, el nombre de tool no tiene longitud máxima (preexistente, ahora más visible)

- **Ubicación:**
  - `apps/web/src/api/schemas.ts:32`: `toolCallSchema.name: z.string()`, sin `max`.
  - `apps/web/src/api/chatEvents.ts:7`: el stream sí aplica `max(128)`.
  - `apps/web/src/components/chat/ToolCallList.tsx:30-33`: renderiza el nombre desconocido como texto.
- **Análisis:** no hay XSS. React escapa el texto, e i18next 26 no reinterpreta los valores interpolados: se verificó que `{{…}}`, `$t(…)` y HTML en el nombre salen literales. Además, `fromApiMessage` pliega las entradas `started`/`completed` (`chatState.ts:80-84`).
- **Impacto:** solo robustez y UI. Un nombre enorme guardado ensancharía las pastillas.
- **Propuesta:** `name: z.string().max(128)` en `toolCallSchema`, igual que en el stream.

#### I-5. La prohibición de Web Storage en ESLint se puede sortear (hardening)

- **Ubicación:** `apps/web/eslint.config.js:53-62`.
- **Contexto:** la regla cubre `localStorage`/`sessionStorage` como globales y como `window.*`. No cubre `globalThis.localStorage`, `self.localStorage` ni `window['localStorage']`.
- **Sobre el override nuevo para tests** (`eslint.config.js:65-72`): está acotado a `src/**/*.test.{ts,tsx}` y solo desactiva las reglas de storage. Las prohibiciones de `dangerouslySetInnerHTML`, `innerHTML`, `eval` y `new Function` siguen activas.
- **Impacto:** ninguno hoy, porque el código solo usa storage en `preferences/storage.ts` y `auth/oidc.ts`, ambos con justificación. El riesgo está en regresiones futuras que guarden tokens.
- **Propuesta:**
  - Añadir entradas `{ object: 'globalThis' | 'self', property: 'localStorage' | 'sessionStorage' }` a `no-restricted-properties`.
  - Añadir un selector `no-restricted-syntax` para `MemberExpression[computed=true][property.value=/^(local|session)Storage$/]`.

## Controles verificados (sin hallazgos)

**XSS e inyección de HTML**
- No hay `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` ni `setTimeout` con string en `apps/web/src`, verificado con grep y ESLint.
- **Markdown del LLM:** `ChatMarkdown` mantiene `skipHtml`, `urlTransform={markdownUrlTransform}`, imágenes bloqueadas y ningún plugin rehype. El nuevo `streaming` solo cambia una clase.
- **Visor de auditoría** (`AdminAuditPage.tsx`):
  - El resumen se genera como texto plano (`:53-58`).
  - El detalle se muestra con `JSON.stringify` dentro de `<pre>`, escapado por React (`:322-325`).
  - La clase del punto sale de un conjunto cerrado (`eventTone`).
  - Los `id`/`aria-controls` llevan el prefijo `audit-` y ningún código lee propiedades con nombre de `window`/`document`, así que no hay gadget de DOM clobbering.
- **Otros datos del servidor renderizados como texto:**
  - Títulos de conversación (`ThreadList.tsx:126-128`).
  - `user_id`, `business_unit` y `role` en `UserMenu`; `role` es un enum de zod.
  - Mensajes del usuario, sin markdown (`chat/ChatMessage.tsx:22`).
  - Errores: solo claves i18n mapeadas y nunca texto del backend (`chatState.ts:46-53`, `LoginPage.tsx:37-40`).
- **i18n:** `escapeValue: false` es correcto porque React escapa. No se usa `<Trans>` con componentes, y los valores interpolados no se reprocesan (`skipOnVariables`, verificado con i18next 26.4.2).

**URLs y navegación**
- `window.open` solo tras confirmación, con `noopener,noreferrer` y sobre una `URL` ya parseada que admite solo http(s) y rechaza credenciales en la URL.
- La URL que se abre es la misma que se mostró: se captura en el clic y no cambia aunque el stream siga.
- **Retorno post-login al deep link `/c/:id`:** el path se guarda en el `state` OIDC (`AuthProvider.tsx:83`), que va en `sessionStorage` según la excepción documentada. Al volver se valida con `safeReturnPath` (`safeUrl.ts:35-45`), que rechaza `//`, `\`, esquemas y otros orígenes. Este código no cambia en el diff.
- `/c/:id` se valida con `conversationIdSchema` (`^[A-Za-z0-9_-]{1,64}$`) antes de pedirlo a la API (`ChatPage.tsx:75,171`). Los enlaces del historial y de la conversación nueva usan `encodeURIComponent`.
- Toda la navegación nueva (Topbar, Sidebar, NotFound) va a rutas constantes (`/`, `/admin`).

**Tokens y almacenamiento**
- No hay cambios en `auth/`: los tokens siguen en `InMemoryWebStorage` y solo el estado PKCE va a `sessionStorage` (excepción de AGENTS.md del 2026-09-29).
- `preferences/storage.ts` es el único punto que toca `localStorage`, con claves tipadas y try/catch.
- Todas las lecturas se validan:
  - Tema: solo `light` o `dark` (`theme.ts:11-19`).
  - Colapsado: `=== '1'` (`AppLayout.tsx:18`).
  - Grupos: `JSON.parse` en try/catch y solo un booleano en `gov` (`Sidebar.tsx:14-25`).
- El tema se aplica desde `main.tsx` sin script inline.

**Autorización en la UI**
- La visibilidad de admin sale de `me.is_admin` (`GET /api/me`). Sidebar y AdminAuditPage lo marcan como solo UX.
- `GET /api/admin/audit` aplica `require(caller, "ViewAudit", …)` y limita `limit` entre 1 y 200 (`app.py:354-358`). Un 403 del servidor muestra "sin permiso".

**CSP y cabeceras**
- **Compatibilidad del diff con la CSP de `edge.ts:104-117`**, que incluye `script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`:
  - No hay scripts ni `<style>` inline, ni atributos `style=` en JSX. El estilo de alineación de tablas de react-markdown se aplica por CSSOM, que la CSP permite.
  - Solo hay tipografías del sistema.
  - El SVG `data:` del CSS y `/favicon.svg` quedan cubiertos por `img-src`.
  - `createPortal` no es un sink de Trusted Types.
- `public/favicon.svg` es estático, sin `<script>`, `on*` ni referencias externas.
- `index.html` solo añade `data-theme`, el favicon y `color-scheme`.
- Clickjacking cubierto por `frame-ancestors 'none'` y `X-Frame-Options: DENY`.

**Focus traps y diálogos**
- `useFocusTrap` restaura el foco, cierra con Escape y no maneja datos.
- En el diálogo de enlace externo, el foco inicial va a "Cancelar", así que un Enter accidental no abre el enlace.
- El overlay cierra al hacer clic fuera, y el portal evita anidar el diálogo dentro de `<p>`.

**Carrusel y timers**
- `setInterval` con función (no string), limpiado en el cleanup.
- Se pausa con hover/foco y con `prefers-reduced-motion`.
- Solo muestra contenido i18n estático.

**Dependencias**
- Se elimina `@tailwindcss/typography@0.5.20` con `postcss-selector-parser`, `cssesc` y `util-deprecate`.
- No se añaden paquetes y el lockfile es coherente con `package.json`.
- `@fontsource` no existía en `main`, así que no hay nada que eliminar.

**Secretos y datos reales**
- En el código de `apps/` solo aparecen emails `@example.com` de fixtures.
- No hay IDs de cuenta, claves ni tokens.
- `docs/design/mango-hub` no se sirve (ver I-2).

**Backend (`harness.py`)**
- Cumple FASTAPI-VALID y RESP: sin cambios de contrato, endpoints ni validación.
- El cambio añade una constante al stream; no aparecen sinks nuevos, logs de prompts ni estado compartido entre peticiones.

## Referencias de las skills aplicadas

- **`security-best-practices`**, en modo revisión:
  - `javascript-typescript-react-web-frontend-security.md`: REACT-XSS-001/002, REACT-DOM-001, REACT-URL-001, REACT-MARKUP-001, REACT-TT-001, REACT-CSP-001, REACT-AUTH-001, REACT-AUTHZ-001, REACT-REDIRECT-001, REACT-HEADERS-001, REACT-SUPPLY-001, REACT-CONFIG-001.
  - `javascript-general-web-frontend-security.md`: JS-XSS-001..004, JS-URL-001/002, JS-CSP-001/002, JS-TT-001, JS-STORAGE-001, JS-SUPPLY-001, FS-DOMC-001.
  - `python-fastapi-web-server-security.md`: FASTAPI-VALID-001, FASTAPI-RESP-001, FASTAPI-AUTHZ-001, FASTAPI-INJECT-*, FASTAPI-SUPPLY-001.
- **`security-audit`**, en modo guidance: revisión enfocada del diff con el criterio de límite de confianza y resultado concreto. Sin directorio de salida ni artefactos, y sin ejecutar código objetivo fuera de los tests, el lint y el build del propio repositorio.
- **Excepciones de AGENTS.md respetadas y no reportadas:** HSTS en producción, `sessionStorage` para el estado PKCE y HTTP en el tramo CloudFront → ALB de la PoC.
