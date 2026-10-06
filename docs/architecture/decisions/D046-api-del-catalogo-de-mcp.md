# D46 · API del catálogo de MCP: quién decide, qué lee `mango-api` y qué pasa con los agentes

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** en el texto: amplía [D43](D043-provisioner-de-packs.md) (punto 3)
- **Precisada por:** —

## Decisión

**(1) Un agente sigue sirviendo sin las tools de un pack deshabilitado.** Cuando un pack deja de estar instalado (o su versión instalada ya no sirve una tool), `mango-api` arma la invocación solo con las tools que siguen instaladas: siempre menos de lo aprobado, nunca más. El agente no queda fuera de servicio. Si el pack se vuelve a habilitar (con doble aprobación), el agente recupera esas tools sin una nueva revisión del agente. Una tool de un servidor que la release no trae, o un estado de packs que no se puede leer, sigue dejando al agente no disponible (falla cerrado).

**(2) La API de agentes dice qué tools faltan.** `Agent.unavailable_tools` lista las tools de la versión publicada que su pack no sirve ahora; la marca en el Marketplace y el Builder llega con las pantallas.

**(3) `mango-api` lee el bucket de packs (amplía [D43](D043-provisioner-de-packs.md)).** Hasta ahora solo lo leía el provisioner de packs. `mango-api` lee **solo las declaraciones firmadas** de los packs que nombra la release (`s3:GetObject` sobre los objetos exactos; sin zips, sin listar, sin comodín) y las verifica con la misma llave pública y el mismo catálogo por digest que el provisioner. Una declaración ausente, de otra llave, alterada o que no es la de la release deja al pack fuera del catálogo. Así quien aprueba ve el manifiesto que se va a instalar.

**(4) Una sola familia de rutas para decidir.** Habilitar (`POST /api/mcp/{pack}/enablements`), cambiar parámetros (`…/params`) y actualizar (`…/update`) crean el mismo tipo de solicitud, una pendiente por pack; las tres se aprueban, rechazan o retiran en `…/enablements/{id}/approve`, `reject` y `withdraw`. Retirar (solo quien pidió) se añade a lo que decía el spec §7. Reintentar y deshabilitar (con motivo) los hace un solo administrador, como dice el spec §4.4.

**(5) Límites.** Máximo de 10 packs habilitados o instalándose (TM-M9), 10 escrituras por minuto por administrador, una solicitud vigente 7 días, y una aprobación cuya ejecución no arrancó se muestra como error a los 2 minutos para reintentarla.

**(6) Motivo del rechazo.** Obligatorio para rechazar una habilitación o una actualización; opcional para un cambio de parámetros, como en el diseño.

**(7) Datos de las solicitudes.** Partición `MCP_CHANGE#<pack>` de `Settings`, con un ítem por solicitud (`CHANGE#<id>`, 90 días) y un marcador `PENDING` que se crea y se borra en la misma transacción que la solicitud: garantiza una sola pendiente por pack sin `Scan`. Sustituye al `MCP_CHANGE#<id>` del spec §8. El provisioner de packs no puede leer esa partición. Además, el provisioner de agentes lee el puntero `MCP_INSTALLED#<pack>` (`dynamodb:GetItem`, solo lectura) para aceptar las tools de un pack instalado, con el target del Gateway igual al id del pack.

Contrato: `docs/specs/poc-api-contract.md`.

Modelo de amenazas: `docs/security/threat-models/mcp-pack-provisioner-threat-model.md` v0.2 (TM-B14 a TM-B20)
