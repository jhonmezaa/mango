# Sesión que sobrevive a recargar: cookie segura del servidor

> Fecha: 2026-10-03 · Estado: **diseño aprobado por el usuario el 2026-10-03** (opción C; decisiones en §9). Decisión D63. **Construido** en la rama `feat/session-cookie`; sin desplegar.
> Modelo de amenazas: `docs/security/threat-models/session-cookie-threat-model.md`.
> Revisa D20 («tokens solo en memoria») y TM-L13 del modelo del login. No cambia D13 (la API valida access tokens de Cognito).

## 1. Problema y pedido

Hoy los tres tokens (access, ID y refresh) viven en una variable de la SPA (`apps/web/src/auth/AuthProvider.tsx`). Recargar la página los pierde y hay que volver a ingresar con contraseña y MFA. Es a propósito (D20), pero el usuario pidió cambiarlo y eligió la opción **«sesión con cookie segura del servidor»**: `mango-api` guarda la sesión en una cookie que el JavaScript de la página no puede leer y, al recargar, la sesión se recupera sola. Quedaron descartadas: guardar el refresh token en el almacenamiento de la pestaña, y dejarlo como está.

## 2. Qué no cambia

- El login sigue siendo el propio: SRP contra Cognito desde la SPA, MFA TOTP, nunca `USER_PASSWORD_AUTH` (D20, D28).
- `mango-api` y el Gateway siguen validando **access tokens de Cognito** en la cabecera `Authorization` (D13). La cookie **no autentica** ningún endpoint de negocio: solo sirve para pedir un access token nuevo.
- El access token y el ID token siguen solo en memoria. Nada va a `localStorage` ni a `sessionStorage`.
- La duración máxima de la sesión sigue siendo la validez del refresh token de Cognito (`SESSION_HOURS`; Ajustes › Autenticación la muestra). Pasa de 12 h a 8 h (§9).
- CloudFront: el comportamiento `/api/*` ya reenvía cookies al origen y no cachea (`ALL_VIEWER_EXCEPT_HOST_HEADER`, `CACHING_DISABLED`, `infra/lib/constructs/edge.ts`). No hace falta cambiarlo.

## 3. Qué guarda la cookie: las opciones

| | A. Refresh token cifrado en la cookie | B. Identificador de sesión; el refresh token en DynamoDB | **C. Híbrida (recomendada)** |
|---|---|---|---|
| Qué viaja en la cookie | El refresh token cifrado con KMS | Un id aleatorio | Un id aleatorio + el refresh token cifrado con KMS |
| Qué guarda el servidor | Nada | El refresh token (cifrado) y los datos de la sesión | Solo los datos de la sesión (usuario, inicio, vencimiento). **Ningún secreto** |
| Cerrar una sesión desde el servidor | Solo vía Cognito (revocar el token) | Sí, al instante | Sí, al instante (se borra el registro) |
| Si alguien lee la tabla | No hay tabla | Obtiene textos cifrados de refresh tokens | No obtiene nada utilizable |
| Si alguien roba la cookie | Puede pedir access tokens a `mango-api` hasta que venza o se revoque | Igual | Igual |
| Regla «secretos solo en Secrets Manager o AgentCore Identity» | Se cumple | **Exige una excepción** (credencial de usuario en DynamoDB) | Se cumple |
| Tamaño de la cookie | ~3 KB | ~50 bytes | ~3 KB |
| Infraestructura nueva | Ninguna | Una tabla | Una tabla (sin secretos) |

**Recomendación: C.** Da el cierre inmediato desde el servidor de B sin guardar una credencial fuera de Secrets Manager, y no depende solo de Cognito para revocar como A. El costo es una cookie de unos 3 KB en cada petición a la aplicación. Si en la construcción el refresh token real no cabe en una cookie (límite de 4096 bytes; ver §11), la alternativa es B y su excepción se consulta antes.

## 4. Diseño (opción C)

