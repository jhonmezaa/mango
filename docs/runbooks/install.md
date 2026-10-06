# Instalar, actualizar y desinstalar Mango

Para quien instala Mango en su organización de AWS. Todo se hace con CloudFormation sobre las plantillas de una versión publicada: no se compila nada, no hace falta CDK ni bootstrap (D58).

Diseño: `docs/specs/customer-distribution.md`. Quien publica las versiones: `deployment/provider/README.md`.

## Antes de empezar

| Qué | Detalle |
|---|---|
| Una versión | Su etiqueta (por ejemplo `v0.1.0`) y el bucket de plantillas del proveedor. Las notas de la versión dan las URL |
| Lectura de la release | El proveedor debe haber añadido el id de tu organización (`o-…`) a su lista de clientes. Sin eso, CloudFormation responde `Access Denied` al leer la plantilla |
| Una cuenta para Mango | Dedicada, dentro de la organización. **No** la cuenta de gestión |
| Región | `us-east-1` |
| StackSets | Acceso de confianza de CloudFormation StackSets con Organizations activo (solo para `OrgAccess`) |
| Dos administradores | Los cambios con doble aprobación necesitan dos personas desde el primer día |
| Dominio de correo de la empresa | Para el registro. Los proveedores públicos (Gmail, Outlook…) se rechazan |
| Acceso a modelos de Bedrock | Los modelos por defecto de la versión, habilitados en la cuenta de Mango |

**Qué corre y qué cuesta en reposo.** La API (`mango-api`) corre siempre con **dos tareas de Fargate, una por zona de disponibilidad** (0,5 vCPU y 1 GB cada una, con IP pública), detrás de un balanceador interno: si cae una tarea o una zona, la otra sigue respondiendo. No hay autoescalado ni parámetro para cambiar el número (D70). A precios de lista de `us-east-1`, las dos tareas con sus IP son unos USD 36 al mes y el balanceador unos USD 16 a 20; el resto (CloudFront, WAF, KMS, logs) se detalla en §6 de la arquitectura. Lo demás se paga por uso.

## 1. Verificar la versión

Con credenciales de cualquier cuenta de tu organización y el repositorio en la etiqueta que vas a instalar:

```sh
python3 deployment/verify-release.py --bucket <bucket de plantillas> --label <etiqueta>
```

Comprueba que el manifiesto está firmado con la llave del proveedor (`packs/signing-key.pub`) y que cada plantilla es la que el manifiesto nombra. Si responde `NOT VERIFIED`, no instales.

Las plantillas, el manifiesto y su firma están en `mango/<etiqueta>/` del bucket de plantillas. Los archivos que las plantillas leen (código de las Lambdas, la web, los packs) están en `mango/assets/` del bucket regional, con el mismo nombre en todas las versiones mientras su contenido no cambie (D69); el manifiesto firmado da el sha256 de cada uno.

## 2. Instalar

Cuatro stacks, cada uno con `CreateStack` sobre `https://<bucket>.s3.amazonaws.com/mango/<etiqueta>/<Stack>.template.json`. El namespace (3 a 8 letras minúsculas o dígitos) es el mismo en los tres y va en todos los nombres: `Mango-<ns>-…`.

| Orden | Cuenta | Stack | Plantilla | Parámetros |
|---|---|---|---|---|
| 1 | Gestión | `Mango-<ns>-Payer` | `Payer` | `Namespace`, `MangoAccountId`, `OrganizationId` |
| 2 | Gestión (o administrador delegado de StackSets) | `Mango-<ns>-OrgAccess` | `OrgAccess` | Los tres anteriores, `Targets` (la raíz, o las OU), `ExcludedAccountIds` (debe incluir la cuenta de Mango). Opcional: `CallAs` |
| 3 | Mango | `Mango-<ns>-PackNetwork` | `PackNetwork` | `Namespace`, `OrganizationId`. Antes que `Core`, que la importa |
| 4 | Mango | `Mango-<ns>-Core` | `Core` | `Namespace`, `OrganizationId`, `ManagementAccountId`, `FirstAdminEmail`, `AlertsEmail`, `SignUpDomains` |

