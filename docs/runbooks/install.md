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
| Acceso a modelos de Bedrock | Los modelos por defecto de la versión, habilitados en la cuenta de Mango **y con su acuerdo de Marketplace aceptado**. En una cuenta nueva puede faltar solo el acuerdo. Comprobarlo **antes de instalar**: abajo, «El acceso a los modelos» |
| Cuota de Bedrock de la cuenta | Es lo que decide cuánta gente puede chatear a la vez, y una cuenta nueva puede tenerla muy por debajo del valor por defecto de AWS. Comprobarla **antes de instalar**: abajo, «La cuota de Bedrock» |
| Cupo de políticas de recursos de CloudWatch Logs | La instalación usa **3**: una en `PackNetwork` (registro de consultas DNS de los packs) y dos en `Core` (eventos de Cognito y trazas; una sola con `TransactionSearch` en `external`). El máximo es **10 por cuenta y región y AWS no lo amplía**. Cuántas hay: `aws logs describe-resource-policies --query 'length(resourcePolicies)'`. Deben quedar libres las que falten por crear. Sin cupo, el stack falla al crear su política (`AWS::Logs::ResourcePolicy`, límite excedido) y CloudFormation lo revierte: hay que borrar o unir políticas de la cuenta antes de reintentar |

**Qué corre y qué cuesta en reposo.** La API (`mango-api`) corre siempre con **dos tareas de Fargate, una por zona de disponibilidad** (0,5 vCPU y 1 GB cada una, con IP pública), detrás de un balanceador interno: si cae una tarea o una zona, la otra sigue respondiendo. No hay autoescalado ni parámetro para cambiar el número (D70). A precios de lista de `us-east-1`, las dos tareas con sus IP son unos USD 36 al mes y el balanceador unos USD 16 a 20. **La partida mayor no es la API, sino la red cerrada de los MCP packs** (stack `PackNetwork`): unos USD 117 al mes por sus endpoints de interfaz, se habilite o no algún pack. Con los dos WAF, las llaves KMS, las alarmas y los logs, una instalación sin tráfico cuesta entre USD 210 y 230 al mes; son estimaciones a precio de lista, sin contrastar con una factura, y el detalle está en §6 de la [arquitectura](../architecture/reference-architecture.md). Lo demás se paga por uso.

**Cuánta gente aguanta.** Una instalación sirve **hasta unas 300 personas activas a la vez** (D70, punto 9). De dónde sale la cifra, y con qué condiciones:

- **Medido** en una instalación de laboratorio el 2026-10-06, con las dos tareas: 80 lecturas de la API por segundo con margen (el 95 % en 0,1 s), 160 en el límite (ya lento) y 200 saturada.
- **Supuestos de uso, no datos de una empresa:** una persona activa envía un turno de chat por minuto y navega algo (15 llamadas a la API cada 5 minutos). Pesando cada llamada por lo que cuesta, 80 lecturas por segundo son unas 330 personas. Si en una oficina está activo el 30 %, es una empresa de unas 1.000 personas.
- **Condicionada a la cuota de Bedrock de la cuenta.** 300 personas con un turno por minuto son al menos 300 llamadas por minuto al modelo, y más si los agentes usan tools. Con la cuota baja, el techo del chat es la cuota, no Mango.
- **Por encima no hay margen.** Si hace falta más, avisa al proveedor: el tamaño de las tareas es de la versión, no un parámetro.

### El acceso a los modelos

En una cuenta nueva un modelo puede estar autorizado y disponible en la región y faltarle el acuerdo de Marketplace de su proveedor. Sin el acuerdo, el primer turno de chat falla: el rol del agente no puede aceptarlo. Con las credenciales de quien instala, en la cuenta y región de Mango, por cada modelo por defecto de la versión:

```sh
aws bedrock get-foundation-model-availability --model-id <id del modelo>
```

- `agreementAvailability.status` debe decir `AVAILABLE`. En una cuenta nueva se vio `NOT_AVAILABLE` con todo lo demás en orden (instalación de laboratorio, 2026-10-07).
- **Aceptarlo:** en la consola de Bedrock (acceso a modelos), o por API:

  ```sh
  aws bedrock list-foundation-model-agreement-offers --model-id <id del modelo>
  aws bedrock create-foundation-model-agreement --model-id <id del modelo> --offer-token <offerToken de la oferta>
  ```

- Tarda: pasó de `PENDING` a `AVAILABLE` en unos 50 s (visto en una instalación de laboratorio el 2026-10-07). Repetir la primera consulta hasta que diga `AVAILABLE`.
- El acuerdo es de la cuenta, no de Mango: desinstalar no lo deshace.

### La cuota de Bedrock

Cada cuenta de AWS tiene, por modelo y región, un máximo de llamadas y de tokens por minuto. Un turno de chat es al menos una llamada al modelo, y una más por cada vuelta de tools del agente. Con las credenciales de quien instala, en la cuenta y región de Mango, y el repositorio en la etiqueta que vas a instalar:

```sh
python3 deployment/check-bedrock-quotas.py                    # antes de instalar: los modelos por defecto de la versión
python3 deployment/check-bedrock-quotas.py --namespace <ns>   # después: los modelos habilitados en la instalación
```

