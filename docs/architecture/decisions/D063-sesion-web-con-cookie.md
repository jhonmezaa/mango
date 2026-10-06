# D63 · Sesión web con cookie del servidor

- **Estado:** vigente
- **Fecha:** 2026-10-03
- **Precisa / reemplaza a:** revisa [D20](D020-login-y-registro.md) y TM-L13; precisa [D21](D021-ajustes-auth.md) y [D28](D028-implementacion-del-login-propio.md); en el texto: amplía la excepción de [D15](D015-red-de-la-poc.md) (punto 6)
- **Precisada por:** [D64](D064-interfaz-de-la-sesion-web.md) (precisa el punto 7 y completa el 3)
- **Tema en el registro original:** Sesión web con cookie del servidor (revisa [D20](D020-login-y-registro.md) y TM-L13; precisa [D21](D021-ajustes-auth.md) y [D28](D028-implementacion-del-login-propio.md))

## Decisión

Diseño: `docs/specs/session-cookie.md`; modelo de amenazas: `docs/security/threat-models/session-cookie-threat-model.md`. Pedido del usuario: recargar el navegador ya no pide ingresar de nuevo.

**(1) Cookie de `mango-api`** `__Host-mango_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`: lleva un id de sesión aleatorio generado por el servidor y el refresh token de Cognito **cifrado con la llave de datos de KMS** (contexto de cifrado: id y `sub`). El servidor guarda solo el registro de la sesión (hash del id, `sub`, inicio, vencimiento) en la tabla `Mango-<ns>-WebSessions`: **ningún secreto en DynamoDB**. Se descartaron la cookie sin registro (cerrar una sesión dependería solo de Cognito) y el refresh token en DynamoDB (exigía una excepción a la regla de secretos).

**(2) La cookie solo renueva:** `POST /api/session` (crea, con access token y refresh token; comprueba contra Cognito que ambos son del mismo `sub`), `POST /api/session/refresh` (devuelve access e ID token) y `DELETE /api/session` (revoca en Cognito y borra). El resto de la API sigue validando access tokens de Cognito en `Authorization`, que siguen solo en memoria; la SPA deja de conservar el refresh token.

**(3) CSRF:** `SameSite=Strict`, cabecera propia obligatoria y comprobación de `Origin`; respuestas `no-store`; eventos `session.started`, `session.renewed` y `session.ended` en auditoría, sin tokens.

**(4) Decisiones del usuario:** la sesión dura **8 h** como máximo (antes 12 h; `SESSION_HOURS`, límite absoluto), la cookie **persiste al cerrar el navegador** hasta vencer y el **SSO federado** usa el mismo mecanismo.

**(5) MFA y revocación:** la cookie solo se crea con los tokens de un ingreso completo; deshabilitar a una persona, quitarle un grupo sensible y restablecer su MFA cierran también sus sesiones del servidor (marca por usuario además de `AdminUserGlobalSignOut`); el access token ya emitido vale hasta 60 minutos, como antes.

**(6) PoC:** el refresh token y la cookie pasan por el tramo HTTP interno CloudFront → ALB (excepción de [D15](D015-red-de-la-poc.md), ampliada en `AGENTS.md`).

**(7) Interfaz:** sin elementos nuevos; se usa el estado de carga existente. La casilla «Mantener la sesión en este equipo» y el aviso previo al vencimiento esperan a Claude Design (`docs/design/briefs/sync-2026-10-03i.md`).

**Sin verificar contra Cognito real:** el tamaño del refresh token (la cookie debe caber en 4096 bytes) y el margen del límite del WAF del user pool, ahora que las renovaciones salen de las IP de `mango-api`
