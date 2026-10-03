# Política de seguridad

## Cómo reportar una vulnerabilidad

Usa el **reporte privado de vulnerabilidades de GitHub**: en la pestaña **Security** de este repositorio, **Report a vulnerability**.

- No abras un issue ni un pull request público con los detalles.
- Incluye qué componente afecta, cómo reproducirlo y qué impacto tiene.
- No incluyas secretos, credenciales ni datos de cuentas reales.

El reporte solo lo ven los mantenedores. Se responde por ese mismo canal.

## Alcance

El código, las plantillas de infraestructura y el pipeline de MCP packs de este repositorio. Solo se corrige la rama `main`.

Quedan fuera las instalaciones de terceros y los servicios de AWS: sus vulnerabilidades se reportan a quien los opera.

## Referencias

Los modelos de amenazas de cada componente están en [`docs/security/threat-models/`](docs/security/threat-models/).