- Es de **solo lectura**: lista los modelos de Bedrock y las cuotas de Service Quotas (y, con `--namespace`, lee el catálogo de modelos de la tabla `Mango-<ns>-Settings`). Con `--model <id>` comprueba cualquier otro modelo.
- Por cada modelo dice la cuota **aplicada** a la cuenta, el valor por defecto de AWS y para cuántas personas alcanza. Termina con error si alguna está por debajo del valor por defecto o no se pudo leer. **Ese error no impide instalar:** avisa de que el chat tendrá ese techo hasta que la cuota suba. En una cuenta nueva se vieron 50 llamadas por minuto, y el guion terminó con error (instalación de laboratorio, 2026-10-07).
- **Una cuota aplicada puede estar muy por debajo del valor por defecto** (se vio 10 llamadas por minuto donde el valor por defecto es 10.000, en una cuenta nueva). Con 10 por minuto responden en segundos unos 5 turnos a la vez. Con más no fallan, esperan: con 35 a la vez terminaron todos, cerca de la mitad en más de un minuto y hasta uno de cada cuatro en más de tres (medido el 2026-10-06; D70, punto 14).
- **Esa cuota no se sube desde Service Quotas.** La solicitud de aumento se rechaza (visto por API), porque solo admite valores por encima del valor por defecto. Hay que abrir un caso en la consola de Support Center (Create case › Service limit increase › Amazon Bedrock) y pedir que se restablezca el valor por defecto. El plan básico de soporte permite ese caso; su API no. Puede tardar días: conviene pedirlo antes de instalar.
- **Si ya está en el valor por defecto y no alcanza:** Service Quotas › Amazon Bedrock › la cuota del modelo › solicitar un aumento a nivel de cuenta.
- La cuota se relaciona con el modelo por su nombre (Service Quotas no lleva el id). Si el guion dice que no encontró la de un modelo, búscala a mano en Service Quotas › Amazon Bedrock.
- Después de instalar, la alarma `Bedrock-throttled` avisa cuando Bedrock rechaza llamadas: [`operations.md`](operations.md#alarmas).

## 1. Verificar la versión

Con credenciales de cualquier cuenta de tu organización y el repositorio en la etiqueta que vas a instalar:

```sh
python3 deployment/verify-release.py --bucket <bucket de plantillas> --label <etiqueta>
```

Comprueba que el manifiesto está firmado con la llave del proveedor (`packs/signing-key.pub`) y que cada plantilla es la que el manifiesto nombra. Si responde `NOT VERIFIED`, no instales.

Las plantillas, el manifiesto y su firma están en `mango/<etiqueta>/` del bucket de plantillas. Los archivos que las plantillas leen (código de las Lambdas, la web, los packs) están en `mango/assets/` del bucket regional, con el mismo nombre en todas las versiones mientras su contenido no cambie (D69); el manifiesto firmado da el sha256 de cada uno.

## 2. Instalar

Cuatro stacks, cada uno con `CreateStack` sobre `https://<bucket>.s3.amazonaws.com/mango/<etiqueta>/<Stack>.template.json`. El namespace (3 a 8 letras minúsculas o dígitos) es el mismo en los cuatro y va en todos los nombres: `Mango-<ns>-…`.

| Orden | Cuenta | Stack | Plantilla | Parámetros | `--capabilities` | Etiqueta `mango:component` |
|---|---|---|---|---|---|---|
| 1 | Gestión | `Mango-<ns>-Payer` | `Payer` | `Namespace`, `MangoAccountId`, `OrganizationId` | `CAPABILITY_NAMED_IAM` | `payer` |
| 2 | Gestión (o administrador delegado de StackSets) | `Mango-<ns>-OrgAccess` | `OrgAccess` | Los tres anteriores, `Targets` (la raíz, o las OU), `ExcludedAccountIds` (debe incluir la cuenta de Mango). Opcional: `CallAs` | Ninguna | `org-access` |
| 3 | Mango | `Mango-<ns>-PackNetwork` | `PackNetwork` | `Namespace`, `OrganizationId`. Antes que `Core`, que la importa | `CAPABILITY_IAM` | `pack-network` |
| 4 | Mango | `Mango-<ns>-Core` | `Core` | `Namespace`, `OrganizationId`, `ManagementAccountId`, `FirstAdminEmail`, `AlertsEmail`, `SignUpDomains` | `CAPABILITY_NAMED_IAM` | `core` |

- **Capacidades.** `Payer` y `Core` crean roles con nombre: piden `CAPABILITY_NAMED_IAM`. `PackNetwork` crea un rol sin nombre fijo: pide `CAPABILITY_IAM` (`CAPABILITY_NAMED_IAM` también vale). Sin ella, `create-stack` responde `InsufficientCapabilitiesException: Requires capabilities : [CAPABILITY_IAM]` y no crea nada: se repite el comando con la capacidad. `OrgAccess` no pide ninguna.
- **Etiquetas del stack: opcionales.** Nada de Mango depende de ellas: los recursos ya salen de la plantilla con `mango:namespace` y `mango:component`. Sirven para encontrar los stacks y agrupar su costo. Si se ponen, `mango:namespace` = `<ns>` en los cuatro y `mango:component` con el valor de la tabla.
- **Cuánto tarda cada uno** (visto en una instalación de laboratorio en una cuenta nueva, el 2026-10-07): `Payer` 62 s, `OrgAccess` 122 s, `PackNetwork` 154 s y `Core` 20 min 44 s.
- Entre cuentas ningún stack lee a otro. En la cuenta de Mango, `Core` importa de `PackNetwork` las subnets y los security groups de los packs.
- **El correo de confirmación de las alertas llega al empezar `Core`,** no al terminar: en el mismo minuto del `create-stack` (visto el 2026-10-07). **No pulses su enlace.** Antes de lanzar `Core`, lee cómo confirmarlo para que la baja exija credenciales: [`operations.md`](operations.md#el-enlace-de-baja-del-correo). Quien recibe ese correo (`AlertsEmail`) tiene que saberlo de antemano.
- **El agente de la versión se publica solo,** mientras `Core` termina de crearse. Al terminar, la alarma `Mango-<ns>-AgentProvisioner-failed` debe estar en `OK`; si está en `ALARM`, ver «Problemas conocidos».

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
2. Confirmar la suscripción del correo de alertas, si no se hizo al llegar el correo (llega al empezar `Core`), y comprobar que una alarma de prueba llega: [`operations.md`](operations.md#comprobar-que-el-correo-llega).
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
4. **Alarmas.** Ninguna en `ALARM` sin motivo, y el correo de alertas recibe una de prueba: [`operations.md`](operations.md#alarmas).
5. **Cuota de Bedrock,** con los modelos que la instalación tiene habilitados: `python3 deployment/check-bedrock-quotas.py --namespace <ns>` ([La cuota de Bedrock](#la-cuota-de-bedrock)).

## 4. Actualizar

`UpdateStack` de `Core` con la URL de la versión nueva y los parámetros anteriores (`UsePreviousValue`), siempre con un change set y a una etiqueta concreta. `PackNetwork` antes que `Core` cuando la versión añade un pack, y después cuando lo quita. Verifica la versión nueva antes (paso 1).

**Qué stacks hay que actualizar.** La verificación imprime el sha256 de cada plantilla. Un stack cuya plantilla tiene el mismo sha256 en la versión instalada y en la nueva no cambió: no se actualiza (CloudFormation respondería `didn't contain changes`). Es lo habitual en `Payer`, `OrgAccess` y `PackNetwork`. La descripción de un stack no nombra la versión (D69): la que corre `Core` se ve en Ajustes › General › Instalación.

**Qué esperar en el change set.** Lo que la versión cambió, y las reevaluaciones que eso arrastra. Estas entradas son normales en cualquier versión:

| Entrada | Cuándo aparece |
|---|---|
| Task definition de `mango-api` (reemplazo) y su servicio de ECS | Siempre: lleva la etiqueta de la versión. Es un despliegue rodante de la API: arrancan dos tareas nuevas y las dos anteriores se apagan cuando las nuevas responden, así que el servicio no se corta. Las anteriores conservan hasta 120 s las peticiones abiertas; un turno de chat más largo que eso se corta y la persona lo reenvía |
| Los dos `Custom::CDKBucketDeployment` de la web | Si cambió la web |
| Una Lambda (`Code.S3Key`) | Si cambió ese paquete o una de sus dependencias |
| Un `Modify` con detalles solo dinámicos (una reevaluación: la regla general, debajo de esta tabla) | Si el recurso lee un atributo de otro que la versión modifica. Sin eventos al ejecutar |
| Un `Custom::CDKBucketDeployment` de un pack | Si cambió la versión de ese pack |
| `CDKMetadata` (`AWS::CDK::Metadata`), `Modify` de la propiedad `Analytics`, con `Replacement: Conditional` | Si la versión usa en ese stack un tipo de recurso que antes no tenía (su primera alarma, su primer tablero). En cualquier stack, también en `PackNetwork`. Es la lista de tipos que CDK anota en la plantilla: **no crea ni toca ningún recurso** |
| Un `Add`, o un `Modify` sin reemplazo, que nombran las notas de la versión | Si la versión añade o ajusta un recurso. Los de las versiones publicadas están en la tabla de abajo |

**Regla general: las reevaluaciones.** Un recurso que lee un atributo de otro que se modifica (su ARN, su id, su nombre, su dominio) puede aparecer como `Modify` aunque su parte de la plantilla sea idéntica. Se reconoce porque **todos** sus detalles son dinámicos (`Evaluation: Dynamic`, `ChangeSource: ResourceAttribute`) y ninguno es `Static`; puede traer `Replacement: Conditional`. Al ejecutar no tiene ningún evento: CloudFormation lo vuelve a evaluar, ve que el valor no cambió y no lo toca. Vale para cualquier recurso y en cualquier stack, y en cadena (quien lee a uno reevaluado también puede aparecer). CloudFormation no siempre las lista: la misma clase de cambio puede traerlas en una versión y no en otra. Las que se han visto: los recursos que leen el ARN de una Lambda (permisos de invocación, reglas programadas, máquinas de estado y sus políticas, el Gateway de AgentCore con sus targets y sus políticas, el user pool); las alarmas de la API, que leen el grupo de destino o el nombre del servicio de ECS; la distribución de CloudFront, que lee el ARN de su web ACL; el cliente del user pool, que lee el dominio de la distribución; la asociación del web ACL del user pool; y, en `PackNetwork`, la asociación del grupo de reglas del DNS Firewall con la VPC. Una entrada con algún detalle `Static` no es una reevaluación: es un cambio de la plantilla y tienen que explicarlo las notas de la versión.

**Cuántas esperar.** Las reevaluaciones pueden ser más que los cambios. Una versión que cambia el código de varias Lambdas arrastra a todo lo que lee sus ARN, y a lo que lee a esos recursos. En una actualización de una instalación de laboratorio (2026-10-06) el change set de `Core` trajo 58 entradas: 12 `Add`, 14 `Modify` con cambio de plantilla y 32 reevaluaciones. Las 32 eran idénticas en la plantilla instalada y en la nueva, y ninguna tuvo eventos al ejecutar. Lo que hay que explicar con las notas de la versión son las dos primeras cifras, no la tercera.

**La más corta: una versión que solo cambia `mango-api`.** El change set de `Core` trae cuatro entradas, todas `Modify`: la task definition (reemplazo, por la imagen y la etiqueta de la versión), el servicio de ECS, que la lee, y, por reevaluación, la alarma `Api-tasks-below-desired`, que lee el nombre del servicio, y el tablero, que lee ese nombre y el ARN de esa alarma. **Ninguna función y nada de la web:** la etiqueta de la versión viaja en la task definition, no en el paquete de la web ni en el de ninguna Lambda, así que sus archivos son los mismos bytes y no se vuelven a desplegar. Sin funciones modificadas tampoco aparecen las reevaluaciones del user pool, del Gateway ni de las políticas. Las dos reevaluaciones no tienen eventos al ejecutar y, como todas, CloudFormation puede no listarlas. Una Lambda, un `BucketDeployment` o una política de IAM en el change set de una versión así no es lo esperado: hay que explicarlo con las notas antes de ejecutar. Visto en una instalación de laboratorio el 2026-10-06: 4 `Modify`, 10 eventos sobre 3 recursos (el stack, la task definition y el servicio) y 3 min 15 s, sin corte del servicio.

**El directorio de usuarios como reevaluación.** El user pool aparece como `Modify` cuando la versión cambia el código de una de sus Lambdas (la del registro o la de los tokens): lee sus ARN (`LambdaConfig`). Es una reevaluación como las demás: solo detalles dinámicos, sin reemplazo y sin eventos. Si la versión no toca esas Lambdas, no aparece. Con algún detalle `Static`, o con `Replacement: True`, hay que parar.

**Para a revisar** si aparece cualquiera de estas, en la versión que sea:

- un `Remove`;
- un `Add`, o un `Modify` con algún detalle `Static`, que ni las notas de la versión ni la tabla de abajo explican;
- un `Replacement: True` fuera de la task definition y de las capas de Lambda;
- un cambio directo en un recurso con datos (tablas, directorio de usuarios, buckets).

**Lo que trajo cada versión, una sola vez.** Aparece en la primera actualización que pasa por esa versión y no vuelve a salir. Quien salta varias versiones ve juntas las filas de todas. Cada versión que añada o ajuste recursos suma aquí su fila; lo de arriba no cambia.

| Versión con | Entradas que añade, una vez |
|---|---|
| D69 (assets por contenido), al venir de una versión publicada hasta el 2026-10-05 | Todas las Lambdas, las capas y los `BucketDeployment`, una última vez: sus archivos cambian de ruta |
| D70 (dos tareas) | En `Core`: la tabla `Mango-<ns>-RateLimits` (`Add`), la política del rol de `mango-api` (`Modify`: lectura y escritura de esa tabla), el servicio de ECS (`Modify`: `DesiredCount` de 1 a 2 y reequilibrio entre zonas, sin reemplazo) y el target group del balanceador (`Modify`: espera de 30 a 120 s). Ninguna es un reemplazo ni toca una tabla existente |
| D71 (alarmas y tablero) | En `Core`: 20 alarmas (`AWS::CloudWatch::Alarm`) y el tablero `Mango-<ns>-Operations` (`AWS::CloudWatch::Dashboard`), todos `Add`, más el `Modify` de `CDKMetadata`. **Esta vez también hay que actualizar `PackNetwork`**, antes que `Core`: un `Add` (la alarma `PackDns-blocked`) y el `Modify` de su `CDKMetadata` |
| D71, punto 11 (`Api-no-healthy-targets` avisa sin datos) | En `Core`: un `Modify` sin reemplazo de esa alarma (`TreatMissingData`, y su descripción). `PackNetwork` no cambia |
| D71, puntos 13 y 14 (lista del DNS Firewall para lo que pide la plataforma y registro de consultas) | **Hay que actualizar `PackNetwork`**, antes que `Core`. Cinco `Add`: la lista `Mango-<ns>-PackDnsPlatform` (`AWS::Route53Resolver::FirewallDomainList`), el log group `Mango-<ns>-PackNetwork-dns-queries`, su política de recursos (`AWS::Logs::ResourcePolicy`), la configuración del registro de consultas (`ResolverQueryLoggingConfig`) y su asociación a la VPC. Tres `Modify` de la plantilla: el grupo de reglas del DNS Firewall (`FirewallRules`: una regla más) y la alarma `PackDns-blocked` (su descripción), sin reemplazo, y `CDKMetadata` (`Replacement: Conditional`, como siempre). Y un cuarto `Modify` que es una reevaluación: la asociación del grupo de reglas con la VPC (`AWS::Route53Resolver::FirewallRuleGroupAssociation`, `Replacement: Conditional`), que lee el id del grupo; el id no cambia y al ejecutar no tiene eventos. Nueve entradas en total. En `Core`, nada por esto. La política nueva es la tercera de la instalación y necesita cupo: comprobarlo antes, como dice «Antes de empezar» (`aws logs describe-resource-policies`). Si la cuenta ya tiene las 10 que CloudWatch Logs admite por región, ese `Add` falla y la actualización se revierte; hay que liberar una, porque el máximo no se sube |
| D72 (límites por IP y renovación firmada) | En `Core`, todos sin reemplazo: los dos web ACL (`AWS::WAFv2::WebACL`), `Modify` de `Rules` (y de `CustomResponseBodies` en el del borde, `Mango-<ns>-edge`); la política del rol de `mango-api` (`Modify`: una acción más, `cognito-idp:AdminInitiateAuth`, sobre el user pool); la alarma `Mango-<ns>-Cognito-rate-limited` (`Add`); la alarma `Mango-<ns>-Edge-rate-limited` (`Modify`: ahora suma dos métricas) y el tablero (`Modify`). **El user pool, su cliente y la distribución de CloudFront no cambian en la plantilla.** Aparecen tres reevaluaciones, sin eventos al ejecutar: la distribución (lee el ARN del web ACL del borde), el cliente del user pool (`CallbackURLs` y `LogoutURLs`, que leen el dominio de la distribución) y la asociación del web ACL del user pool (`AWS::WAFv2::WebACLAssociation`, `Replacement: Conditional`). El user pool no aparece; si apareciera, o si el cliente trajera un detalle `Static`, hay que parar. `PackNetwork`, `Payer` y `OrgAccess` no cambian |
| D70, puntos 9 y 10, y D71, punto 16 (reparto por peticiones abiertas, dos alarmas de saturación, espera de un turno de chat) | En `Core`: el target group del balanceador (`Modify` sin reemplazo de `TargetGroupAttributes`: `load_balancing.algorithm.type` pasa a `least_outstanding_requests`; el cambio se aplica al momento, sin cortar conexiones); dos alarmas, `Mango-<ns>-Api-slow` y `Mango-<ns>-Bedrock-throttled` (`Add`); y el tablero (`Modify`: dos gráficos más). Sin cambios de permisos, de tablas ni de parámetros. El resto del cambio va dentro de la imagen de `mango-api` (la task definition y el servicio de siempre). `PackNetwork`, `Payer` y `OrgAccess` no cambian |
| D70, punto 11 (límite y copia de las listas de agentes) | En `Core`: la política del rol de `mango-api` (`Modify` sin reemplazo: una acción más, `dynamodb:BatchGetItem`, sobre la tabla de agentes). El resto va dentro de la imagen de `mango-api`. `PackNetwork`, `Payer` y `OrgAccess` no cambian |
| D72, puntos 12 y 13 (la espera de un bloqueo pasa a 180 segundos y el web ACL del borde deja de declarar una CSP) | En `Core`: un `Modify` sin reemplazo del web ACL del borde (`Mango-<ns>-edge`): `Rules` (las cabeceras de sus dos respuestas) y `CustomResponseBodies` (el texto de la página). Pueden acompañarlo las mismas reevaluaciones de la distribución y del cliente del user pool. El web ACL del user pool, las alarmas y `PackNetwork` no cambian |
| D73 (un turno cortado nunca cuesta cero) | En `Core`, diez `Add`: la función `Mango-<ns>-BudgetReconciler`, su rol y la política del rol, su log group, la regla `Mango-<ns>-BudgetReconciler-schedule` (cada 5 minutos) y su permiso de invocación, la cola `Mango-<ns>-BudgetReconciler-dlq` y su política, y dos alarmas (`BudgetReconciler-reservation-charged` y `BudgetReconciler-failed`). Un `Modify` del tablero (`DashboardBody`: dos alarmas más en su lista). `CDKMetadata` no cambia. **Las nueve funciones que llevan `mango-core` cambian de código** (`Modify` de `Code`, sin reemplazo: registro, conector de Cost Explorer, interceptor del Gateway, ejecutor de aprobaciones, provisioner, deprovisioner, reconciliador diario, provisioner de packs y `UninstallGuard`): el paquete compartido tiene un módulo nuevo. Ninguna tabla cambia: los turnos pendientes son filas nuevas de `Budgets`. Sin cambios en el rol de `mango-api` ni en los parámetros. El resto va dentro de la imagen de `mango-api`. `PackNetwork`, `Payer` y `OrgAccess` no cambian |
| D58, punto 13 (el `UninstallGuard` puede borrar la política de un pack y dice qué operación le falló) | En `Core`: la política del rol `Mango-<ns>-UninstallGuard` (`Modify` sin reemplazo: una sentencia más, `bedrock-agentcore:ManageResourceScopedPolicy` sobre el Gateway) y el código de las cuatro funciones que llevan el paquete del provisioner (`Modify` de `Code`, sin reemplazo: provisioner, deprovisioner, provisioner de packs y `UninstallGuard`). El recurso `Custom::MangoUninstallGuard` no cambia en la plantilla: no tiene propiedades propias. Si apareciera, solo puede ser una reevaluación (lee el ARN de su función, que no cambia), sin detalle `Static` y sin eventos al ejecutar; con cualquier otra cosa hay que parar. Este change set no se ha visto todavía en una instalación. Sin cambios de tablas ni de parámetros. `PackNetwork`, `Payer` y `OrgAccess` no cambian |
| D58, punto 14 (el almacén de políticas sin protección de borrado) | En `Core`: un `Modify` sin reemplazo del almacén de políticas (`AWS::VerifiedPermissions::PolicyStore`: `DeletionProtection` pasa a `DISABLED`). Su id no cambia. Pueden acompañarlo reevaluaciones de lo que lee ese id (las políticas del almacén, la task definition y la política del rol de `mango-api`), sin detalle `Static`; si el almacén trajera un reemplazo, hay que parar. Este change set no se ha visto todavía en una instalación. `PackNetwork`, `Payer` y `OrgAccess` no cambian |

## 5. Desinstalar

1. `delete-stack` de `Core`. El stack borra primero, por su cuenta, los agentes y los packs que Mango creó (harness, Runtimes, targets, políticas, roles y sus log groups) y espera a que desaparezcan; puede tardar hasta una hora. Si responde que todavía se están borrando, repetir el `delete-stack`.
   - **Con una versión hasta `v0.1.0-g5bf4346` y algún pack habilitado, deshabilitar antes los packs desde la aplicación** (Catálogo de MCP) y esperar a que terminen. Si no, el borrado falla a los pocos segundos en el recurso `Custom::MangoUninstallGuard` y la instalación queda a medias: ver «Problemas conocidos». Con una versión posterior no hace falta.
   - **Con agentes publicados y packs habilitados** (visto el 2026-10-07 con dos agentes y un pack): la política del pack se borra al momento, su Runtime en unos 80 segundos y los dos harness en unos 7 minutos; después, los roles y los log groups. Unos 9 minutos en total, antes de que el stack borre el resto.
   - Si el recurso `Custom::MangoUninstallGuard` falla con «Uninstall guard failed (…)», el paréntesis dice la operación y el código del error (por ejemplo `DeletePolicy: AccessDeniedException`; las versiones hasta `v0.1.0-g5bf4346` dan solo el código). El log `/aws/lambda/Mango-<ns>-UninstallGuard` trae lo mismo y cuánto quedaba por borrar. Repetir el `delete-stack` solo sirve si el error era pasajero: un permiso denegado falla igual.
   - **Con una versión hasta `v0.1.0-g5bf4346`, ese primer borrado termina en `DELETE_FAILED` por un solo recurso:** el almacén de políticas de Verified Permissions (`AWS::VerifiedPermissions::PolicyStore`), con «The policy store cannot be deleted because deletion protection is enabled». En esas versiones el almacén nace con protección de borrado y la plantilla manda borrarlo. Todo lo demás ya se borró o quedó retenido. **Con una versión posterior el almacén no lleva protección y el stack lo borra** (D58, punto 14; comprobado con tests, sin ver todavía en una instalación): los dos puntos siguientes no hacen falta.
   - **La salida, en esas versiones:** quitarle la protección y repetir el `delete-stack`. El id del almacén es el id físico de ese recurso en los eventos del stack; el modo de validación hay que repetirlo tal como está (`aws verifiedpermissions get-policy-store --policy-store-id <id> --query validationSettings.mode`):

     ```bash
     aws verifiedpermissions update-policy-store --policy-store-id <id> \
       --validation-settings mode=<el que tenga> --deletion-protection DISABLED
     aws cloudformation delete-stack --stack-name Mango-<ns>-Core
     ```

   - Si el recurso que falla es otro, parar y mirar su mensaje: esta salida es solo para el almacén de políticas.
   - Una suscripción del correo de alertas rehecha fuera del stack (baja y alta de la misma dirección; [`operations.md`](operations.md#el-enlace-de-baja-del-correo)) no estorba: el topic se borra con sus suscripciones.
   - Al borrarse `Core`, CloudWatch Transaction Search vuelve a quedar apagado en la cuenta (el destino de las trazas vuelve a `XRay`), salvo que la cuenta lo gestione por fuera (`TransactionSearch` = `external`).
2. `delete-stack` de `PackNetwork`. AgentCore puede retener interfaces de red en esas subnets durante horas después de borrar los Runtimes: si el stack queda en `DELETE_FAILED`, repetir el borrado más tarde. Nada más depende de él. Visto el 2026-10-07, después de borrar el Runtime de un pack: 20 minutos después AgentCore seguía reteniendo 2 interfaces (`agentic_ai`, en uso) y el stack seguía esperando para borrar sus subnets. Se ven con `aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=<vpc de PackNetwork>`.
3. `delete-stack` de `OrgAccess` y después de `Payer`, en la cuenta de gestión.

**Cuánto tarda.** Visto en una instalación de laboratorio el 2026-10-07, dos veces: sin agentes publicados ni packs habilitados, y con dos agentes y un pack.

| Stack | Sin agentes ni packs | Con dos agentes y un pack |
|---|---|---|
| `Core` | 18 min hasta el fallo del almacén de políticas; 15 s el segundo borrado | 21 min 48 s el borrado que terminó, de los que unos 9 min son de los agentes y el pack. Antes, un primer borrado falló a los 6 min 26 s por dos recursos: el almacén de políticas y el `UninstallGuard` (versión `v0.1.0-g5bf4346`; ver «Problemas conocidos») |
| `PackNetwork` | 3 min 35 s | Sin terminar a los 20 min: esperaba a que AgentCore soltara 2 interfaces de red (paso 2) |
| `OrgAccess` | 54 s | 54 s |
| `Payer` | 19 s | 19 s |

### Qué queda y cómo se borra

Los datos se retienen a propósito. **No se puede reinstalar con el mismo namespace mientras existan:** los nombres son fijos. Borrarlos es un acto aparte y deliberado, sin vuelta atrás:

```bash
deployment/purge-retained.sh <namespace>            # solo lista
deployment/purge-retained.sh <namespace> --confirm  # borra lo listado
```

Se ejecuta en la cuenta de Mango y en la región de la instalación, con `Core` y `PackNetwork` ya borrados. **Mientras exista cualquiera de los dos, se niega,** con y sin `--confirm`. Solo sigue si CloudFormation responde que no existen: si no puede comprobarlo (sin permiso para consultar los stacks, credenciales caducadas, un límite de tasa, sin red, sin región configurada), se detiene con el error de AWS y no lista ni borra nada. Hay que corregir eso y repetir. Si `PackNetwork` sigue en `DELETE_FAILED` por las interfaces de red de AgentCore (paso 2), la purga espera a que ese borrado termine. Necesita `aws` y `jq`. Las cantidades son las de la instalación de laboratorio del 2026-10-07:

| Qué queda | Visto | Qué hace la purga |
|---|---|---|
| Tablas de DynamoDB `Mango-<ns>-…` | 8 | Les quita la protección de borrado y las borra |
| Directorio de usuarios `Mango-<ns>-Users` | 1 | Borra su dominio, le quita la protección y lo borra |
| Buckets `mango-<ns>-core-…` y `mango-<ns>-packnetwork-…` | 4: el de auditoría (con Object Lock), dos de logs de acceso y el de packs | Borra todas las versiones y después el bucket. Solo pide saltar la retención en el que tiene Object Lock; la lista dice cuál es |
| Log groups de la instalación | 27 | Los borra |
| Llaves KMS de `Core` y de `PackNetwork` | 7 activas y sin alias (6 de `Core`, 1 de `PackNetwork`): los alias se borran con los stacks. Cada una cuesta USD 1 al mes, el precio de lista de KMS, hasta que se borra | Las encuentra por la etiqueta `mango:namespace` de la instalación y programa su borrado a 7 días, el mínimo de AWS. Nunca toca una llave de otro namespace ni una sin esa etiqueta. La lista da el id, el componente (`mango:component`) y la descripción de cada una |
| Alias `alias/Mango-<ns>-…` | Ninguno | Si quedara alguno, lo borra. La llave a la que apunta solo se programa si lleva la etiqueta |

**Lo que la purga no toca,** y nombra al final de la lista («Not touched by this script»):

| Qué | Visto | Por qué |
|---|---|---|
| Llaves KMS que el stack ya dejó en espera de borrado | 2 | Se borran solas a los 7 días. En espera no cuestan |
| Log group `aws/spans` | 1 | Lo crea Transaction Search para toda la cuenta, no Mango: puede tener trazas de otros. Si nadie más lo usa, se borra a mano (`aws logs delete-log-group --log-group-name aws/spans`) |
| Revisiones inactivas de la task definition `Mango-<ns>-api` | 3 | No cuestan y no impiden reinstalar |
| Un bucket con nombre de la instalación en otra región | Ninguno | Los stacks solo se comprobaron en la región configurada. Si aparece, la purga se corrió en la región equivocada |

- **Las llaves tardan 7 días en desaparecer.** Mientras tanto no cuestan, no se pueden usar y no impiden reinstalar con el mismo namespace.
- **Con `AuditLockMode` `COMPLIANCE`,** el bucket de auditoría no se puede vaciar hasta que venza la retención: la purga lo dice con el error de S3, sigue con lo demás y termina con error.
- **Si algo de lo listado no se pudo borrar,** la purga con `--confirm` termina con error y nombra lo que sigue en la cuenta («Could not be deleted, and still in the account»). Un final sin error significa que no quedó nada de lo listado.
- **Con qué se ha comprobado.** El guion de esta versión, con tests (`deployment/tests/test_purge_retained.py`, contra un `aws` simulado): todavía no se ha corrido en una instalación. Lo visto en una instalación es del 2026-10-07 y con el guion anterior, que borró las tablas, el directorio, el bucket de auditoría y los log groups, dejó los otros 3 buckets y las 7 llaves, y terminó sin error (ver «Problemas conocidos»).

## Problemas conocidos

| Síntoma | Causa |
|---|---|
| `Access Denied` al leer la `TemplateURL` o el código de una Lambda | La organización no está en la lista de clientes del proveedor, o se instala desde una cuenta de otra organización |
| El stack falla en una regla antes de crear nada | `ManagementAccountId` es la cuenta donde se instala `Core`; la región no es `us-east-1`; `ExcludedAccountIds` no incluye la cuenta de Mango |
| Un pack queda en error con `verify_tools` / `tools_response_invalid` justo al habilitarlo | Visto una vez al instalar dos packs a la vez: el Runtime recién creado respondió algo que no era la lista de tools. «Reintentar» lo resolvió. El log de `Mango-<ns>-PackProvisioner` registra la forma de la respuesta (`pack_provisioner.tools_response_invalid`) |
| El sha256 de la plantilla del StackSet no coincide con `MemberTemplateSha256` | Versiones hasta `v0.1.0-gb557f40`: una descripción con un carácter fuera de ASCII, que CloudFormation guarda como `?`. No cambia permisos. Se corrige actualizando `OrgAccess` a una versión posterior |
| Los cuatro stacks terminan bien y el agente de la versión no aparece en el Marketplace. La alarma `Mango-<ns>-AgentProvisioner-failed` está en `ALARM`; la versión del agente quedó fallida en el paso `check_harness`; el log `/aws/lambda/Mango-<ns>-Provisioner` trae `provisioner.harness_failed` con el motivo «Failed creating service linked role…» | Versiones hasta `v0.1.0-g998eb03`, instaladas en una cuenta que nunca usó AgentCore: el primer Runtime de la cuenta crea el rol vinculado al servicio `AWSServiceRoleForBedrockAgentCoreRuntimeIdentity` con los permisos de quien llama, y el provisioner no podía crearlo (D40, punto 5). Con una versión posterior no hay que hacer nada. En una anterior, quien administra la cuenta lo crea una vez, `aws iam create-service-linked-role --aws-service-name runtime-identity.bedrock-agentcore.amazonaws.com`, y un administrador de Mango reintenta la publicación desde la aplicación. Visto en una instalación de laboratorio el 2026-10-07; el arreglo está comprobado con tests, sin ver todavía en una instalación |
| `delete-stack` de `Core` termina en `DELETE_FAILED` y el único recurso fallido es `AWS::VerifiedPermissions::PolicyStore`: «The policy store cannot be deleted because deletion protection is enabled» | Versiones hasta `v0.1.0-g5bf4346`: el almacén de políticas nace con protección de borrado y la plantilla manda borrarlo. Quitarle la protección (`aws verifiedpermissions update-policy-store … --deletion-protection DISABLED`, con su modo de validación) y repetir el `delete-stack`: paso 5. Visto en una instalación de laboratorio el 2026-10-07, dos veces. Con una versión posterior el almacén nace sin protección (D58, punto 14) y actualizar a ella antes de desinstalar también lo evita; comprobado con tests, sin ver todavía en una instalación |
| `delete-stack` de `Core` falla a los pocos segundos en el recurso `Custom::MangoUninstallGuard`: «Uninstall guard failed (AccessDeniedException). Delete the stack again.». El stack sigue borrando lo que no depende de él (la API, las alarmas, los provisioners) y termina en `DELETE_FAILED`. Repetir el `delete-stack` falla igual | Versiones hasta `v0.1.0-g5bf4346`, con algún pack habilitado: el `UninstallGuard` borra el target del pack y no puede borrar su política Cedar. A su rol le faltaba `bedrock-agentcore:ManageResourceScopedPolicy` sobre el Gateway (D58, punto 13). Con una versión posterior no pasa (comprobado con tests, sin ver todavía en una instalación). **Cómo evitarlo:** deshabilitar los packs desde la aplicación antes de desinstalar; sin packs el guard no tiene ninguna política que borrar (así fue la primera desinstalación del 2026-10-07, que no falló aquí). **Si ya está atascado,** la aplicación ya no existe y el pack no se puede deshabilitar. Dos salidas. La que se probó (en una instalación de laboratorio el 2026-10-07): añadir a la política del rol `Mango-<ns>-UninstallGuard` solo esa acción sobre el ARN del Gateway de la instalación y repetir el `delete-stack`; el rol se borra con el stack. La que **no se ha probado**: borrar a mano las políticas de packs (las que se llaman `Mango_<ns>_mcp_…`; `aws bedrock-agentcore-control list-policies --policy-engine-id <id>` y `aws bedrock-agentcore-control delete-policy --policy-engine-id <id> --policy-id <id>`) y repetir el `delete-stack`. Las demás políticas del motor son de la plantilla: no se tocan |
| `purge-retained.sh --confirm` deja buckets con «objects still locked (COMPLIANCE retention)» y antes el error «x-amz-bypass-governance-retention is only applicable to Object Lock enabled buckets»; el apartado de llaves KMS sale vacío; termina sin error | El guion publicado hasta `v0.1.0-g5bf4346`: pedía saltar la retención en todos los buckets, y S3 lo rechaza donde no hay Object Lock; buscaba las llaves por alias, y los alias se borran con los stacks. Visto en una instalación de laboratorio el 2026-10-07: dejó 3 de 4 buckets y 7 llaves activas. Usar el guion de una versión posterior (comprobado con tests, sin correr todavía en una instalación). Con el anterior, a mano: vaciar cada bucket sin esa opción y borrarlo, y programar el borrado de cada llave activa que lleve la etiqueta `mango:namespace` de la instalación (`aws kms schedule-key-deletion --pending-window-in-days 7`) |
| `CannotPullContainerError` en `mango-api` | La cuenta no puede leer el repositorio de imágenes del proveedor (misma lista de clientes) |