`Payer` y `Core` crean roles con nombre: hace falta `CAPABILITY_NAMED_IAM`. Entre cuentas ningún stack lee a otro. En la cuenta de Mango, `Core` importa de `PackNetwork` las subnets y los security groups de los packs.

```sh
aws cloudformation create-stack --stack-name Mango-<ns>-Core \
  --template-url https://<bucket>.s3.amazonaws.com/mango/<etiqueta>/Core.template.json \
  --parameters file://params-Core.json --capabilities CAPABILITY_NAMED_IAM \
  --tags Key=mango:namespace,Value=<ns> Key=mango:component,Value=core
```

Parámetros opcionales de `Core`:

| Parámetro | Por defecto | Para qué |
|---|---|---|
| `SecondAdminEmail` | vacío | Segundo administrador. Recomendado: los cambios con doble aprobación necesitan dos. Si se deja vacío, el primero lo nombra desde Ajustes › Personas (queda marcado en Auditoría como arranque) |
| `MemberAccessTargets`, `MemberAccessExcludedAccountIds` | vacío | Los mismos valores que diste a `OrgAccess`, para que Ajustes › Conectividad compruebe las cuentas miembro |
| `AvailabilityZoneIds` | `use1-az1,use1-az2` | Dos zonas, por **id** |
| `AiPolicyUrl` | vacío | URL `https` de la política de uso de IA; el registro pide aceptarla |
| `AuditRetentionDays`, `AuditLockMode` | 365, `GOVERNANCE` | Bloqueo del rastro de auditoría. `COMPLIANCE` no lo puede acortar ni quitar nadie hasta que venza |
| `HighRiskSignInAction` | `NO_ACTION` | `BLOCK` solo al cumplir los criterios de D31 |
| `TransactionSearch` | `stack` | `external` si la cuenta ya gestiona CloudWatch Transaction Search |

## 3. Después de instalar

1. **Primer ingreso de los administradores.** Reciben una contraseña temporal por correo (vence en 3 días) y registran MFA (TOTP) al entrar; MFA es obligatorio. La URL está en el output `AppUrl` de `Core`. Si la contraseña temporal venció, quien administra la cuenta de AWS la renueva con `aws cognito-idp admin-create-user --message-action RESEND` o fija una con `admin-set-user-password`.
2. Confirmar la suscripción del correo de alertas.
3. **En la aplicación, con los dos administradores** (cada cambio lo propone uno y lo aprueba el otro):
   1. Ajustes › Áreas y OUs: crear las áreas y asignarles sus OU.
   2. Ajustes › Grupos: crear el grupo de cada área (`bu-<área>`, tipo «área»). No existe hasta que alguien lo crea, y hay que crear antes el área.
   3. Presupuestos y modelos, si los valores de la versión no sirven (por defecto USD 5 al mes por usuario y USD 30 por agente).
4. **Personas: en Ajustes › Personas** (solo administradores).
   - Alta: las personas con correo de un dominio de `SignUpDomains` se registran solas; entran sin acceso hasta que un administrador les da un grupo. A las demás se las invita desde Personas: reciben una contraseña temporal por correo y registran MFA al entrar. Se puede invitar a alguien de otra empresa (cualquier dominio que no sea de un proveedor de correo público, como `gmail.com`); queda marcado en Auditoría.
   - Grupos: se dan y se quitan sobre la persona. Un líder de área necesita `bu-lead` y `bu-<área>`; quien crea agentes, `mango-agent-creator`. `mango-admin` y `finops-central` los propone un administrador y los aprueba otro. El cambio se ve en el siguiente ingreso de la persona.
   - Deshabilitar y rehabilitar el acceso, y pedir que se restablezca el MFA de alguien.
   - **Sigue fuera de la aplicación** (lo hace quien administra la cuenta de AWS, en Cognito; el id del directorio es el output `UserPoolId`): dar de alta a alguien con correo de un proveedor público (`aws cognito-idp admin-create-user`), renovar una contraseña temporal vencida, cambiar un correo y borrar una cuenta.
   - Ajustes › General › Instalación muestra la versión y la etiqueta de la release instalada («Publicación `v0.1.0-g…`»): sirve para confirmar qué se desplegó después de una actualización.
