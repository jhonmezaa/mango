# D99 · `Core` se parte en stacks anidados: alarmas operativas, políticas Cedar y MCP remotos

- **Estado:** vigente
- **Fecha:** 2026-10-27 (elegida por el dueño ese día, por menú: «Anidar además algo grande de hoy»; y el bloque, «Cedar + alarms renamed»)
- **Precisa / reemplaza a:** precisa [D25](D025-recursos-creados-en-runtime.md) (las plantillas anidadas son plantillas pre-sintetizadas de la release), [D58](D058-distribucion-para-clientes.md) (qué publica una release y qué verifica quien instala), [D69](D069-assets-por-contenido-y-prefijo-unico.md) (nombre por contenido también para las plantillas anidadas), [D71](D071-alarmas-operativas-y-tablero.md) (nombres de las alarmas operativas y del tablero) y [D77](D077-tags-del-stack-en-lo-que-cloudformation-no-etiqueta.md) (el etiquetador lee los stacks anidados)
- **Precisada por:** —

## Decisión

Origen: el stack `Core` llegaba a 494 recursos con packs en la release (el test de packs, en modo laboratorio), y CloudFormation admite 500 por plantilla. La construcción de los MCP remotos (D93 a D98) añade más: el provisioner de remotos, el registro en `mango-api` y lo que venga después. El dueño eligió el 2026-10-27, por menú, «Anidar además algo grande de hoy»: un stack anidado para todo lo de MCP remotos y, además, mover a otro un bloque grande del `Core` de hoy, para dejar margen. Dijo que recrear recursos no importa en esta fase, siempre que no sean recursos con datos.

**(1) Tres stacks anidados en `Core`** (`AWS::CloudFormation::Stack`, con `NestedStack` de CDK):
- **`Operations`**: las alarmas operativas de D71 (28), su filtro de métricas y el tablero.
- **`Authorization`**: las políticas Cedar de la plataforma (`policies/cedar/platform/*.cedar`), una política estática del almacén de Verified Permissions cada una. El almacén, con su esquema, se queda en `Core`.
- **`RemoteMcp`**: lo que la construcción de los MCP remotos añade. Empieza con la política administrada de `mango-api` para los registros (`Mango-<ns>-ApiRemoteMcp`, de D98); el provisioner de remotos va después ahí.

Con esto la plantilla de `Core` de una release baja de 437 recursos a 381 (medido el 2026-10-27, sin packs), y la del test de packs, de 494 a unos 440. Un test exige que `Core` no pase de 450 recursos con packs.

**(2) Qué puede ir en un stack anidado.** Recursos sin datos: nada de tablas, buckets con datos, llaves que cifran datos, el user pool ni secretos. Un recurso que pasa de `Core` a un stack anidado se crea de nuevo en él antes de que CloudFormation borre el de `Core`.

**(3) Nombres nuevos para lo que se movió con nombre fijo.** Por (2), un recurso movido con el mismo nombre físico choca: la actualización falla con «ya existe» y se revierte (una alarma es peor: se crea encima y luego la limpieza la borra). Las alarmas operativas, su filtro y el tablero pasan a llamarse `Mango-<ns>-ops-<nombre>` (el tablero, `Mango-<ns>-ops`). Las alarmas de los demás constructs de `Core` (`Reconciler`, `Knowledge`, `Tasks`…) conservan su nombre. Las políticas Cedar no tienen nombre físico, y `Mango-<ns>-ApiRemoteMcp` nunca se instaló.

**(4) Cada stack anidado es una hoja.** Lee los recursos de `Core`, que CDK le pasa como parámetros de su plantilla, y `Core` no lee ninguna de sus salidas. Así ningún cambio de un anidado actualiza `Core`, y no hay dependencias en las dos direcciones. Por eso quedan en `Core` las piezas del Gateway que el propio Gateway lee: el interceptor `RESPONSE` y la llave que firma el catálogo de remotos. El provisioner de remotos leerá el Gateway; si el Gateway leyera el stack anidado, se esperarían el uno al otro. También queda en `Core` la copia de los perfiles firmados al bucket de packs, que usa la misma función de copia que los packs. Lo que `mango-api` lee de `RemoteMcp` son nombres armados (la máquina de estados y el alias de la llave), nunca salidas.

**(5) Las plantillas anidadas son de la release (D25).** Se sintetizan con la release y se publican como cualquier asset: en el bucket regional, en `mango/assets/<hash>.json`, con el nombre sacado de su contenido (D69). El `TemplateURL` de `Core` nombra esa clave. Una plantilla anidada que no cambia conserva su URL y CloudFormation no toca su stack.
- El manifiesto firmado las lista en `nested_templates` (archivo, stack padre, clave, sha256 y tamaño), además de en `assets`.
- `deployment/dist.py` termina con error si un stack anidado no sale de una plantilla de la release, si una plantilla anidada no la nombra ningún stack, o si una descripción nombra la etiqueta.
- `deployment/verify-release.py` las exige y comprueba su sha256, y comprueba que cada stack anidado de cada plantilla salga de una de ellas. Con `--bucket`, las descarga del bucket regional.

**(6) Lo que no cambia para quien instala.** Se crea y actualiza `Core` desde su URL, con las mismas capacidades (`CAPABILITY_NAMED_IAM`; no hace falta `CAPABILITY_AUTO_EXPAND`, que es para macros). CloudFormation lee las plantillas anidadas con las credenciales de quien opera, del bucket regional, que ya admite lectura por organización del cliente para el código de las Lambdas. CloudFormation llama a los stacks anidados `Mango-<ns>-Core-<id>-<sufijo>` y les da los tags del stack `Core`. Desinstalar `Core` los borra: el `UninstallGuard` depende de ellos y corre antes.

**(7) El etiquetador (D77) lee los stacks anidados.** Las políticas administradas de un stack anidado de `Core` reciben los tags de `Core`. La función recorre los stacks anidados que `ListStackResources` le da, solo si su nombre empieza por el de `Core` (`stack_not_of_this_installation` si no). Su rol puede leerlos (`stack/Mango-<ns>-Core-*`), y el custom resource espera a que termine el stack anidado que tiene una de esas políticas.

**(8) Lo que se recrea en la próxima actualización de una instalación.** Se crean las 28 alarmas operativas, el filtro y el tablero con los nombres nuevos, y se borran los de antes; las alarmas arrancan en `INSUFFICIENT_DATA` hasta su primer periodo. Se crean las políticas Cedar en `Authorization` y se borran las de `Core`. Mientras dura la actualización, cada política está dos veces en el almacén, con el mismo texto: Cedar da la misma respuesta. Nada con datos se mueve. `Mango-<ns>-ApiRemoteMcp` se crea por primera vez en `RemoteMcp`: estuvo en `Core` solo en `main`, entre D98 y este cambio, y ninguna versión publicada la llevó; una instalación de esa `main` chocaría con su nombre.
