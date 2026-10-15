# D76 · Lo que Mango crea en ejecución lleva los tags del stack

- **Estado:** vigente
- **Fecha:** 2026-10-14 (el punto 1, decidido por el dueño ese día, por menú; los puntos 2 a 7, propuestos por un agente y aceptados por el dueño ese día, por menú; lo que mostró la primera instalación, punto 8, nota propuesta por un agente)
- **Precisa / reemplaza a:** precisa [D25](D025-recursos-creados-en-runtime.md) (lo que se crea por SDK lleva también los tags del stack)
- **Precisada por:** [D77](D077-tags-del-stack-en-lo-que-cloudformation-no-etiqueta.md) (precisa: lo que CloudFormation no puede etiquetar también lleva los tags del stack)

## Decisión

Origen: la primera instalación en la organización de un cliente (2026-10-14). El cliente pone un tag de proyecto en todos sus recursos, y lo pone como se pone cualquier tag de costo: en los stacks, al desplegar. CloudFormation se lo da a todo lo que declara la plantilla. Los agentes y los MCP packs no están en la plantilla: los crean los provisioners por SDK (D25), y hasta ahora llevaban solo los tags de Mango. El dueño pidió que el tag llegue a todos los recursos aunque ninguna política del cliente lo exija.

**(1) La regla (decidida por el dueño el 2026-10-14, por menú: «Copiar los tags del stack»).** Los dos provisioners copian los tags del stack `Core` a todo lo que crean: el rol de IAM de un agente o de un pack, el harness y su endpoint `live`, el Runtime de un pack y su endpoint, y los log groups de los Runtimes. El cliente etiqueta una sola vez, al desplegar, con los tags que quiera: no hay parámetro nuevo. Es lo que ya hace CloudFormation con lo que la plantilla declara, llevado a lo que la plantilla no puede declarar.

- **Las opciones del menú:** copiar los tags del stack, o dejar solo los tags de stack por ahora. En un menú anterior, que se canceló, había una tercera, un parámetro nuevo de `Core` con los tags; el dueño preguntó por qué hacía falta un cambio si CloudFormation ya hereda los tags, y la respuesta fue esta decisión: solo los hereda lo que la plantilla declara.

**(2) Qué no se copia (propuesto por un agente y aceptado por el dueño el 2026-10-14).** Los tags `aws:` (los reserva AWS) y `mango:`, con mayúsculas o sin ellas: IAM compara las claves de los tags sin distinguir mayúsculas, así que `Mango:Namespace` también es de Mango. Los de Mango los ponen los provisioners con su valor, y las condiciones de IAM de la instalación los leen (`aws:RequestTag/mango:namespace` y `aws:RequestTag/mango:component` al crear harness y Runtimes, TM-M1): un tag del stack no puede cambiarlos. El runbook ya pone `mango:namespace` y `mango:component` en los stacks: no se copian, y lo creado lleva los de Mango.

**(3) Un tag que un servicio no acepta detiene el paso (propuesto por un agente; el dueño eligió el 2026-10-14, por menú, «Falla con un código» frente a «Lo omite y sigue»).** AgentCore acepta menos caracteres que IAM y CloudWatch Logs: letras y dígitos ASCII, espacios y `_ . : / = + - @`, hasta 128 en la clave y 256 en el valor. Un tag del stack fuera de eso, o dos claves que solo difieren en mayúsculas (IAM las toma por la misma y rechaza el rol), hace fallar la publicación de un agente o la habilitación de un pack con el código `stack_tag_invalid`, en vez de quedarse fuera en silencio: un recurso sin un tag que el cliente pidió es un hueco que nadie notaría. Lo mismo con más de 50 tags en un recurso (`stack_tags_too_many`): los de Mango son 3, así que caben hasta 47 del cliente. Se corrige en el stack (un `UpdateStack` con los tags corregidos) y se reintenta.

**(4) Cómo los leen (propuesto por un agente y aceptado por el dueño el 2026-10-14).** Con `cloudformation:DescribeStacks` sobre su propio stack: el id llega en la variable `MANGO_STACK_ID` (`AWS::StackId`), y la función se niega a arrancar si no es el `Core` de su instalación (región, cuenta y namespace). Es el único permiso nuevo de los dos roles, sin comodines. Cada contenedor lo lee como mucho una vez cada 5 minutos: un cambio de tags del stack llega en ese plazo a lo que se cree después. Un fallo pasajero al leerlo (límite de tasa) se reintenta como cualquier otro paso; un permiso denegado detiene el paso.

