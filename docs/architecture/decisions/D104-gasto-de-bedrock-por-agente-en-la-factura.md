# D104 · Gasto de Bedrock por agente en la factura: atribución por el rol de cada agente y conciliación diaria contra CUR 2.0

- **Estado:** vigente
- **Fecha:** 2026-11-03 (el mecanismo, las etiquetas, la conciliación contra CUR 2.0 en esta decisión, los ajustes de la pagadora como paso manual del runbook y el destino del export en la cuenta de Mango, elegidos por el dueño ese día, por menú; el grano agente × día con un contador nuevo, elegido ese día por menú por el agente que lanzó el trabajo; lo demás, propuesto por un agente durante el trabajo; aceptada por el dueño el 2026-11-03, por menú; 2026-11-04: seguir con Athena y Glue y pedir permisos de Lake Formation donde gobierna el catálogo, elegido por el dueño ese día, por menú; el log group que se borra en un primer create fallido, elegido por el dueño ese día, por menú; el parámetro `CatalogGovernedByLakeFormation`, elegido ese día por menú por el agente que lanzó el trabajo, punto 9; 2026-11-05: el export lo crea el stack `Payer` y las etiquetas siguen a mano, elegido por el dueño ese día, en el chat; borrar el export manual y que lo cree `Payer` en las instalaciones que ya lo tienen, elegido por el dueño ese día, por menú; el parámetro `CurExportBucket`, propuesto por un agente durante el trabajo, punto 10)
- **Precisa / reemplaza a:** precisa [D102](D102-inicio-gasto-por-dia-segun-el-rol.md) (1) (la transacción que cierra un turno suma también el contador del día de su agente), [D58](D058-distribucion-para-clientes.md) (el runbook de instalación gana un paso manual en la pagadora, y la desinstalación y la purga tratan un bucket nuevo) y [D76](D076-tags-del-stack-en-lo-creado-en-ejecucion.md) (los tags `mango:` de los roles de agente pasan a ser, además, la clave del costo en la factura). El punto 9 precisa D58 (7) (un log group de nombre fijo se borra si el create que lo creó se revierte) y suma a D58 un parámetro de `Core` y un paso previo del runbook. El punto 10 precisa el (4) de esta decisión (el export deja de ser un paso manual) y suma a D58 un parámetro de `Payer`
- **Precisada por:** [D106](D106-gasto-por-modelo-y-por-origen.md) (7) (la transacción que cierra un turno suma también los contadores del día de su modelo y de su origen)

## Decisión

Origen: el dueño preguntó si Mango usa perfiles de inferencia. Usa solo los **perfiles del sistema** entre regiones (`us.`/`global.`, los ids del catálogo de modelos). Los *application inference profiles* (AIP), etiquetados y creados por instalación, estaban «previstos» en §4.5, junto con la conciliación diaria contra CUR 2.0. El dueño pidió abrir esa decisión: ver el gasto de Bedrock por agente o por área en Cost Explorer y en CUR.

**(1) Lo que dice AWS (consultado el 2026-11-03).**