### 4.1 La cookie

`__Host-mango_session=v1.<sid>.<texto cifrado>` con `HttpOnly; Secure; SameSite=Strict; Path=/`, sin `Domain`.

- **`HttpOnly`:** el JavaScript de la página no puede leerla; un XSS no se la lleva.
- **`__Host-`:** el navegador solo la acepta sobre HTTPS, sin `Domain` y con `Path=/`. Otro subdominio del dominio del cliente no puede plantar una cookie con el mismo nombre (fijación de sesión).
- **`SameSite=Strict`:** ningún sitio ajeno hace que el navegador la envíe. No estorba al SSO: la cookie solo la usan llamadas `fetch` de la propia SPA, que son del mismo sitio aunque la página se haya abierto desde un redirect.
- **`sid`:** 32 bytes aleatorios (base64url) generados por el servidor. Nunca se acepta un id propuesto por el cliente.
- **Texto cifrado:** el refresh token cifrado con la llave de datos de KMS que `mango-api` ya usa, con contexto de cifrado `{propósito, hash del sid, sub}`: un texto cifrado copiado a otra sesión o a otro usuario no descifra.
- **Duración:** la de la sesión (§4.5). Si la cookie persiste al cerrar el navegador es decisión del usuario (§9).

### 4.2 El registro de sesión

Tabla nueva `Mango-<ns>-WebSessions` (bajo demanda, CMK de datos, PITR, protección de borrado y `RETAIN` como las demás, TTL).

- `SESSION#<sha256(sid)>`: `sub`, `created_at`, `expires_at`, `federated`, `ttl`. Se guarda el **hash** del id: leer la tabla no da cookies válidas.
- `USER#<sub>`: `revoked_before`. Una sesión vale solo si empezó después de esa marca: cerrar todas las sesiones de una persona es una sola escritura.

### 4.3 Endpoints

Los tres exigen la cabecera propia `X-Mango-Session: 1`, que `Origin` sea el de la aplicación y, si el navegador la envía, `Sec-Fetch-Site: same-origin`. Responden con `Cache-Control: no-store`. Límite de tasa por sesión y por usuario.

| Endpoint | Autenticación | Qué hace |
|---|---|---|
| `POST /api/session` | Access token (Bearer) + `refresh_token` en el cuerpo | Comprueba el refresh token contra Cognito y que pertenece al mismo `sub` del access token. Crea el registro, cifra el token y pone la cookie. Si ya había una cookie, cierra esa sesión. Responde 204. |
| `POST /api/session/refresh` | Solo la cookie | Busca el registro (vigente, no revocado), descifra, renueva contra Cognito (`REFRESH_TOKEN_AUTH`), verifica el access token nuevo y que su `sub` es el del registro. Devuelve `{access_token, id_token, expires_in, federated}`. Si no hay sesión, o Cognito rechaza (token revocado, persona deshabilitada, vencido), borra el registro y la cookie y responde **204** sin cuerpo: no es un error, toda primera visita pregunta. |
| `DELETE /api/session` | Solo la cookie | Revoca el refresh token en Cognito (`RevokeToken`), borra el registro y la cookie. Idempotente. 204. |

- **Autorización declarada:** `POST /api/session` usa una dependencia propia que exige un access token verificado pero **no exige grupo**: una persona sin grupo también tiene sesión (ve «Todavía no tienes acceso») y recargar no debe sacarla. Los otros dos se autorizan con la cookie. No hay decisión de Cedar: cada quien actúa solo sobre su propia sesión.
- **Auditoría:** `session.started`, `session.renewed`, `session.ended` (motivo: cierre, revocada, vencida, rechazada por Cognito) y los rechazos. Nunca llevan tokens, cookie ni el `sid`. `session.renewed` cuenta como lectura en Auditoría (D64): se registra siempre y solo se lista con «Mostrar lecturas». Si no se puede auditar el inicio, no se crea la sesión.
- **Logs:** el cuerpo y la cookie no se registran nunca.

