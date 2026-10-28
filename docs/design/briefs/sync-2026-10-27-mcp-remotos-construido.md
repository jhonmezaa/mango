# Contexto para Claude Design: MCP remotos ya construidos (2026-10-27)

El producto ya construyó los MCP remotos de terceros (piloto Azure DevOps) según las rondas 22 y 23. Están apagados por defecto hasta probar el Acceso condicional (P9). Al construir aparecieron diferencias con el diseño y textos que faltan. Es contexto, no una especificación de pantalla: actualiza el diseño y HANDOFF.md con lo que corresponda.

## 1. «Desconectar» (D97)

La prueba del 2026-10-27 mostró que el producto sí puede borrar la conexión de una sola persona. «Desconectar» ya funciona en el producto, pero el botón sigue en «Próximamente» porque falta el texto.

Lo que pasa al pulsarlo:
- Mango borra la conexión de esa persona al instante. Deja de leer con su cuenta en el chat, en sus tareas y en el Playground.
- **No** revoca nada en Microsoft. El texto no debe decir que Microsoft quitó el permiso.
- Para volver a conectar hay que iniciar sesión en Microsoft otra vez.
- Si un agente usa el servicio después, el chat ofrece «Conectar», como a quien nunca se conectó. Una tarea de esa persona falla y la Bandeja le avisa.
- Si el producto no puede confirmar que se borró, responde un error (`disconnect_not_confirmed`). Falta su texto.

## 2. El alta y la ficha del servicio

- **«URL de redirección»:** no es una URL de Mango. Es la URL de callback que da AWS al crear la conexión, distinta para cada registro, y el administrador la pega en su app de Entra. El ejemplo del diseño (`https://api.mango.empresa.com/oauth/…`) confunde.
- **«Permisos en Microsoft»:** no es `user_impersonation`. Son los permisos de la app «Azure DevOps MCP» (delegados, de lectura) más `offline_access`. La ficha muestra lo que dice el perfil del servicio.
- **Nombres de tools y de grupos de tools:** los reales son `wit_work_item`, `wiki`, `search_wiki`, `pipelines_build`… Salen del perfil, así que los del diseño no deberían parecer fijos. En la v1 hay cinco grupos: proyectos, work items, wiki, pipelines y búsqueda de código. Quedan fuera los adjuntos y los artefactos.
- **Descripción, «Requisitos» y descripción de cada permiso:** el diseño los muestra, pero el perfil del servicio no los trae. Hoy la ficha no los muestra. Se pueden añadir al perfil, si el diseño los quiere.
- **«Cambiar tenant o app»:**
  - todas las personas tendrán que conectar su cuenta otra vez, y el diseño no lo avisa;
  - el formulario muestra los grupos de tools y los grupos de personas, pero no deja editarlos: esa solicitud solo cambia tenant, app y secreto.
- **«Deshabilitar»** borra la conexión y el secreto. «Pedir de nuevo» exige escribir el secreto otra vez.

## 3. Lo nuevo que no tiene diseño

- **Cambiar los grupos de tools o los grupos de personas de un servicio activo.** Es una solicitud con doble aprobación, como el alta, y no obliga a nadie a reconectar. El producto la tiene, pero la web no la muestra.
- **Aviso al compartir un agente fuera de los grupos del servicio.** Si el agente se comparte con personas que no están en los grupos del servicio, ellas lo usan sin esas tools. El producto genera el aviso `remote_audience_outside_groups`.
- **Quien guarda una versión con tools de un servicio y no está en sus grupos** (`remote_not_usable`): hoy sale como «La versión no cumple una regla de publicación». Falta el texto en el Builder y en la revisión.
- **Builder:** el catálogo del Builder no trae los grupos de un servicio para quien no está en ellos. Por eso la fila «no está habilitado para tus grupos» no aparece.

## 4. La vuelta desde Microsoft (`/conexiones/vuelta`)

- **Sin sesión,** la web la muestra a pantalla completa, fuera del marco de la aplicación, y sin nombrar el servicio, porque sin sesión no sabe cuál era.
- **Si la persona recargó la página** o el inicio de sesión de Mango la sacó y la devolvió, el dato de la vuelta se pierde y la web dice «El enlace venció». Falta confirmar ese texto o dar uno como «Vuelve a pulsar Conectar».
- **Falta un estado «terminando la conexión»,** mientras el producto cierra el consentimiento.
- **Si la persona cancela en Microsoft,** no se sabe todavía qué devuelve: falta probarlo en vivo.

## 5. Tarjeta «Conecta tu cuenta» (chat y Playground)

- Falta el estado de error al pulsar «Conectar». Hoy sale un texto rojo bajo el cuerpo.
- Faltan los textos de `identity_unavailable` (el servicio de identidad de AWS no responde) y de `rate_limited`.
- En la Bandeja, el aviso de una tarea que necesita conexión (`remote_connect`) se ve como una ejecución fallida si el servicio ya no está en «Mis conexiones» de la persona.

## 6. «Leyó {servicio}» y el diálogo de enlaces

- Se clasifica cada enlace: de una organización registrada que la persona puede usar, de otra organización del mismo servicio o de otro dominio. Solo se usan las organizaciones de los servicios de esa persona, no todas las de la empresa.
- El Builder marca todo servicio externo con «Los datos salen de AWS».

## 7. Pendiente de la ronda 23

- **Playground, `skills_unavailable`:** el diseño dice «La prueba corre igual, sin ellas», pero el producto no corre la prueba sin las skills de la versión. El texto que hace falta es del tipo «La prueba no puede correr sin ellas. Inténtalo de nuevo en unos segundos.».
- **Popover «Qué puede usar {agente}»:**
  - no muestra latencia ni salud de los MCP, porque no hay de dónde sacarlas;
  - no está dibujado el error de carga;
  - el contador del botón muestra «–» hasta abrirlo;
  - el aviso de skill no aprobada no tiene plural;
  - «Abrir en el Agent Builder» queda dentro del cuerpo del aviso.
