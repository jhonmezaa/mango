# D58 · Distribución para clientes

- **Estado:** vigente
- **Fecha:** 2026-10-03
- **Precisa / reemplaza a:** precisa [D8](D008-distribucion.md); ajusta §4.9; precisa [D25](D025-recursos-creados-en-runtime.md), [D34](D034-guardrail-y-agentes-de-la-release.md), [D36](D036-artefacto-y-firma-de-packs.md), [D48](D048-desaprovisionamiento.md) y [D54](D054-egress-de-packs.md); retira las excepciones de laboratorio de [D14](D014-login-de-la-poc.md), [D20](D020-login-y-registro.md) y [D28](D028-implementacion-del-login-propio.md). En el texto: el punto (2) reemplaza quién ejecuta la actualización en [D9](D009-versionado-y-upgrades.md) y el parámetro `AlertsEmail` del punto (1) resuelve la suscripción pendiente de [D41](D041-alertas-y-reconciliacion.md)
- **Precisada por:** [D59](D059-repositorio-publico.md) (precisa el punto 4); [D60](D060-gestion-de-personas.md) (precisa); [D69](D069-assets-por-contenido-y-prefijo-unico.md) (precisa dónde van los assets y qué nombra la release; propuesta)
- **Tema en el registro original:** Distribución para clientes (precisa [D8](D008-distribucion.md); ajusta §4.9; precisa [D25](D025-recursos-creados-en-runtime.md), [D34](D034-guardrail-y-agentes-de-la-release.md), [D36](D036-artefacto-y-firma-de-packs.md), [D48](D048-desaprovisionamiento.md) y [D54](D054-egress-de-packs.md); retira las excepciones de laboratorio de [D14](D014-login-de-la-poc.md), [D20](D020-login-y-registro.md) y [D28](D028-implementacion-del-login-propio.md))

## Decisión

Diseño: `docs/specs/customer-distribution.md`; modelo de amenazas: `docs/security/threat-models/customer-distribution-threat-model.md`.

**(1) Parámetros mínimos + aplicación:** una plantilla para todos los clientes; `Core` pide 6 parámetros (`Namespace`, `OrganizationId`, `ManagementAccountId`, `FirstAdminEmail`, `AlertsEmail`, `SignUpDomains`); el resto son valores de la release o configuración de la app.

**(2) Como Innovation Sandbox:** plantillas en un bucket global y assets en buckets regionales de una **cuenta de AWS del proveedor, fuera de la organización del cliente**, con claves inmutables; publica GitHub Actions por OIDC; el cliente solo hace `CreateStack`/`UpdateStack` («Launch stack»). Se descartan el instalador con CodeBuild de bedrock-chat (contradice [D9](D009-versionado-y-upgrades.md), [D25](D025-recursos-creados-en-runtime.md) y las reglas 1 y 2) y la copia a un bucket del cliente como camino normal.

**(3) Lectura por organización del cliente** (`aws:PrincipalOrgID`) en los buckets y en el ECR privado del proveedor; imagen de `mango-api` por digest.

**(4) Firma con KMS en la cuenta del proveedor** (se mantiene [D36](D036-artefacto-y-firma-de-packs.md)): la llave y el rol de firma de packs se mudan allí desde la cuenta de gestión del laboratorio, con llave nueva; el manifiesto de la release se firma con la misma llave. Se descarta la firma sin llave (Sigstore publica metadatos del repo en un registro público; las attestations de GitHub exigen Enterprise Cloud en repos privados).

**(5) Solo `installationType: customer`:** el laboratorio se instala como un cliente (MFA obligatorio, Cognito Plus, sin dominios públicos).

**(6) Sin modo dual del synthesizer:** no hay `cdk deploy` de desarrollo.

**(7) Datos siempre `RETAIN`**, con un script de purga para borrar lo retenido.

**(8) Red de packs en un stack propio** `Mango-<ns>-PackNetwork`, que `Core` importa, para que `Core` se borre aunque AgentCore retenga las ENI.

**(9) `UninstallGuard`:** `Core` borra agentes y packs creados por API al borrarse, y solo entonces; retirar el agente de la release borra su harness y su rol.

**(10)** Objetivos de `OrgAccess` repetidos como parámetro de `Core`; `SecondAdminEmail` opcional hasta que la app gestione personas; presupuestos por defecto de la release USD 5 por usuario y USD 30 por agente.

**(11) Precisión tras la primera batería e2e sobre una instalación de cliente (2026-10-03):** las plantillas solo llevan ASCII en lo que viaja dentro de un StackSet (CloudFormation guarda cualquier otro carácter como `?` y el hash publicado de la plantilla miembro dejaría de coincidir; lo impide un test); las pruebas e2e y la evaluación FinOps no llevan valores de ninguna instalación: leen los outputs de `Core`, los parámetros de `OrgAccess` y las áreas de la propia aplicación
