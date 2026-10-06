# D54 · Egress restringido de los Runtimes de packs (R6)

- **Estado:** vigente
- **Fecha:** 2026-10-02
- **Precisa / reemplaza a:** construye R6 ([D11](D011-requisitos-de-seguridad.md)) para los Runtimes de packs; retira [D49](D049-identidad-en-packs-de-datos.md) (7)
- **Precisada por:** [D58](D058-distribucion-para-clientes.md) (precisa: red de packs en un stack propio); [D71](D071-alarmas-operativas-y-tablero.md) (precisa el punto 3: lista del DNS Firewall para lo que pide la plataforma y registro de consultas fijo)
- **Tema en el registro original:** Egress restringido de los Runtimes de packs (R6; retira [D49](D049-identidad-en-packs-de-datos.md) (7))

## Decisión

(1) Los Runtimes de packs corren en modo `VPC` en una VPC propia (`Mango-<ns>-PackVpc`) sin internet gateway ni NAT, separada de la de `mango-api` ([D15](D015-red-de-la-poc.md) no cambia).

(2) El manifiesto firmado declara `egress`: `aws` (lista cerrada de servicios) y `hosts` (hosts externos; el campo existe, pero un pack que declare alguno no se sintetiza ni se instala hasta que haya un control que los aplique).

(3) La plantilla crea, a partir de los manifiestos firmados de la release, un endpoint de interfaz por servicio declarado (más CloudWatch Logs y el gateway de S3), un security group por pack que solo alcanza sus endpoints, políticas de endpoint limitadas a la organización y un DNS Firewall con allowlist. Todo estático ([D25](D025-recursos-creados-en-runtime.md)).

(4) El rol del provisioner solo puede crear o actualizar un Runtime con subnets y security groups de esa red.

(5) Dos zonas como mínimo en toda instalación, también en el laboratorio (usuario, 2026-10-02).

(6) Los packs solo leen la región de la instalación; `aws-cloudwatch` rechaza otra (usuario, 2026-10-02); otras regiones exigirán una red de packs por región.

(7) Se retira el bloqueo de [D49](D049-identidad-en-packs-de-datos.md) (7).

Control elegido por el usuario (2026-10-02) frente a proxy de egress y Network Firewall: endpoints de VPC.

Costo: ~USD 7,30 al mes por endpoint y zona (~USD 117 al mes con los tres packs).

Verificado en el laboratorio: los tres packs en `networkMode: VPC`, sus llamadas a STS registradas en CloudTrail con `vpcEndpointId`.

Riesgos aceptados: principals de otras cuentas de la misma organización pasan la política de endpoint; canal encubierto de bajo ancho de banda con credenciales ajenas, sin validar (TM-E11).

Modelo de amenazas: `docs/security/threat-models/pack-egress-threat-model.md`
