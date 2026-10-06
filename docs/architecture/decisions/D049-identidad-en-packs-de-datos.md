# D49 · Identidad en packs de datos de cuentas

- **Estado:** parcial. Rige todo salvo el punto (7), que retira [D54](D054-egress-de-packs.md).
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** precisa [D37](D037-packs-de-datos-de-cuentas.md); en el texto: precisa [D43](D043-provisioner-de-packs.md) (punto 2)
- **Precisada por:** [D54](D054-egress-de-packs.md) (retira el punto 7); [D55](D055-pack-de-cloudwatch.md) (precisa el punto 5)
- **Tema en el registro original:** Identidad en packs de datos de cuentas (precisa [D37](D037-packs-de-datos-de-cuentas.md))

## Decisión

**(1) Aserción firmada, nunca el token.** Para las tools de un pack `central_only`, el interceptor del Gateway firma con una llave asimétrica de KMS (`alias/Mango-<ns>-pack-identity`, `ECC_NIST_P256`) quién llama: usuario, pack, tool, agente y 60 s de vigencia. Solo el rol del interceptor puede firmar (la política de la llave se lo niega a cualquier otro principal); el pack solo recibe la llave pública, por el provisioner. Solo se firma si el token validado trae `mango_central`. Cuesta una llamada a KMS por tool. La llave no rota sola: si se cambia, hay que reinstalar los packs `central_only`.

**(2) El rol de un pack `central_only` no tiene permisos de datos.** Solo puede asumir el broker, que exige `SourceIdentity`. Las acciones `iam` de su manifiesto firmado pasan a ser el tope de cada llamada (session policy sobre el rol detrás del broker), no permisos del rol; deben estar en la lista de ese rol (`BILLING_READER_DATA_ACTIONS`). El trust del broker nombra el ARN exacto del rol de cada pack `central_only` de la release, sin comodines. El permissions boundary de packs permite además asumir el broker (precisa [D43](D043-provisioner-de-packs.md): su lista de acciones de datos sigue cerrada y no cambia): quién lo usa lo decide el trust.

**(3) Punto de entrada común.** El paquete `mango-pack-runtime` viaja dentro del zip de los packs que no son `service`. Verifica la aserción, quita `_mango_ctx` y sustituye la cadena por defecto de credenciales de boto3 por las de la llamada en curso: fuera de una llamada con identidad verificada, firmar falla. Cierra S-M1 sin tocar funciones internas de los servidores upstream.

**(4) Cedar L2 para centrales.** Las políticas generadas de un pack `central_only` son un `permit` por `mango_central` y el mismo límite como `forbid … unless`, para que ninguna otra política del motor abra esas tools.

**(5) Una sola cadena por instalación:** broker de Billing → `Mango-<ns>-BillingReader` en la pagadora. El manifiesto no la nombra; un pack sobre cuentas miembro (§4.10) necesitará otra y un campo nuevo.

**(6) Una actualización no cambia el modo de identidad** de un pack instalado (409 `identity_mode_changed`): se deshabilita y se habilita de nuevo, para que quien aprueba vea en qué se convierte. El puntero `MCP_INSTALLED#` guarda nivel de datos y modo de identidad, y el catálogo decide con los de la versión instalada.

**(7) Red `PUBLIC` solo en laboratorio.** Los Runtimes de packs siguen en modo de red `PUBLIC` hasta que exista la allowlist de egress (R6). Un pack de datos de cuentas en esa red podría enviar fuera lo que lee, así que **solo una instalación `lab` puede traerlo e instalarlo**. Es un bloqueo, no una recomendación: con `installationType: customer` la síntesis falla si la release trae un pack `central_only`, y el provisioner de packs lo rechaza (`egress_allowlist_required`). **R6 es obligatoria antes de la primera instalación de un cliente con packs de datos de cuentas**; el bloqueo se retira en la misma PR que construya R6.

**(8) `mcp` como dependencia de desarrollo** (el SDK sobre el que están hechos los servidores awslabs), solo para probar el punto de entrada contra el SDK real; nunca se despliega.

**Riesgos aceptados:** la aserción no liga los argumentos de la llamada (repetible 60 s por quien pueda invocar el Runtime, que hoy son el Gateway y el provisioner de packs); el claim `mango_central` de un token ya emitido vale hasta 60 minutos; y el código dentro del proceso del pack es de confianza para la atribución (tiene el rol que asume el broker).

Modelo de amenazas: `docs/security/threat-models/pack-identity-threat-model.md`