### 4.4 La SPA

- **Al cargar:** estado `loading` (el «Cargando…» a pantalla completa que ya existe) mientras llama a `POST /api/session/refresh`. Con 200 entra; con 204 (no hay sesión) muestra el login, sin mensaje de error. El callback de SSO tiene prioridad sobre la recuperación.
- **Al ingresar** (SRP o SSO): con los tokens recibidos llama a `POST /api/session` y **descarta el refresh token** de la memoria. Si esa llamada falla, la sesión sigue como hoy (en memoria) y se pierde al recargar.
- **Renovar:** `getAccessToken` pide el token nuevo a `POST /api/session/refresh` en vez de a Cognito. Sigue habiendo una sola renovación a la vez.
- **Cerrar sesión:** `DELETE /api/session`; con SSO, además el redirect de cierre de Cognito, como hoy.
- **Varias pestañas:** comparten la cookie; cada una tiene su access token en memoria. Al cerrar sesión, la pestaña avisa a las demás por `BroadcastChannel` (sin datos) y todas vuelven al login. Si en otra pestaña entra **otra persona**, la renovación devuelve un `sub` distinto del que la pestaña tenía: la pestaña descarta todo su estado y recarga, para no mezclar datos de dos personas.

### 4.5 Casos pedidos

| Caso | Qué pasa |
|---|---|
| **MFA** | La cookie solo se crea con los tokens de un ingreso completo (contraseña y TOTP). Recargar no salta el segundo factor: reutiliza la sesión que ya lo pasó, igual que hoy hace la renovación dentro de una pestaña. Al vencer la sesión, el ingreso vuelve a pedir MFA. |
| **Duración** | La sesión dura como máximo `SESSION_HOURS` desde el ingreso (límite absoluto: el refresh token de Cognito no se alarga al usarlo). El registro y la cookie llevan el mismo límite. Cuando Ajustes › Autenticación permita cambiarla (D21), `mango-api` leerá el valor vigente. |
| **Deshabilitar a una persona, quitarle un grupo sensible, restablecer MFA** | Esos flujos ya llaman a `AdminUserGlobalSignOut`; además escribirán la marca `revoked_before`. La siguiente renovación falla y la sesión termina. El access token ya emitido vale hasta 60 minutos (residual ya aceptado en D60). |
| **Quitar o dar un grupo no sensible** | Cada renovación pasa por el pre-token: los grupos nuevos aplican en la siguiente renovación, igual que hoy. |
| **SSO federado** | Mismo mecanismo: tras el callback, la SPA crea la sesión. Si aplica al SSO es decisión del usuario (§9). |
| **Persona sin grupo** | Conserva la sesión al recargar y sigue en «Todavía no tienes acceso». |
| **Dispositivo compartido** | «Cerrar sesión» borra la cookie y revoca el token. Lo demás depende de si la cookie persiste al cerrar el navegador (§9). |

## 5. Infraestructura

- Tabla `Mango-<ns>-WebSessions` y permisos de `mango-api` sobre ella (ARN concreto). La llave de KMS es la de datos, a la que `mango-api` ya tiene acceso.
- Variables de entorno de `mango-api`: nombre de la tabla y horas de sesión. Sin secretos.
- CloudFront: sin cambios. Se agregan tests que fijan que `/api/*` no cachea, que el comportamiento por defecto (S3) no reenvía cookies y que los logs de CloudFront no incluyen cookies.
- Sin supresiones nuevas de cdk-nag, cfn-guard ni Checkov previstas.

## 6. Interfaz

No se agrega ningún elemento. Lo visible: al abrir la aplicación aparece un momento el «Cargando…» que ya existe, antes del login o de la aplicación. Contexto para Claude Design: `docs/design/briefs/sync-2026-10-03i.md` (incluye la posible casilla «Mantener la sesión en este equipo», que **no** se construye sin diseño).

