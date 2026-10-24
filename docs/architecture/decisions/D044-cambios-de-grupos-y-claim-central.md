# D44 · Cambios de grupos de acceso y claim de «central»

- **Estado:** vigente
- **Fecha:** 2026-10-01 · punto (9) el 2026-10-24
- **Precisa / reemplaza a:** en el texto: construye la doble aprobación de grupos de acceso de [D26](D026-reglas-del-ciclo-de-vida.md); su punto (9) precisa [D60](D060-gestion-de-personas.md) (10)
- **Precisada por:** —

## Decisión

**(1) Doble aprobación desde la app.** Crear un grupo de acceso, cambiarle el tipo o el área, o eliminarlo lo propone un administrador y lo aprueba otro distinto, desde Ajustes › Grupos ([D26](D026-reglas-del-ciclo-de-vida.md)). Quien propone no aprueba ni rechaza su propia solicitud; solo la retira. La descripción la edita un solo administrador. Cada cambio usa bloqueo optimista (una solicitud abierta por grupo, ligada a la versión del grupo) y auditoría fail-closed.

**(2) Nadie decide sobre un grupo al que pertenece.** Un administrador no propone, aprueba ni rechaza la creación o el cambio de tipo de un grupo del que es miembro; eliminarlo sí puede. Si todos los administradores pertenecen a un grupo, su tipo no se cambia desde la app.

**(3) Vencimiento.** Una solicitud que nadie aprueba en 72 h vence y deja de bloquear al grupo.

**(4) Nombres con significado fijo.** `mango-*` está reservado y nunca entra al registro. `finops-central` solo existe como central, `bu-lead` como general y `bu-<área>` como grupo de área de esa misma área, porque así los lee el pre-token; `finops-central` y `bu-lead` no se eliminan.

**(5) Un nombre en uso no se recrea.** No se crea un grupo con un nombre que un agente publicado, aprobado o en revisión todavía usa: sus miembros nuevos heredarían esos agentes sin revisión. Por la misma razón, un grupo central no deja de serlo mientras un agente lo use con tools de datos de cuentas.

**(6) Cognito al aplicar.** Aprobar una creación crea el grupo en el User Pool; si ya existía, se adopta y queda anotado en auditoría. Aprobar una eliminación lo borra. `mango-api` solo puede crear y borrar grupos de su User Pool; la pertenencia se gestiona en el directorio y no se muestra el número de miembros.

**(7) Claim `mango_central`.** El pre-token lo añade al access token y al ID token cuando el usuario pertenece a un grupo cuyo tipo en el registro es `central`. Lo calcula desde el registro en cada emisión, nunca desde atributos del usuario ni desde el cliente, y solo puede leer la partición `GROUPS` de `Settings`. **Fail-closed de privilegios:** si el registro no se puede leer, el token se emite sin el claim; el usuario entra, pero sin acceso a datos de cuentas hasta su siguiente token. Un cambio de tipo se refleja en el siguiente token (como máximo 60 minutos después).

**(8) Datos.** En `Settings`, `GROUPS/<id>` gana `version`, y hay dos particiones nuevas: `GROUP_CHANGE/<id de solicitud>` (la solicitud y su decisión) y `GROUP_LOCK/<id de grupo>` (la solicitud abierta). Van aparte para que el pre-token no las lea.

**(9) Eliminar un grupo de área que deja fuera a alguien** (2026-10-24, decisión del usuario por menú, ronda de diseño 18). Cierra lo que [D60](D060-gestion-de-personas.md) (10) dejaba fuera. Antes de proponer la eliminación de un `bu-<área>`, la pantalla pregunta a Personas a quién deja sin su única área (`POST /api/admin/people/only-area`: `ViewPeople`, límite y auditoría de una lectura del directorio, con conteos y nunca correos; responde los cinco primeros correos y cuántos son) y lo avisa. Al proponerla, `mango-api` cuenta otra vez a esas personas y lo guarda en la solicitud (`stranded_leads`), para que lo vea quien aprueba. Es un aviso, nunca un bloqueo: el grupo puede retirarse a propósito. Si el directorio no se puede leer, la propuesta sigue sin el dato. El conteo sale de la copia del directorio que ya usa Personas: Grupos sigue sin cambiar la pertenencia.

Amenaza: TM-M13
