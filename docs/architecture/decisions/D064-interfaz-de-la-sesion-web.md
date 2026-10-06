# D64 · Interfaz de la sesión web

- **Estado:** vigente
- **Fecha:** 2026-10-04
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