5. Ajustes › Conectividad: comprobar la cuenta pagadora y las cuentas miembro.
6. Catálogo de MCP: habilitar los packs que se vayan a usar (doble aprobación; la instalación de cada uno tarda unos 5 minutos). Si un pack queda en error, «Reintentar» repite la instalación sin pedir otra aprobación.

### Comprobar una instalación

Después de instalar y después de cada actualización:

1. **Plantilla de las cuentas miembro.** `Mango-<ns>-OrgAccess` publica en el output `MemberTemplateSha256` el sha256 de la plantilla que despliega en las cuentas miembro. Debe ser el de la `TemplateBody` del StackSet `Mango-<ns>-Member` (`aws cloudformation describe-stack-set`, sin el salto de línea final que añade la CLI).
2. **Recorridos en el navegador** (`tests/install`, con el repositorio en la etiqueta instalada). Ingresan como usuarios de prueba y comprueban lo que una persona ve: ingreso con MFA y sesión, cabeceras de seguridad, qué ve cada papel en el Marketplace y el Org Chart, Auditoría y que Ajustes › Instalación muestra la release.

   ```sh
   export MANGO_INSTALL_CONFIG=<archivo local, fuera del repositorio>
   mise run install-check
   ```

   - Son de **solo lectura**: se pueden correr contra cualquier instalación que tenga usuarios de prueba. Dejan eventos de ingreso y de lectura en Auditoría.
   - El archivo de configuración da la URL, un usuario de prueba por papel y dónde están sus contraseñas y secretos TOTP. Su forma, en `tests/install/config.example.json`; el detalle, en `tests/install/README.md`.
   - El informe queda fuera del repositorio (por defecto en `~/.config/mango/install-check/<fecha>/informe.md`), con la URL enmascarada, la release que muestra la instalación, qué pasó y qué se saltó. No guarda trazas ni video, y enmascara correos e ids.
   - Con `MANGO_INSTALL_EFFECTS=chat`, `people` o `all` corren además los recorridos **con efecto**: una pregunta al agente (gasta presupuesto) y un cambio de persona con doble aprobación sobre una persona desechable que la propia prueba invita y cierra. Para borrarla al final hace falta un perfil de AWS con acceso al directorio; sin él queda deshabilitada y el informe lo dice.
3. **Batería por la API** (`tests/e2e/`, `tests/eval/`). Toma todo de los outputs de `Mango-<ns>-Core` (`--stack`), de los parámetros de `Mango-<ns>-OrgAccess` y de la propia aplicación, con los mismos usuarios de prueba y su archivo de secretos. **No se corre contra una instalación con datos reales**: crea agentes, habilita packs y fija contraseñas.

## 4. Actualizar

`UpdateStack` de `Core` con la URL de la versión nueva y los parámetros anteriores (`UsePreviousValue`), siempre con un change set y a una etiqueta concreta. `PackNetwork` antes que `Core` cuando la versión añade un pack, y después cuando lo quita. Verifica la versión nueva antes (paso 1).

**Qué stacks hay que actualizar.** La verificación imprime el sha256 de cada plantilla. Un stack cuya plantilla tiene el mismo sha256 en la versión instalada y en la nueva no cambió: no se actualiza (CloudFormation respondería `didn't contain changes`). Es lo habitual en `Payer`, `OrgAccess` y `PackNetwork`. La descripción de un stack no nombra la versión (D69): la que corre `Core` se ve en Ajustes › General › Instalación.

**Qué esperar en el change set de `Core`.** Solo lo que la versión cambió:

