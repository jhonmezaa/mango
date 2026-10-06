# D21 · Ajustes › Auth

- **Estado:** parcial. Construido el solo lectura. Falta editar MFA, duración de sesión e IdP desde la app con doble aprobación ([D28](D028-implementacion-del-login-propio.md): «sigue en Próximamente»).
- **Fecha:** 2026-09-30
- **Precisa / reemplaza a:** —
- **Precisada por:** [D63](D063-sesion-web-con-cookie.md) (precisa)

## Decisión

User Pool, región y app client se muestran **en solo lectura**.

**MFA, duración de sesión e IdP** se editan desde la app con **doble aprobación** (propone un admin, aprueba otro) y auditoría fail-closed; en instalaciones de clientes MFA solo puede ser "Obligatorio" (ni "Opcional" ni desactivado). El stack solo siembra esos valores y deja de gestionarlos, para que un `UpdateStack` no revierta lo configurado. Webhooks, keys de terceros y la "zona peligrosa" (redeploy, borrar la organización) no están en la app
