# D19 · Catálogo de MCP

- **Estado:** parcial. Construidas las formas (1) y (2). Falta la (3): MCP remotos del cliente.
- **Fecha:** 2026-09-29 · ajuste del 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** [D36](D036-artefacto-y-firma-de-packs.md) (ajusta: zip en lugar de imagen)

## Decisión

Los MCP entran de tres formas:

(1) **conectores de Mango**, que vienen en la release;

(2) **MCP packs** curados: servidores de terceros (p. ej. awslabs, que se distribuyen para `uvx`/stdio) que el CI de Mango fija por versión y hash, con **cuarentena de 7 días** antes de adoptar una versión upstream nueva (salvo parches de seguridad, que se adoptan tras el escaneo), empaqueta en un zip con un punto de entrada propio que lo sirve por HTTP, escanea (SBOM, pip-audit), firma y publica por hash con un **manifiesto** (acciones IAM exactas, tools con lectura/escritura, nivel de datos y modo de identidad); en la instalación se habilitan desde la app con **doble aprobación** y el provisioner crea el rol (con permissions boundary), el AgentCore Runtime y el target del Gateway; sus tools quedan **denegadas por defecto**;

(3) **MCP remotos del cliente** (hospedados por él, con OAuth vía AgentCore Identity), en **v1.x**.

**Nunca** se instalan paquetes arbitrarios (`uvx`/pip) en la cuenta del cliente. Por nivel de datos: packs de datos públicos (Pricing, Documentation) sin restricción; packs sobre datos de cuentas (CloudWatch, Billing) **solo para roles centrales** vía Cedar, porque no filtran por usuario, salvo que se valide un adaptador de identidad por llamada; tools de escritura siempre con aprobación. Un cambio en las tools o descripciones de un pack exige reaprobación.

**Ajuste (2026-10-01, [D36](D036-artefacto-y-firma-de-packs.md)):** el texto original decía «envuelve en una imagen con transporte HTTP» y «publica por digest»; pasa a zip con despliegue directo de código, y la imagen por digest queda como alternativa
