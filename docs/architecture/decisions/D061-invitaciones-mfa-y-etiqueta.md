# D61 · Invitaciones a otros dominios, MFA en el directorio y etiqueta de la versión

- **Estado:** vigente
- **Fecha:** 2026-10-03
- **Precisa / reemplaza a:** precisa [D60](D060-gestion-de-personas.md) (6), (7) y (8)
- **Precisada por:** [D62](D062-proveedores-de-correo-publico.md) (precisa)
- **Tema en el registro original:** Invitaciones a otros dominios, MFA en el directorio y etiqueta de la versión (precisa [D60](D060-gestion-de-personas.md) (6), (7) y (8))

## Decisión

**(1) Una invitación acepta cualquier dominio que no sea de un proveedor de correo público** (decisión del usuario): un administrador puede invitar a alguien de otra empresa (un consultor, un proveedor) aunque su dominio no esté en `SignUpDomains`. Los proveedores públicos (`gmail.com` y los demás de la lista del trigger *pre sign-up*) se rechazan siempre. **El registro abierto no cambia:** solo se registran solos los correos de `SignUpDomains`. Controles (TM-P7 y TM-P17 de `people-management-threat-model.md`): solo administradores, con límite de tasa; el evento `directory.invite` lleva `external_domain` cuando el dominio no es de la instalación; la persona aparece en el directorio con su correo completo, a la vista de todos los administradores; `mango-admin` y `finops-central` no se aceptan en la invitación (se piden después, con doble aprobación), salvo el arranque de [D60](D060-gestion-de-personas.md) (4); sin grupos, la persona entra y no ve nada.

**(2) Una invitación rechazada queda en Auditoría** (`directory.invite`, `rejected`, con el código). Si el correo no pasó la validación (formato o proveedor público) se registra solo su dominio, nunca lo que se escribió: no es una persona del directorio.

**(3) MFA en Personas:** Cognito no lista en `UserMFASettingList` un TOTP registrado por el reto `MFA_SETUP` (la única vía de la SPA, porque el access token no lleva el scope de autoservicio) hasta que se fija una preferencia, y ninguna API lee «tiene un TOTP verificado». `mango-api` lo resuelve con `AdminSetUserMFAPreference` (activar TOTP): Cognito solo lo acepta si la persona tiene un TOTP verificado, no cambia cómo entra y desde entonces la lista lo dice. Restablecer MFA (`AdminDeleteSoftwareToken`) vacía la lista. Comprobado en el laboratorio. El rol de `mango-api` suma esa acción, solo sobre el user pool; el código nunca desactiva un factor y, con MFA obligatorio, una preferencia no apaga el reto (hallazgo del 2026-09-30). Sin supresiones nuevas.

**(4) «Instalación» muestra la etiqueta de la release** («Publicación `v0.1.0-g<commit>`») junto a la versión: `mango-api` la recibe en `MANGO_RELEASE` desde la plantilla y la sirve en `GET /api/admin/installation` (`release`). Dos builds de una misma versión se distinguen.
