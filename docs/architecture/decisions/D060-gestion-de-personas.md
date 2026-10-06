# D60 · Gestión de personas en la aplicación

- **Estado:** parcial. Construida. Falta su punto (9): el evento «Persona registrada» (`directory.signup`) y la alarma sobre `AdminAddUserToGroup` (TM-P11).
- **Fecha:** 2026-10-03 · punto (9) revisado el 2026-10-04
- **Precisa / reemplaza a:** precisa [D14](D014-login-de-la-poc.md), [D20](D020-login-y-registro.md), [D26](D026-reglas-del-ciclo-de-vida.md), [D28](D028-implementacion-del-login-propio.md) y [D58](D058-distribucion-para-clientes.md)
- **Precisada por:** [D61](D061-invitaciones-mfa-y-etiqueta.md) (precisa los puntos 6, 7 y 8); [D62](D062-proveedores-de-correo-publico.md) (precisa); [D66](D066-cambios-de-personas-fuera-del-directorio.md) (precisa el punto 5)
- **Tema en el registro original:** Gestión de personas en la aplicación (precisa [D14](D014-login-de-la-poc.md), [D20](D020-login-y-registro.md), [D26](D026-reglas-del-ciclo-de-vida.md), [D28](D028-implementacion-del-login-propio.md) y [D58](D058-distribucion-para-clientes.md))

## Decisión

Modelo de amenazas: `docs/security/threat-models/people-management-threat-model.md`.

**(1) Ajustes › Personas** (solo administradores): el directorio (correo, estado, MFA, grupos, alta), asignar y quitar grupos, invitar (contraseña temporal por correo de Cognito; MFA en el primer ingreso), deshabilitar y rehabilitar. No se borran personas ni se cambia su correo o contraseña. Restablecer MFA ([D20](D020-login-y-registro.md)) se pide desde la persona.

**(2) Doble aprobación (otro administrador, 72 h) solo para lo sensible:** dar o quitar `mango-admin` o `finops-central`, deshabilitar a un administrador y rehabilitar a quien tenga uno de esos dos grupos. El resto de los grupos se aplica al momento y queda en auditoría (decisión del usuario: tal cual el diseño; se acepta que un grupo propio de tipo `central` se asigne sin aprobación, TM-P2). Lo decide `mango-api`, nunca el cliente.

**(3) Reglas:** nadie decide un cambio sensible sobre su propia cuenta, ni se quita él solo un grupo sensible, ni se deshabilita (pedir uno para sí mismo es una propuesta que aprueba otro administrador); la aplicación nunca deja menos de dos administradores habilitados; al aprobar se vuelven a comprobar todas las reglas; al quitar un grupo sensible o deshabilitar se revocan los refresh tokens (el access token vigente dura hasta 60 minutos).

**(4) Arranque:** mientras quien llama sea el único administrador habilitado, nombrar al segundo (agregarlo a `mango-admin` o invitarlo con ese grupo) se aplica sin segundo aprobador y el evento lleva `bootstrap`.

**(5) Excepción a «sin revelar si un usuario existe»:** los administradores listan el directorio y la invitación dice si el correo ya existe (registrada en `AGENTS.md`); lecturas con límite de tasa y auditadas con conteos, sin correos.

**(6) Invitaciones:** `mango-api` valida el correo (`AdminCreateUser` no pasa por el trigger *pre sign-up*); qué dominios acepta lo precisa [D61](D061-invitaciones-mfa-y-etiqueta.md); los grupos sensibles no se aceptan en la invitación salvo el arranque.

**(7) IAM:** el rol de `mango-api` suma `ListUsersInGroup`, `AdminListGroupsForUser`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminCreateUser`, `AdminDisableUser` y `AdminEnableUser`, solo sobre el user pool. Cognito no acota por grupo: qué grupo se puede dar lo valida `mango-api` (los cuatro de sistema y los del registro). Sin supresiones nuevas.

**(8) Datos de la instalación** (versión, organización, cuenta de gestión, correo de alertas, dominios, administradores iniciales): solo lectura, por `GET /api/admin/installation` para administradores; no van en el `config.json` público.

**(9) Pendiente:** el evento «Persona registrada» (`directory.signup`) exige un trigger *post confirmation* nuevo (revisado el 2026-10-04: ningún evento actual registra el alta de quien se registra solo; `directory.invite` cubre solo las invitaciones, el trigger *pre sign-up* no audita y no hay *post confirmation*. El usuario decidió no construir todavía esa Lambda; la pantalla ya tiene la etiqueta y la persona se ve en Personas como «Sin acceso», TM-P12); una alarma sobre `AdminAddUserToGroup` a `mango-admin` en CloudTrail (TM-P11).
