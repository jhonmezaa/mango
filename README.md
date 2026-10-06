# Mango Hub

Plataforma de orquestación de agentes de IA para empresas, construida sobre AWS.

Se instala en la cuenta AWS de cada cliente y opera sobre las cuentas de su AWS Organization. Ofrece un marketplace de agentes con chat, bajo gobernanza: permisos por rol, presupuestos, aprobaciones de una persona antes de cada acción de escritura y registro de auditoría.

## Estado

En desarrollo. Es una prueba de concepto, sin soporte.

## Instalar

Se instala con CloudFormation sobre las plantillas de una versión publicada, sin compilar nada: [`docs/runbooks/install.md`](docs/runbooks/install.md). El mismo documento explica cómo actualizar y desinstalar.

Las versiones se publican en una cuenta de AWS del proveedor y solo las pueden leer las organizaciones que el proveedor autoriza: tener el código no basta para instalar.

## Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Arquitectura, estado de lo construido e índice de decisiones | [`docs/architecture/reference-architecture.md`](docs/architecture/reference-architecture.md) |
| Decisiones, una por archivo | [`docs/architecture/decisions/`](docs/architecture/decisions/README.md) |
| Instalar, actualizar y desinstalar | [`docs/runbooks/install.md`](docs/runbooks/install.md) |
| Operar una instalación: alarmas y tablero | [`docs/runbooks/operations.md`](docs/runbooks/operations.md) |
| Cómo se publican las versiones | [`deployment/provider/README.md`](deployment/provider/README.md) |
| Operación y pruebas de punta a punta del laboratorio | Vigente: [`docs/runbooks/install.md`](docs/runbooks/install.md). Anterior a D58 y obsoleto en parte: [`docs/runbooks/poc-deploy.md`](docs/runbooks/poc-deploy.md) |
| Especificaciones y hoja de ruta | [`docs/specs/`](docs/specs/) |
| Modelos de amenazas | [`docs/security/threat-models/`](docs/security/threat-models/) |
| MCP packs (formato, pipeline y firma) | [`packs/README.md`](packs/README.md) |
| Reglas para trabajar en el repo | [`AGENTS.md`](AGENTS.md) |

## Seguridad

Para reportar una vulnerabilidad, ver [`SECURITY.md`](SECURITY.md).

## Licencia

Software propietario, todos los derechos reservados. No se permite usarlo, copiarlo, modificarlo ni distribuirlo sin autorización escrita. Ver [`LICENSE`](LICENSE).

El material de terceros y sus licencias están en [`NOTICE`](NOTICE).
