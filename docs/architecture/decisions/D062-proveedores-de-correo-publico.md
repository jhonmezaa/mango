# D62 · Una sola lista de proveedores de correo público; el servidor decide y audita

- **Estado:** vigente
- **Fecha:** 2026-10-03
- **Precisa / reemplaza a:** precisa [D28](D028-implementacion-del-login-propio.md), [D60](D060-gestion-de-personas.md) y [D61](D061-invitaciones-mfa-y-etiqueta.md)
- **Precisada por:** [D66](D066-cambios-de-personas-fuera-del-directorio.md) (precisa el punto 6); [D67](D067-lecturas-del-directorio-en-auditoria.md) (precisa)
- **Tema en el registro original:** Una sola lista de proveedores de correo público; el servidor decide y audita (precisa [D28](D028-implementacion-del-login-propio.md), [D60](D060-gestion-de-personas.md) y [D61](D061-invitaciones-mfa-y-etiqueta.md))

## Decisión

Origen: la prueba de Personas en un navegador real aceptó una invitación a `…@outlook.es`, porque la lista era de 16 dominios exactos y estaba copiada en cuatro sitios.

**(1) Una sola fuente:** `mango_core.mail_domains` (datos en `public_mail_domains.json`, dentro de `mango-core`). La usan la invitación (`mango-api`), el trigger *pre sign-up* (que ahora depende de `mango-core` y solo importa ese módulo, de biblioteca estándar) y el esquema de parámetros de infra, que lee el mismo archivo.

**(2) Regla:** un dominio es público si él o un dominio que lo contiene es (a) una **familia** de proveedor como nombre registrado (`<marca>.<tld>` o `<marca>.<segundo nivel>.<país>`: `outlook.es`, `yahoo.co.uk`, `live.com.mx`) o (b) un dominio exacto de la lista (proveedores, buzones de operadoras, correos desechables, relevos de alias). Un subdominio de empresa que solo empieza por una marca (`outlook.empresa.com`) no lo es.

**(3) El servidor es la autoridad:** la pantalla ya no guarda una lista ni rechaza por su cuenta un correo público; lo envía y muestra la respuesta de la API, así el rechazo queda en Auditoría (`directory.invite`, `rejected`, `public_domain`, con el dominio). La pantalla solo valida vacío y formato.

**(4) Riesgo residual (TM-P19):** una lista cerrada no puede ser completa; baja la probabilidad de un descuido, no prueba que un correo sea de empresa. Queda recomendado, sin construir, una lista por instalación.

**(5) Auditoría:** `directory.list` cuenta como lectura (se oculta con «Mostrar lecturas» apagado, TM-P20) y una decisión permitida que no es lectura se muestra como «Acceso permitido» con el nombre de la acción en español.

**(6) Directorio:** una persona borrada en Cognito por fuera de Mango que todavía está en la copia en memoria del directorio (30 s) se omite de la lista en vez de responder 502.