| Entrada | Cuándo aparece |
|---|---|
| Task definition de `mango-api` (reemplazo) y su servicio de ECS | Siempre: lleva la etiqueta de la versión. Es un despliegue rodante de la API: arrancan dos tareas nuevas y las dos anteriores se apagan cuando las nuevas responden, así que el servicio no se corta. Las anteriores conservan hasta 120 s las peticiones abiertas; un turno de chat más largo que eso se corta y la persona lo reenvía |
| Los dos `Custom::CDKBucketDeployment` de la web | Si cambió la web |
| Una Lambda (`Code.S3Key`) y los recursos que leen su ARN (aparecen como reevaluación, sin cambio propio) | Si cambió ese paquete o una de sus dependencias |
| Un `Custom::CDKBucketDeployment` de un pack | Si cambió la versión de ese pack |

Para a revisar si aparece un `Remove`, un `Add` que las notas no explican, un `Replacement: True` fuera de la task definition y de las capas de Lambda, o un cambio directo en un recurso con datos (tablas, directorio de usuarios, buckets).

La primera actualización a una versión con D70 (dos tareas) añade una vez: la tabla `Mango-<ns>-RateLimits` (`Add`), la política del rol de `mango-api` (`Modify`: lectura y escritura de esa tabla), el servicio de ECS (`Modify`: `DesiredCount` de 1 a 2 y reequilibrio entre zonas, sin reemplazo) y el target group del balanceador (`Modify`: espera de 30 a 120 s). Ninguna es un reemplazo ni toca una tabla existente.

La primera actualización desde una versión anterior a D69 (publicada hasta el 2026-10-05) lista además todas las Lambdas, las capas y los `BucketDeployment`, una última vez: sus archivos cambian de ruta.

## 5. Desinstalar

1. `delete-stack` de `Core`. El stack borra primero, por su cuenta, los agentes y los packs que Mango creó (harness, Runtimes, targets, políticas, roles y sus log groups) y espera a que desaparezcan; puede tardar hasta una hora. Si responde que todavía se están borrando, repetir el `delete-stack`.
2. `delete-stack` de `PackNetwork`. AgentCore puede retener interfaces de red en esas subnets durante horas después de borrar los Runtimes: si el stack queda en `DELETE_FAILED`, repetir el borrado más tarde. Nada más depende de él.
3. `delete-stack` de `OrgAccess` y después de `Payer`, en la cuenta de gestión.

**Qué queda** (los datos se retienen a propósito): las tablas de DynamoDB, el directorio de usuarios, el bucket de auditoría (con Object Lock), los buckets de logs y de packs, los log groups y las llaves KMS (se pueden borrar a los 7 días). **No se puede reinstalar con el mismo namespace mientras existan**: los nombres son fijos. Borrarlos es un acto aparte y deliberado: `deployment/purge-retained.sh <namespace>` lista lo retenido y, con `--confirm`, lo borra (quita la protección de las tablas y del directorio, vacía los buckets con todas sus versiones, programa las llaves a 7 días). No tiene vuelta atrás. Con `AuditLockMode` `COMPLIANCE`, el bucket de auditoría no se puede vaciar hasta que venza la retención.

## Problemas conocidos

| Síntoma | Causa |
|---|---|
| `Access Denied` al leer la `TemplateURL` o el código de una Lambda | La organización no está en la lista de clientes del proveedor, o se instala desde una cuenta de otra organización |
| El stack falla en una regla antes de crear nada | `ManagementAccountId` es la cuenta donde se instala `Core`; la región no es `us-east-1`; `ExcludedAccountIds` no incluye la cuenta de Mango |
| Un pack queda en error con `verify_tools` / `tools_response_invalid` justo al habilitarlo | Visto una vez al instalar dos packs a la vez: el Runtime recién creado respondió algo que no era la lista de tools. «Reintentar» lo resolvió. El log de `Mango-<ns>-PackProvisioner` registra la forma de la respuesta (`pack_provisioner.tools_response_invalid`) |
| El sha256 de la plantilla del StackSet no coincide con `MemberTemplateSha256` | Versiones hasta `v0.1.0-gb557f40`: una descripción con un carácter fuera de ASCII, que CloudFormation guarda como `?`. No cambia permisos. Se corrige actualizando `OrgAccess` a una versión posterior |
| `CannotPullContainerError` en `mango-api` | La cuenta no puede leer el repositorio de imágenes del proveedor (misma lista de clientes) |
