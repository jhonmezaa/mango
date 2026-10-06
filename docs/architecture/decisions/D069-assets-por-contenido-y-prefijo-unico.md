# D69 · Una actualización toca solo lo que cambió: assets por contenido bajo un prefijo único, sin etiqueta en las descripciones e imagen reproducible

- **Estado:** vigente
- **Fecha:** 2026-10-05 (propuesta por un agente y aceptada por el dueño el mismo día)
- **Precisa / reemplaza a:** precisa [D58](D058-distribucion-para-clientes.md) y [D8](D008-distribucion.md)
- **Precisada por:** —

## Decisión

Origen: la revisión del proyecto del 2026-10-05 (infraestructura, H2 a H5). El usuario eligió ese día el «lote de orden», que incluye «actualizaciones que tocan solo lo que cambió». Detalle y mediciones: `docs/specs/customer-distribution.md` §13. Amenazas: TM-D20 a TM-D22.

**(1) El nombre de un asset sale de su contenido.** El de una Lambda Python es el hash de su bundle (`assetHashType: OUTPUT`), no el de su directorio fuente. El bundle es el mismo en cualquier checkout del mismo commit, y el zip que se publica depende solo de las rutas y los contenidos de sus archivos. Mismo nombre, mismos bytes.

**(2) Los assets de todas las releases comparten un prefijo:** `mango/assets/<hash>.zip` en el bucket regional. Las plantillas, el manifiesto y su firma siguen bajo la etiqueta (`mango/<etiqueta>/`). Un archivo que no cambió conserva su clave, y CloudFormation no toca el recurso que lo lee.

**(3) Una clave que ya existe se compara, nunca se supone.** Al publicar, `dist.py` sube cada asset con `If-None-Match` y su sha256; si la clave existe, compara el sha256 publicado con el construido y, si difiere, termina la release sin subir plantillas ni manifiesto. Para eso el rol de publicación lee `mango/assets/*` del bucket regional (`s3:GetObject`; aprobado por el usuario el 2026-10-05) y nada más del almacén. El manifiesto firmado sigue nombrando el sha256 de cada asset: la garantía de integridad no baja.

**(4) Ninguna descripción de stack nombra la release.** CloudFormation no acepta un cambio solo de descripción, así que un stack que la release no cambió no podía mostrar la etiqueta nueva. Qué release corre un stack lo dice el sha256 de su plantilla en el manifiesto firmado; `Core` además muestra la etiqueta en Ajustes › Instalación.

**(5) La imagen de `mango-api` es reproducible:** bases por digest y fecha fija. Se construye en cada release y no se toma del registro por un tag derivado de sus entradas: lo que una release nombra es lo que esa ejecución construyó. Si nada cambió, el digest es el mismo.

**(6) Lo que no cambia:** la task definition lleva la etiqueta (`MANGO_RELEASE`) y cambia en cada release: un despliegue rodante de la API por actualización. La primera release después de esta decisión mueve todas las claves una última vez.
