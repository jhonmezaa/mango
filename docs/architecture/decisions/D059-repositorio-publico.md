# D59 · Repositorio público

- **Estado:** vigente
- **Fecha:** 2026-10-03 · punto (6) del 2026-10-05
- **Precisa / reemplaza a:** precisa [D58](D058-distribucion-para-clientes.md) (4)
- **Precisada por:** —
- **Tema en el registro original:** Repositorio público (precisa [D58](D058-distribucion-para-clientes.md) (4))

## Decisión

**(1) Repositorio nuevo y público, `mango`, con historial limpio:** un único commit inicial con el árbol ya revisado. El repositorio privado anterior se renombra a `mango-old`, queda como archivo y no recibe más cambios. El nombre no hereda nada: el repositorio nuevo tiene otro identificador numérico. **Motivo:** el plan gratuito de GitHub da 2.000 minutos de Actions al mes a un repositorio privado y el CI los agotó en tres días; en uno público son gratuitos. La auditoría previa (2026-10-03) no encontró secretos en el árbol, el historial, los PR ni los logs, pero sí datos que ninguna limpieza del árbol quita: un correo personal como autor de commits, el id de una cuenta del laboratorio en un commit y en logs de Actions, y todo el historial bajo MIT. Reescribir el historial en el mismo repositorio no los elimina (GitHub conserva las referencias de los PR y los logs).

**(2) Licencia propietaria**, todos los derechos reservados (`LICENSE`): publicar el código no concede permiso de uso, copia, modificación ni distribución. El material de terceros y sus licencias van en `NOTICE`.

**(3) Sin líneas de atribución en los commits** (`Co-Authored-By`, enlaces de sesión): autor y committer son el titular, con el correo `noreply` de GitHub.

**(4) Los documentos internos se publican todos:** arquitectura y decisiones, modelos de amenazas y revisiones, especificaciones y hoja de ruta, copia del diseño y briefs. Ningún archivo versionado lleva ids reales de cuentas, organizaciones, OUs, user pools ni dominios, ni correos de personas: solo valores de ejemplo.

**(5) Firma:** se mantiene la llave de KMS de la cuenta del proveedor ([D36](D036-artefacto-y-firma-de-packs.md), [D58](D058-distribucion-para-clientes.md) (4)); el trust de los roles de firma y de publicación pasa al `sub` inmutable del repositorio nuevo y deja de aceptar el anterior. Con el repositorio público, `main` se protege (PR, revisión de los dueños, checks de CI) y los entornos de firma y publicación llevan revisor obligatorio (`packs/README.md`). Las attestations de GitHub vuelven a estar disponibles; adoptarlas sería otra decisión.

**(6) Los workflows leen de secretos de entorno todo valor con id de cuenta, ARN o nombre de bucket (2026-10-05):** los logs y los artefactos de Actions de un repositorio público los lee cualquiera, y Actions imprime las variables del repositorio; solo enmascara secretos. Los logs de `packs` mostraban el ARN del rol de firma y el de la llave. Desde ahora: el rol de firma es un secreto del entorno `pack-signing`; el rol de publicación, el bucket y la cuenta, del entorno `release`; la action de credenciales enmascara además el id de cuenta. La llave de firma de packs se nombra por su alias (`alias/mango-provider-signing`), porque el sobre guarda el id de la llave (`key_id`, informativo: el verificador no lo usa) y se sube como artefacto. Un `if:` de job no puede leer secretos: los jobs se activan con las variables `PACK_SIGNING_ENABLED` y `RELEASE_ENABLED`, que no llevan datos. Un test falla si un workflow lee de `vars` un nombre terminado en `_ARN`, `_BUCKET` o `_ACCOUNT_ID`, si un job usa secretos sin declarar su entorno o si los usa en `if:` o `name:` (`deployment/pack-builder/tests/test_workflows.py`)