## 7. Decisiones registradas en §8

**D63 · Sesión web con cookie del servidor (revisa D20 y TM-L13).**
1. `mango-api` mantiene la sesión con una cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict` que lleva un id de sesión y el refresh token cifrado con KMS; el servidor guarda solo el registro de la sesión, sin secretos (opción C).
2. La cookie solo sirve para renovar; la API sigue validando access tokens de Cognito, que siguen en memoria. La SPA deja de conservar el refresh token.
3. Endpoints de sesión con cabecera propia y comprobación de origen (CSRF), sin caché y auditados.
4. La sesión dura 8 h como máximo (límite absoluto), la cookie persiste al cerrar el navegador y el SSO federado usa el mismo mecanismo (§9).
5. Deshabilitar, quitar un grupo sensible y restablecer MFA cierran también las sesiones del servidor.

## 8. Reglas de `AGENTS.md` y excepciones

- **Sin excepciones nuevas** con la opción C.
- **Excepción existente que se amplía (aceptada, §9):** el tramo CloudFront → ALB va en HTTP en la PoC. Hoy por ahí pasan access tokens; con este diseño pasan también el refresh token (una vez por ingreso, en el cuerpo de `POST /api/session`) y la cookie (en cada petición). Es tráfico interno de la VPC, sin exposición a internet, y desaparece con HTTPS en producción (D15).
- La opción B exigiría una excepción a «secretos solo en Secrets Manager o AgentCore Identity».

## 9. Decisiones del usuario (2026-10-03)

1. **Duración de la sesión: 8 h** (antes 12 h). `SESSION_HOURS` baja a 8: cambia la validez del refresh token del cliente de Cognito con el próximo `UpdateStack` y el valor que muestra Ajustes › Autenticación.
2. **Al cerrar el navegador: la cookie persiste** hasta que venza la sesión o se cierre sesión (`Max-Age` igual al tiempo que le queda a la sesión).
3. **SSO: sí**, las sesiones federadas usan el mismo mecanismo y los mismos límites.
4. **Diseño aprobado: opción C**, y se acepta que en la PoC el refresh token y la cookie pasen por el tramo HTTP interno CloudFront → ALB (excepción existente, ampliada en `AGENTS.md`).

## 10. Riesgos residuales

- **Cookie robada** (malware en el equipo, acceso físico): sirve para pedir access tokens hasta que la sesión venza, se cierre o se revoque. No se ata a IP ni a dispositivo (rompería redes móviles y VPN).
- **XSS:** ya no puede llevarse el refresh token, pero mientras corre en la página puede pedir access tokens (60 minutos de vida) y usarlos. La CSP estricta sigue siendo el control principal.
- **Access token tras revocar:** vale hasta 60 minutos (igual que hoy).
- **Tramo HTTP de la PoC:** §8.

## 11. Lo que no se verificó

- **Tamaño real del refresh token de Cognito** y, por tanto, que la cookie cifrada quepa en 4096 bytes. Se mide al empezar la construcción; si no cabe, se consulta la opción B.
- **Límite del WAF del user pool:** las renovaciones pasan a salir de las IP de `mango-api`, no de cada navegador, y el WAF limita `InitiateAuth` a 300 por IP cada 5 minutos. Alcanza para unos miles de personas activas por tarea, pero no se midió. Alternativa a evaluar: `AdminInitiateAuth` (IAM), sin confirmar que el WAF no lo cuente ni qué flujos exige en el cliente.
- **Comportamiento contra Cognito real** de la renovación desde el servidor (que el pre-token corre igual y el scope de autoservicio sigue suprimido) y de `RevokeToken` desde `mango-api`.
- **Cookies `Secure` en el mock local** (`http://localhost`): Chromium las acepta; Safari no. Las pruebas de Playwright usan Chromium.
- Nada se probó contra el laboratorio: no hay cambios en AWS autorizados.