- **AIP** ([cost-mgmt-application-inference-profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html), [inference-profiles-create](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-create.html), [inference-profiles-prereq](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html)):
  - Se crea con `CreateInferenceProfile` copiando un modelo o un perfil del sistema (`modelSource.copyFrom`), con tags. Se invoca con su ARN `…:application-inference-profile/<id>` en lugar del id del modelo.
  - Solo sirve con `InvokeModel` y `Converse` en `bedrock-runtime`: Responses y Chat Completions lo rechazan con un 400.
  - Sus tags llegan a Cost Explorer y a CUR (clásico y 2.0) cuando se activan como etiquetas de asignación de costos. El grano más fino es tipo de uso × día.
  - Hay un perfil por cada combinación de modelo y juego de tags. La cuota es de 1.000 perfiles por cuenta y región, ajustable ([cuotas de Bedrock](https://docs.aws.amazon.com/general/latest/gr/bedrock.html)).
  - Para invocar hacen falta permisos sobre el AIP y sobre los modelos de cada región del perfil que copia.
- **Atribución por principal de IAM** ([cost-mgmt-iam-principal-tracking](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html)):
  - Bedrock anota en cada llamada el usuario o el rol que la hizo, sin cambios en la llamada y con cualquier API.
  - Las etiquetas del rol llegan a Cost Explorer y a CUR 2.0 (prefijo `iamPrincipal/`) cuando se activan como etiquetas de asignación de costos. Solo se activan en la cuenta de gestión (pagadora), no se aplican hacia atrás y tardan hasta 24 h.
  - El ARN del que llama (`line_item_iam_principal`) solo sale en un export CUR 2.0 creado con la opción de identidad del que llama ([blog de AWS](https://aws.amazon.com/blogs/machine-learning/introducing-granular-cost-attribution-for-amazon-bedrock/)).
- **Metadatos por petición** ([cost-mgmt-request-metadata](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-request-metadata.html)): solo quedan en los logs de invocación de modelos, que guardan los prompts. No llegan a la factura. Se descartan: el contenido de las conversaciones no va a logs operativos (`AGENTS.md`).
- **El harness de AgentCore** ([harness-models](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html); modelo de servicio de botocore 1.43.114):
  - `bedrockModelConfig.modelId` es un texto libre, sin patrón, y la documentación solo muestra ids de modelos y de perfiles del sistema.
  - Su formato por defecto, `converse_stream`, llama a `ConverseStream` en `bedrock-runtime` con el rol de ejecución del agente.
  - **Ningún documento dice si acepta el ARN de un AIP.** Un construct de CDK de AWS Labs (MDAA) lo rechaza en su propio código, porque sin el modelo de base no puede acotar los permisos. No es una regla del servicio. Solo una prueba en vivo lo diría.
  - La llamada del modelo auxiliar de `mango-api` (`Converse`) sí lo admite según la documentación.

**(2) El mecanismo: el rol de cada agente, ya (elegido por el dueño el 2026-11-03, por menú: «Rol por agente ya»).**

- **Atribución:** el gasto de Bedrock se atribuye por el principal de IAM que llama. Cada agente ya llama a Bedrock con su propio rol (`Mango-<ns>-agent-<id>`, D10), que el provisioner crea con los tags `mango:namespace`, `mango:component` y `mango:agent` (D76). El costo por agente sale de ahí, sin crear recursos.
- **Lo que no cambia:** el harness, el catálogo de modelos (D22, D38: los ids siguen siendo los de los perfiles del sistema y los precios siguen siendo datos), las versiones de los agentes, el provisioner (D25), la política de cada rol, el permissions boundary y el retiro o la desinstalación de un agente.
- **Sin migración:** los agentes que ya existen ya tienen su rol con sus tags.
- **Tres filas que no son de un agente:**
  - el Playground, con su rol de pruebas (`mango:agent` = `playground`);
  - `mango-api`, por los títulos con el modelo auxiliar;
  - la indexación de las knowledge bases, por los embeddings, con el rol que llama al modelo de embeddings.

  Llevan `mango:namespace` como todo recurso de la instalación.
- **Por persona o por área, no:** en la factura no se puede. El harness asume el rol del agente sin session tags de Mango, así que Bedrock ve el agente y no a quien pregunta. Esa vista sigue siendo la de Mango (D102: contadores por día de organización, área y persona).
- **Los AIP quedan previstos.** Lo que se pierde frente a ellos es la vista por área en la factura. Para retomarlos hace falta antes una prueba en vivo, fuera de la cuenta de un cliente:
  - crear un AIP que copie un perfil `us.` del catálogo;
  - invocar un harness de prueba con su ARN como `modelId`, en la creación y como override de `InvokeHarness`;
  - comprobar el permiso que pide su rol, la traza `chat <modelo>` y la métrica `ModelId`.

  La traza y la métrica importan porque el conciliador de D73 cuenta las trazas por el id del modelo.

**(3) Las etiquetas: `mango:agent` y `mango:namespace` (elegido por el dueño el 2026-11-03, por menú: «agent + namespace»).**

- Son las que se proponen activar como etiquetas de asignación de costos. Ya están en los roles: no hay tags nuevos.
- `mango:agent` lleva el id del agente, nunca un nombre ni un dato de una persona. El nombre lo da Mango.
- Los tags propios del cliente que el provisioner copia del stack (D76) llegan igual a los roles, y el cliente los activa si quiere.

**(4) Los ajustes en la pagadora son un paso manual del runbook (elegido por el dueño el 2026-11-03, por menú).**

- **Qué se hace:** activar las dos etiquetas y crear el export de (5).
- **Quién:** el cliente, en la consola de su cuenta de gestión, con la aprobación expresa del dueño en cada instalación. No los hace Mango.
- **El stack `Payer` no cambia:** no gana permisos de escritura de facturación.
- **Hasta que se haga:** la atribución existe en Bedrock, pero ni Cost Explorer ni CUR la muestran, y la conciliación de (7) no tiene nada que leer. Lo dice, como en (7).
- Un export creado antes de activar la opción de identidad no la gana: hay que crear otro.

**(5) El export CUR 2.0: recortado a Bedrock de la cuenta de Mango, en un bucket de la cuenta de Mango (conciliación en esta decisión y destino, elegidos por el dueño el 2026-11-03, por menú).**

- **Dónde llega:** la pagadora crea un Data Export CUR 2.0 con destino en un bucket nuevo de la cuenta de la instalación. La entrega entre cuentas existe desde abril de 2026 ([anuncio](https://aws.amazon.com/about-aws/whats-new/2026/03/aws-data-exports-cross-account-delivery-cost), [bucket de Data Exports](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-s3-bucket.html)).
- **Es otro export que el previsto en §4.10** para las preguntas de costos (de toda la organización): este solo sirve a la conciliación.
- **Opciones del export:** identidad del que llama, Parquet y actualización diaria.
- **Recorte en su propia consulta** ([consulta de Data Exports](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-data-query.html)): el gasto del resto de la organización no llega a la cuenta de Mango.
  - Un `WHERE` deja solo las filas cuya cuenta de uso es la de la instalación y cuyo producto es Bedrock.
  - Las columnas son las mínimas: día, cuenta de uso, producto, tipo de uso, costo sin descuentos, principal de IAM y etiquetas.
  - La lista exacta de códigos de producto de Bedrock se fija al construir, contra un export real: los modelos de terceros pueden facturarse con otro código que `AmazonBedrock`. Si una fila de Bedrock quedara fuera, la conciliación vería menos gasto en CUR que en Mango y lo marcaría.
  - El runbook trae la consulta tal cual. La configuración de un export no se puede cambiar después de crearlo.
- **El bucket:**
  - **Escritura:** su política solo deja escribir (`s3:PutObject`) al servicio `bcm-data-exports.amazonaws.com`, con `aws:SourceAccount` = la cuenta de gestión de la configuración (`managementAccountId`) y `aws:SourceArn` = sus exports (`arn:aws:bcm-data-exports:us-east-1:<cuenta de gestión>:export/*`: Data Exports vive en `us-east-1` aunque la instalación esté en otra región). Nadie más escribe; el servicio no lee ni borra. Propiedad de objetos `BucketOwnerEnforced`: los objetos que escribe el servicio son del bucket.
  - **Protección:** bloqueo de acceso público, solo TLS, sin ACL, versionado y logs de acceso, como los demás buckets.
  - **Cifrado:** una llave KMS propia de este bucket, nunca la llave de datos de la instalación: si el servicio de exports necesita usarla, su política se lo permite con las mismas condiciones de cuenta y ARN de origen, y eso no alcanza a ningún otro dato. Si Data Exports no puede escribir con una llave propia (se comprueba al construir), SSE-S3, registrado con su motivo.
  - **Vida:** los objetos caducan a los 400 días (13 meses de historia).
  - **Al desinstalar** se retiene y entra en la purga de D58, como los demás buckets de datos.

**(6) La lectura: Athena en la cuenta de Mango.**

- **Catálogo:** una base y una tabla de Glue que declara la plantilla (D25: nada se descubre ni se construye en ejecución), con proyección de particiones por periodo de facturación, sin crawler.
- **Grupo de trabajo:** `Mango-<ns>-cur`, que impone su configuración, un tope de bytes leídos por consulta y resultados cifrados en un prefijo propio que caduca a los 7 días.
- **No usa la API de Cost Explorer,** que se cobra por llamada.

**(7) La conciliación: agente × día, con un contador nuevo (el grano, elegido por menú el 2026-11-03 por el agente que lanzó el trabajo; el resto, propuesto por un agente).**

- **El contador nuevo, `DAY#AGENT#<id>`:** se suma a los contadores del día de D102 (1), en la misma transacción que cierra un turno (`settle` y `hold` en `mango-api`, `close` en el conciliador de presupuesto), con la misma SK (el día UTC en que empezó el turno). Va por el rol que llamó a Bedrock:
  - una prueba del Playground suma a `DAY#AGENT#playground`, aunque su presupuesto se cobre al agente probado;
  - una ejecución de una tarea (D78) suma a su agente.
- **La función `Mango-<ns>-CurReconciler`:**
  - corre una vez al día con Scheduler; es asíncrona, así que lleva DLQ y alarma;
  - con una consulta de Athena suma el costo de CUR por día y por rol de cada día cerrado de los últimos 35;
  - los días cerrados van hasta dos días atrás, porque CUR tarda hasta 24 h y revisa el mes;
  - cada rol `Mango-<ns>-agent-<id>` se compara con `DAY#AGENT#<id>`, y el total con `DAY#ORG`.
- **Desvío y alarma:** un desvío pasa de un umbral de configuración (por defecto, 10 % y USD 1 por agente y día). Cada pasada se audita (`cur.reconciled`) con conteos e importes, nunca personas. Si hay desvíos, se dispara la alarma `Cur-reconciler-findings`.
- **Comprueba el recorte en cada pasada:** si alguna fila no es de la cuenta de la instalación o de Bedrock, no concilia, audita `unexpected_rows` y alarma. Es la defensa si el export se creó sin su consulta (TM-CUR1).
- **Solo lectura**, como la reconciliación diaria de D41: no toca presupuestos ni contadores.
- **Gasto que Mango no anota por turno:** el guardrail y los títulos (D73 (15)), los embeddings y lo que se gastó antes de existir el contador. Se informa en su propia fila y no se compara.
- **Sin export o sin datos** (el paso manual de (4) no está hecho): la pasada lo audita como `no_data` y no alarma.
- **Las diferencias de precio** (descuentos, créditos, contratos) se leen del costo sin descuentos: Mango cobra con precios de lista del catálogo.

**(8) Los permisos nuevos** (modelo de amenazas: `cur-reconciliation-threat-model.md`):

- **La función:**
  - Athena: iniciar, leer y parar consultas solo en su grupo de trabajo.
  - Glue: leer su base, su tabla y sus particiones.
  - S3: leer el prefijo del export y leer y escribir el prefijo de resultados.
  - KMS: descifrar la llave de esos objetos, por S3.
  - DynamoDB: leer `Budgets`, solo las claves `DAY#AGENT#*` y `DAY#ORG` (`dynamodb:LeadingKeys` con `ForAllValues`, más la exigencia de que la clave venga en la petición: con la clave ausente, `ForAllValues` es verdadero).
  - Escribir su evento de auditoría y su métrica.
- **No hay rol nuevo entre cuentas ni cambios en la pagadora.** La única frontera nueva entre cuentas es la escritura del servicio de exports en el bucket, acotada por la cuenta y el ARN de origen.
- **`mango-api` y el conciliador de presupuesto no ganan permisos:** ya escriben los contadores del día (el conciliador, con `DAY#*`). La sesión por fila de cada persona (`USER#*`, `DAY#USER#*`) no alcanza `DAY#AGENT#`.

**Construido el 2026-11-04** (código y documentos; sin instalar ni ver en una instalación). Lo que se comprobó al construir y lo que se eligió:

- **El contador:** `DAY#AGENT#<id>` se suma en la misma transacción que cierra el turno (`settle`, `hold`, `close`; `mango_core.budget_turns`), con el campo nuevo `cost_agent` del turno pendiente: el agente del turno, `playground` en el Playground y su agente en una tarea (D78). El título de una conversación nueva no suma al agente: lo genera `mango-api` con su rol. Un turno pendiente escrito antes no lo tiene y no suma al agente. Sin permisos nuevos: `mango-api` ya escribe `Budgets` entero y el conciliador de presupuesto ya tiene `DAY#*`; la sesión por fila de cada persona solo nombra `USER#<sub>` y `DAY#USER#<sub>` (un test lo fija).
- **El cifrado del bucket es SSE-S3, no una llave propia.** AWS lo dice: Data Exports entrega con SSE-S3, y para SSE-KMS hay que cifrar después de la entrega ([protección de datos de Data Exports](https://docs.aws.amazon.com/cur/latest/userguide/data-protection.html), consultado el 2026-11-04). Así lo preveía (5); sin llave, la función no gana permisos de KMS para S3.
- **La consulta de un export sí se puede editar después de crearlo**; la configuración de la tabla, no ([consulta de Data Exports](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-data-query.html)). Corrige lo que decía (5): quitar el recorte no exige otro export. Por eso pesa más la comprobación de cada pasada (`unexpected_rows`).
- **Dónde vive:** el bucket, con datos, en `Core` (D99 (2)); la base y la tabla de Glue, el grupo de trabajo, la función, su programación (grupo `Mango-<ns>-cur` de Scheduler, con su rol acotado al ARN del grupo), su cola de errores y sus dos alarmas, en un stack anidado nuevo, `CurReconciliation`, que es una hoja (D99 (4)). Sus alarmas salen en el tablero de Operaciones por nombre. `Core` gana 3 recursos.
- **Qué se compara:** solo las filas `Usage` de tokens de modelo (los tipos de uso de entrada, salida y caché que da la guía de CUR de Bedrock), a precio de lista (`pricing_public_on_demand_cost`). Lo demás de Bedrock (un guardrail, aunque lo facture el rol del agente) va a la fila sin atribuir, como los tokens de otros roles (los títulos de `mango-api`, los embeddings) y lo de antes del contador. El total de tokens se compara con `DAY#ORG` desde el día siguiente a su primer día; los agentes, desde el día siguiente al primer `DAY#AGENT#` que se ve (ese día puede ser parcial). El rol se lee del ARN del rol o de su sesión (`assumed-role/<rol>/<sesión>`).
- **La configuración** (códigos de producto y umbrales) está en `release-defaults.json` (`curReconciliation`), como los precios (regla 7); la instalación puede traer la suya. Los códigos `AmazonBedrock` y `AmazonBedrockService` están por confirmar contra un export real, como el tipo de las columnas en el Parquet.
- **Pendiente para instalar:** el paso manual en la pagadora del runbook (`install.md`, «Gasto de Bedrock por agente en la factura»), con la aprobación del dueño.

**(9) Bajo Lake Formation (2026-11-04).** La instalación de `v0.1.0-gbe0e5d2` en la cuenta de un cliente se revirtió. `AWS::Glue::Database` falló con «Insufficient Lake Formation permission(s): Required Create Database on Catalog». La cuenta tiene Lake Formation gobernando el catálogo: los permisos por defecto de bases y tablas nuevas no traen `IAM_ALLOWED_PRINCIPALS`, y quien despliega, con `AdministratorAccess` de IAM, no es administrador de Lake Formation. El rollback dejó dos recursos retenidos, el bucket del export y el log group de nombre fijo de la función, y el segundo hacía fallar el reintento.

- **Sigue con Athena y Glue y pide los permisos de Lake Formation (elegido por el dueño el 2026-11-04, por menú).** No se pasa a leer el Parquet directamente.
- **Lo que dice AWS (consultado el 2026-11-04):**
  - Crear una base exige `CREATE_DATABASE` sobre el catálogo. Sin ubicación en la base, o con una no registrada, basta ([referencia de permisos](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-reference.html)).
  - Quien crea una base tiene `CREATE_TABLE`, `ALTER` y `DROP` sobre ella, y puede concederlos. Quien crea una tabla tiene todos los permisos sobre ella y puede concederlos dentro de su cuenta ([permisos implícitos](https://docs.aws.amazon.com/lake-formation/latest/dg/implicit-permissions.html)).
  - `SELECT` sobre una tabla deja leerla con la API de Glue y consultarla. Con la ubicación sin registrar, el acceso a S3 lo dan los permisos de IAM de quien consulta, y `lakeformation:GetDataAccess` solo hace falta para datos registrados ([Athena y Lake Formation](https://docs.aws.amazon.com/athena/latest/ug/lf-athena-user-permissions.html)).
  - Athena pide `DESCRIBE` sobre la base `default` ([limitaciones](https://docs.aws.amazon.com/athena/latest/ug/lf-athena-limitations.html)). Por eso la consulta lleva el contexto de su base.
  - `AWS::LakeFormation::PrincipalPermissions` concede con `GrantPermissions` al crearse y revoca al borrarse ([plantilla](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lakeformation-principalpermissions.html)).
  - `RetainExceptOnCreate` retiene como `Retain`, salvo cuando se revierte la operación que creó el recurso: entonces lo borra ([DeletionPolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)).
- **El parámetro `CatalogGovernedByLakeFormation` de `Core` (`false` por defecto; elegido el 2026-11-04 por menú por el agente que lanzó el trabajo).**
  - **Con `true`,** el stack anidado `CurReconciliation` concede al rol `Mango-<ns>-CurReconciler` `SELECT` y `DESCRIBE` sobre `mango_<ns>_cur.bedrock`, sin opción de concesión. Lo concede quien despliega, por ser el creador de la tabla.
  - **Con `false`,** la plantilla es la de antes y decide IAM.
  - **Por qué un parámetro:** no se puede detectar. Las condiciones de una plantilla no leen ajustes de la cuenta, y una función que concediera tendría que ser administradora del data lake. Además, no está comprobado que la concesión funcione sin gobierno de Lake Formation cuando quien despliega no es administrador.
  - **Ningún rol de Mango es administrador del data lake.** La plantilla no cambia los ajustes del data lake, no da permisos sobre el catálogo ni sobre la base, y no registra el bucket. La función no gana permisos de IAM.
- **El único paso manual:** un administrador de Lake Formation del cliente da `CREATE_DATABASE` sobre el catálogo al rol que despliega `Core`. Lo explica el runbook (`install.md`, «Lake Formation y el catálogo de Glue»), con cómo comprobar si Lake Formation gobierna el catálogo y cómo verificar el permiso. Es un cambio en la cuenta del cliente, con su aprobación.
  - **Mismo rol después:** los permisos de creador son de ese rol, así que las actualizaciones y la desinstalación las hace el mismo. Si cambia, el runbook da lo que el administrador concede al nuevo.
- **Un primer create fallido no deja nada que bloquee el reintento (elegido por el dueño el 2026-11-04, por menú; precisa D58 (7)).**
  - **El log group:** `/aws/lambda/Mango-<ns>-CurReconciler`, de nombre fijo, pasa a `RetainExceptOnCreate`. Al desinstalar se retiene como cualquier log.
  - **El bucket del export** sigue `RETAIN`. Su nombre lo pone CloudFormation, así que no bloquea: el reintento crea otro. El que queda está vacío y se borra a mano o con la purga.
  - **El resto del stack anidado** no tiene nada retenido.
  - **La base que nunca existió** deja el anidado en `DELETE_FAILED` («Required Drop») si quien despliega no tiene el permiso. El runbook dice cómo limpiarlo.
- **Sin ver en una instalación:**
  - que Lake Formation acepte el ARN de un rol de IAM Identity Center, que lleva ruta;
  - la concesión de la plantilla y la primera consulta bajo gobierno;
  - que el log group no quede retenido si el anidado se creó entero y lo que se revirtió fue otro recurso de `Core`.

  Tampoco está cubierto un catálogo cifrado con una llave KMS propia: la función no tiene permiso sobre ella. El runbook manda comprobarlo antes de instalar.

**(10) El export lo crea el stack `Payer`; las etiquetas siguen a mano (2026-11-05; precisa (4)).** Al hacer el paso manual en la cuenta de un cliente, la consola de Data Exports no dejó escribir el `WHERE`: solo elige columnas. El export tuvo que crearse por API (`aws bcm-data-exports create-export`), con el bucket de la cuenta de Mango como dueño (`S3BucketOwner`), y quedó `HEALTHY`.

- **El export lo crea `Payer` (elegido por el dueño el 2026-11-05, en el chat):** un `AWS::BCMDataExports::Export` con el nombre `mango-<ns>-bedrock`. La consulta, la configuración de la tabla y el destino salen de la versión y de los parámetros del stack, no de quien instala:
  - **la consulta:** las columnas de la tabla de Glue y el `WHERE` de (5), con la cuenta de Mango (`MangoAccountId`) y los códigos de producto de la versión (`curReconciliation.bedrockProductCodes`, regla 7: la misma lista que acepta la función);
  - **la tabla:** CUR 2.0 diaria con la identidad del que llama (`INCLUDE_IAM_PRINCIPAL_DATA`);
  - **el destino:** el bucket de `Core` en la cuenta de Mango, prefijo `cur`, Parquet, sobrescribir, actualización diaria.
- **Las etiquetas siguen a mano (elegido por el dueño el 2026-11-05, en el chat):** activar `mango:agent` y `mango:namespace` es un clic del runbook, del tipo «IAM principal» (en el cliente se activó primero el de recurso por error). `Payer` no gana un custom resource ni `ce:UpdateCostAllocationTagsStatus`: sigue sin roles ni permisos de escritura de facturación.
- **El parámetro `CurExportBucket` de `Payer` (propuesto por un agente durante el trabajo):** vacío por defecto, y vacío no crea nada. `Payer` se instala antes que `Core` (D79) y Data Exports comprueba el bucket al crear el export, así que el export llega con una actualización de `Payer` después de `Core`, con el output `CurExportBucket`. Solo admite el vacío o un nombre de la forma del de `Core` (`mango-<ns>-core-curexportbucket…`), y el dueño del bucket es siempre la cuenta de Mango. Con el parámetro dado, una regla exige `us-east-1`. No es una elección del dueño: el nombre del bucket lo pone CloudFormation y fijarlo reemplazaría un bucket con datos.
- **Lo que dice AWS (consultado el 2026-11-05):**
  - [`AWS::BCMDataExports::Export`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bcmdataexports-export.html) admite `S3BucketOwner`, la configuración de la tabla anidada y una `QueryStatement` libre, con `WHERE`. Cambian sin reemplazo la consulta, la configuración de la tabla (para CloudFormation), el destino y la descripción; **el nombre y la cadencia exigen reemplazo** ([propiedades](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bcmdataexports-export-export.html)). Data Exports no deja cambiar la configuración de la tabla de un export que existe ([consulta](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-data-query.html)): una versión que la cambiara necesita otro nombre, y con él otra carpeta.
  - El esquema del tipo en el registro de CloudFormation (descargado de `schema.cloudformation.us-east-1.amazonaws.com`) pide para crearlo `bcm-data-exports:CreateExport`, `GetExport`, `ListTagsForResource`, `TagResource` y `cur:PutReportDefinition`; para actualizarlo, `UpdateExport`, `TagResource`, `UntagResource`; para borrarlo, `DeleteExport`. Su identificador es el ARN, así que admite importar. El tipo está en el esquema de `us-east-1` (y de `us-west-2`), no en el de `eu-west-1`, `us-east-2` ni `sa-east-1`.
  - Crear un export de CUR 2.0 exige además `cur:PutReportDefinition`: una SCP que lo niegue lo bloquea ([IAM de Data Exports](https://docs.aws.amazon.com/cur/latest/userguide/bcm-data-exports-access.html)).
  - Borrar un export no borra los objetos ya entregados en S3 ([borrar exports](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-delete.html)).
- **Borrado:** el export se borra con el stack, o al vaciar el parámetro (`DeletionPolicy` `Delete`): no es un dato, y sin Mango no hay nada que exportar. Los archivos entregados siguen en el bucket de `Core`, que se retiene (5).
- **Las instalaciones que ya lo crearon a mano: se borra el manual y lo crea `Payer` (elegido por el dueño el 2026-11-05, por menú).** Los nombres de Data Exports son únicos: con el manual en pie, `Payer` fallaría y se revertiría. El nuevo escribe en la misma carpeta, así que la tabla de Glue sigue leyendo lo entregado; puede quedar un día sin entrega, que la pasada audita como `no_data`. Importar el manual en `Payer` queda como alternativa sin probar en el runbook. Es un cambio en la cuenta del cliente, con su aprobación.
- **Lo que cambia en los permisos:** ningún rol de Mango cambia. El principal que instala o actualiza `Payer` necesita los de Data Exports y `cur:PutReportDefinition` (modelo de amenazas v0.4, TM-CUR10 y TM-CUR11).
- **Sin ver en una instalación:** el export creado por `Payer`, su primera entrega y el reemplazo del manual.

