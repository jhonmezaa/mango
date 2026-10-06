# D64 · Interfaz de la sesión web

- **Estado:** vigente
- **Fecha:** 2026-10-04 · punto (6) del 2026-10-06
- **Precisa / reemplaza a:** precisa [D63](D063-sesion-web-con-cookie.md), punto 7; en el texto: completa su punto 3 y precisa «ningún secreto en DynamoDB»
- **Precisada por:** —
- **Tema en el registro original:** Interfaz de la sesión web (precisa [D63](D063-sesion-web-con-cookie.md), punto 7)

## Decisión

Origen: la ronda de Claude Design del 2026-10-04 respondió el brief de la sesión.

**(1) «Sesión recuperada» es una lectura:** `session.renewed` entra en `READ_EVENTS` de `mango_api.audit` y se oculta con `exclude=reads`, igual que `directory.list` ([D62](D062-proveedores-de-correo-publico.md)); cada carga de página deja uno y tapaba los cambios. Se sigue auditando y se ve con «Mostrar lecturas»; `session.started`, `session.ended` y `session.rejected` se ven siempre. La detección de TM-S1 (ritmo anómalo de renovaciones) se hace con las lecturas a la vista o sobre el registro, no en la vista por defecto.

**(2) Sin «Mantener la sesión en este equipo»:** la sesión se conserva para todos; bajo «Entrar» va una ayuda con la duración.

**(3) Aviso 10 minutos antes de vencer**, sin «Extender» (la duración es un máximo). La SPA calcula el vencimiento con la misma regla del servidor (`auth_time` del access token más `sessionHours` de `config.json`); es solo para mostrar el aviso: quien cierra la sesión es `mango-api`.

**(4) Al abrir la aplicación** se muestra el armazón del inicio de sesión con «Recuperando tu sesión…», y al cerrar sesión en otra pestaña, un aviso en el inicio de sesión.

**(5) Motivo y persona en «Sesión cerrada» (2026-10-04, completa el punto 3 de [D63](D063-sesion-web-con-cookie.md)):** la marca de revocación guarda su causa y `session.ended` la repite como motivo: `disabled`, `group_removed` o `mfa_reset`, los nombres del diseño; el cierre por la persona sigue siendo `sign_out` y el vencimiento `expired`. Queda `revoked` solo para marcas sin causa (las escritas antes de este cambio, que viven dos días) y `rejected` cuando Cognito rechaza renovar sin que haya marca: no se inventa una causa que no se conoce. Hay una marca por persona; si dos cambios coinciden antes de que la sesión vuelva, se nombra el más reciente. `session.ended` se emite sin token, así que el registro de la sesión guarda el correo, el rol y si es admin de quien ingresó, tal como los dijo el token verificado al ingresar, y el evento los lleva como actor. Precisa «ningún secreto en DynamoDB» de [D63](D063-sesion-web-con-cookie.md): sigue sin haber secretos; el correo es un dato personal que ya está en el índice de auditoría, se borra con el registro (TTL) y nunca va a logs

**(6) Una renovación que no responde no cierra la sesión (2026-10-06, pedido por el usuario al ver el defecto):** solo una respuesta que lo diga lleva al inicio de sesión: el `204` de `POST /api/session/refresh` (no hay sesión, venció o se revocó) o un `401` de la API. Un 5xx, un 429, un fallo de red o una respuesta que no se entiende no dicen nada de la sesión, y la SPA la conserva. Con sesión abierta, la petición que necesitaba el token nuevo falla con el error que su pantalla ya tiene (en el chat, «Ocurrió un error inesperado. Inténtalo de nuevo.» con «Reintentar») y el siguiente intento vuelve a pedir la renovación. Al abrir o recargar la aplicación, la SPA pregunta tres veces más (a 1, 2 y 4 s) detrás de «Recuperando tu sesión…» y después muestra ese mismo error genérico con «Reintentar», nunca el formulario de ingreso; un 429 no se reintenta solo. Una pestaña con la renovación caída no avisa a las demás ni toca la cookie. Antes, la SPA trataba la falta de respuesta como «sin sesión»: decía «Tu sesión expiró» o mostraba el formulario. No hay textos ni estados nuevos (D24); los propios de este caso esperan a la próxima ronda de Claude Design.
