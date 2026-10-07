# D58 · Distribución para clientes

- **Estado:** vigente
- **Fecha:** 2026-10-03 (la purga tras la primera desinstalación, decidido por el dueño el 2026-10-07, punto 12)
- **Precisa / reemplaza a:** precisa [D8](D008-distribucion.md); ajusta §4.9; precisa [D25](D025-recursos-creados-en-runtime.md), [D34](D034-guardrail-y-agentes-de-la-release.md), [D36](D036-artefacto-y-firma-de-packs.md), [D48](D048-desaprovisionamiento.md) y [D54](D054-egress-de-packs.md); retira las excepciones de laboratorio de [D14](D014-login-de-la-poc.md), [D20](D020-login-y-registro.md) y [D28](D028-implementacion-del-login-propio.md). En el texto: el punto (2) reemplaza quién ejecuta la actualización en [D9](D009-versionado-y-upgrades.md) y el parámetro `AlertsEmail` del punto (1) resuelve la suscripción pendiente de [D41](D041-alertas-y-reconciliacion.md)
- **Precisada por:** [D59](D059-repositorio-publico.md) (precisa el punto 4); [D60](D060-gestion-de-personas.md) (precisa); [D69](D069-assets-por-contenido-y-prefijo-unico.md) (precisa dónde van los assets y qué nombra la release)
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

**(12) La purga, tras la primera desinstalación de una instalación (2026-10-07).** `deployment/purge-retained.sh` encuentra las llaves KMS retenidas por la etiqueta `mango:namespace` de la instalación, no por alias; solo pide saltar la retención al vaciar un bucket que tiene Object Lock; con `--confirm` termina con error, nombrando lo que quedó, si algo de lo que listó no se pudo borrar; y no lista ni borra nada hasta saber que los dos stacks de la cuenta de Mango, `Core` y `PackNetwork`, ya no existen. Precisa el punto (7).

- **Qué se vio (2026-10-07, una instalación de laboratorio en una cuenta nueva).** Era la primera vez que el guion se corría con `--confirm`. Borró las 8 tablas, el directorio de usuarios, el bucket de auditoría y los 27 log groups. Dejó 3 de los 4 buckets (los dos de logs de acceso y el de packs): pasaba `--bypass-governance-retention` a todos, S3 lo rechaza donde no hay Object Lock y el guion tomó ese rechazo por una retención `COMPLIANCE`. No encontró ninguna de las 7 llaves activas (6 de `Core`, 1 de `PackNetwork`): las buscaba por alias y los alias se borran con los stacks. Terminó con código 0.
- **Qué cambia en el guion.** Las llaves: las de cliente, activas, con `mango:namespace` igual al namespace pedido; nunca una de otro namespace ni una sin la etiqueta. Un alias `alias/Mango-<ns>-…` que quedara se borra, y la llave a la que apunta solo se programa si lleva la etiqueta. Los buckets: el guion lee si cada uno tiene Object Lock y solo entonces pide el salto; un error de S3 se muestra tal cual. La lista nombra lo que el guion no toca: las llaves que el stack ya dejó en espera de borrado, el log group `aws/spans` (lo crea Transaction Search para toda la cuenta, no Mango) y las revisiones inactivas de la task definition. Tablas, directorio, log groups y task definitions no cambian.
- **La guarda falla cerrada (decidido por el dueño el 2026-10-07, por menú).** El guion solo sigue si CloudFormation responde expresamente que el stack no existe, para `Mango-<ns>-Core` y para `Mango-<ns>-PackNetwork`. Si alguno existe, o si la consulta falla por cualquier otra causa (permisos, límite de tasa, credenciales caducadas, red), se detiene con error y dice por qué, con y sin `--confirm`. Antes tomaba cualquier fallo de la consulta por «no existe» y solo miraba `Core`. **Por qué ahora:** con las llaves por etiqueta, una consulta fallida haría que el guion programara el borrado de las llaves de datos de una instalación viva, después de quitar la protección de sus tablas; y la llave de logs de `PackNetwork` se programaría con su stack todavía en pie.
- **Solo los buckets de la región donde se comprobaron los stacks (decidido por el dueño el 2026-10-07, por menú).** Los stacks se consultan en la región configurada y S3 lista los buckets de todas: con otra región configurada, CloudFormation diría «no existe» de una instalación viva y sus buckets entrarían en la lista. El guion lee la región de cada bucket; uno de otra región se nombra entre lo que no toca, y sin región configurada el guion se niega. Lo encontró la revisión de seguridad de este cambio.
- **Quién lo decidió.** El dueño, el 2026-10-07, por menú: arreglar el guion ese día, sin cambiar plantillas ni publicar otra versión.
- **Propuesto por un agente y aceptado por el dueño el 2026-10-07:** un bucket cuyo Object Lock no se puede leer no se vacía (queda entre lo que no se pudo borrar); una llave que estas credenciales no pueden leer se cuenta y no se considera, y cualquier otro error al leer una llave detiene la purga; la lista nombra también las revisiones inactivas de la task definition.
- **Fuera de este punto.** El almacén de políticas de Verified Permissions hace fallar el primer borrado de `Core` (nace con protección de borrado y la plantilla manda borrarlo): el runbook documenta la salida; corregir la plantilla está pendiente.
- **Sin ver en una instalación.** Comprobado con tests que corren el guion contra un `aws` simulado (`deployment/tests/test_purge_retained.py`). Lo visto en una instalación es lo del 2026-10-07, con el guion sin corregir.