**(5) Lo que ya existe no se reetiqueta (propuesto por un agente y aceptado por el dueño el 2026-10-14).** Un agente o un pack creados antes de cambiar los tags del stack conservan los que tenían: AgentCore no recibe tags al actualizar un harness o un Runtime, así que republicar no los cambia. Un log group que AgentCore crea antes que el provisioner se adopta con los mismos tags que uno creado por él.

**(6) Lo que no lleva tags aunque se quiera (propuesto por un agente y aceptado por el dueño el 2026-10-14; para los presupuestos de una tool de escritura, el dueño eligió por menú «No, son del cliente» frente a «Sí, también»).**
- **Los targets del Gateway y las políticas Cedar de un pack:** AgentCore no admite tags en ellos.
- **Lo que crea AWS por su cuenta:** los roles vinculados a servicios, las interfaces de red (Fargate, Lambda, endpoints de VPC, AgentCore) y los log groups de toda la cuenta (`aws/spans`, `/aws/application-signals/data`).
- **Lo que crea una tool de escritura aprobada,** como un presupuesto: es un recurso del cliente, hecho a pedido de una persona, no de Mango. Sus tags los deciden los argumentos de la tool.
- **Sin ver todavía:** si el Runtime que AgentCore crea para un harness, y la identidad de workload de un Runtime, heredan los tags del harness o del Runtime. Se mira en la primera instalación con esta versión. **Visto el 2026-10-14** (punto 8): los heredan.

**(7) Con qué se comprobó.**
- **Tests:** `functions/provisioner/tests/test_stack_tags.py` (qué se copia, los dos límites, la lectura cada 5 minutos, los errores, el id del stack; y que un agente y un pack publicados de punta a punta llevan los tags del stack en el rol, el harness o el Runtime, su endpoint y sus log groups). En la plantilla, `infra/test/provisioner.test.ts` y `infra/test/packs.test.ts`: la sentencia `ReadInstallationStackTags` (solo `cloudformation:DescribeStacks`, solo sobre `AWS::StackId`, la única de CloudFormation del rol) y la variable.
- **Al actualizar una instalación:** en `Core`, el `Modify` de la política de los roles `Mango-<ns>-Provisioner` y `Mango-<ns>-PackProvisioner` (una sentencia más cada uno) y de las dos funciones (una variable más). Medida sin packs, la política en línea del provisioner de packs pasa de 28 a 29 sentencias; con unos 170 caracteres más resuelta, su margen frente a los 10.240 de IAM baja de un 15 % a un 13 % (D43 (8)).
- **Sin ver en una instalación:** todo lo anterior.

**(8) Lo que mostró la primera instalación con D76 (nota del 2026-10-14, propuesta por un agente).** No cambia lo decidido: dice con qué se ha comprobado. Una instalación nueva de `v0.1.0-g7765bdf` en la cuenta de un cliente, con un tag de proyecto en los cuatro stacks.
- **Lo creado en ejecución lleva los tags del stack:** el rol, el harness y sus endpoints, y los dos log groups del Runtime del agente de la versión, que el provisioner creó mientras `Core` se instalaba.
- **AgentCore los pasa del harness al Runtime que crea para él y a su identidad de workload:** la API de etiquetas los listaba con el tag del proyecto y los de Mango. Era lo que el punto 6 marcaba «sin ver».
- **Todo lo que declara la plantilla lleva el tag:** los 180 recursos que la API de etiquetas lista con el `mango:namespace` de la instalación en la cuenta de Mango, los 31 roles de IAM de esa cuenta y los 2 de la cuenta de gestión, y el StackSet de `OrgAccess`. En las cuentas miembro no se pudo leer: quien instaló no tenía acceso a ellas.
- **Lo que quedó sin ningún tag,** porque CloudFormation no puede etiquetarlo: las 3 políticas administradas de IAM, los recursos por defecto de las 2 VPC y las 59 reglas de los security groups. Es D77; desde la actualización a la versión que lo trae, los llevan (D77, punto 10).
- **Sin ver todavía:** un agente o un pack creados después de instalar, y un tag que AgentCore no acepta en una instalación.

