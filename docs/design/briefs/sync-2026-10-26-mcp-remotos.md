# Contexto para Claude Design: MCP remotos de terceros, piloto Azure DevOps (2026-10-26)

Mango va a poder usar servidores MCP remotos de terceros. El primero es el de Azure DevOps. Cada persona conecta su propia cuenta de Microsoft y el agente lee Azure DevOps con los permisos de esa persona, **solo lectura**. Todavía no hay código: se construye después de este brief. Ninguna de estas pantallas está en el diseño. Este brief cuenta qué necesita el producto, qué textos lleva hoy de forma provisional y qué restricciones de seguridad no se pueden mover. Es contexto, no una especificación de pantalla: el diseño decide cómo se ve. Hasta que haya diseño, lo que falte queda en «Próximamente», sin datos de ejemplo (D24).

Las decisiones están en D93 (MCP remotos de terceros) y D94 (el consentimiento lo inicia el Gateway) de la arquitectura de referencia. El riesgo de los enlaces en el chat (sección 8) viene del modelo de amenazas `remote-mcp-threat-model.md`.

**Que sea general.** Azure DevOps es el piloto, pero el mismo flujo sirve para otros servicios (GitHub, Atlassian). Los textos llevan el nombre del servicio como variable (`{servicio}`); conviene que el diseño no dependa de Azure DevOps salvo en la ficha del perfil.

## 1. Cómo funciona, en corto

- **Perfiles, no URLs.** Mango trae en cada versión una lista cerrada de servicios remotos revisados y firmados («perfiles»). Un administrador **no** puede escribir una URL libre. El botón actual «Conectar MCP por URL» deja de tener sentido tal cual: lo que se habilita es un perfil.
- **Dos niveles de conexión.** (a) Un administrador registra el servicio para la empresa: la organización de Azure DevOps y una app de Microsoft Entra del cliente. Otro administrador lo aprueba. (b) Después, **cada persona** conecta su propia cuenta la primera vez que un agente lo usa. Mango nunca ve la contraseña de Microsoft: la persona inicia sesión en Microsoft.
- **Solo lectura.** Las tools de escritura no existen en ningún perfil.
- **Los datos salen de AWS.** El servidor corre en Microsoft. Esa marca se ve en el catálogo y en el agente.

## 2. Catálogo de MCP › «Servicios externos»

Hoy: el botón «Conectar MCP por URL» del catálogo, en «Próximamente», con el título «Solo admitirá autenticación OAuth: sin Access Key/Secret ni Basic Auth.».

Lo que hace falta:

- **Una sección o filtro de servicios externos** con los perfiles de la versión instalada. Cada uno lleva: nombre del servicio, quién lo opera (Microsoft), «Solo lectura», «Los datos salen de AWS», los conjuntos de tools que admite (toolsets: por ejemplo, work items, repositorios, wiki, pipelines, búsqueda) y su estado en la instalación.
- **La ficha del perfil**: qué tools trae (todas de lectura), qué permisos pide en Microsoft, el host fijo del servicio y los requisitos (una organización de Azure DevOps conectada a Microsoft Entra y una app registrada en Entra con permisos delegados de lectura y consentimiento de administrador).
- **Quién la ve.** Los creadores de agentes ven la ficha y el estado; solo los administradores ven y usan el alta. Lo decide el servidor.

### El alta en dos pasos

Es la misma familia de solicitudes que los packs: un administrador pide, **otro** aprueba.

**Paso 1, pedir (administrador).** Campos:

| Campo | Notas |
|---|---|
| Organización de Azure DevOps | Solo el nombre, no una URL. Letras, números y guiones, hasta 49 caracteres. El host lo pone el perfil |
| Tenant de Entra (`tenantId`) | Un GUID |
| Id de la app (`clientId`) | Un GUID |
| Secreto de la app | **Solo escritura.** Nunca se vuelve a mostrar, ni a quien lo escribió |
| Vencimiento del secreto | Entra los hace vencer; Mango avisa antes. Si el producto no lo puede leer de Entra, lo escribe el administrador (se fija al construir) |
| Toolsets | Elegir entre los que admite el perfil |
| Grupos que pueden usarlo | Solo las personas de esos grupos pueden conectar su cuenta y dar sus tools a un agente |

La respuesta del paso 1 trae la **URL de redirección** que el administrador tiene que pegar en la app de Entra (tipo Web). Hace falta un sitio para mostrarla con «Copiar», y que se pueda volver a ver mientras la solicitud está pendiente. Es la única URL que la interfaz enseña en todo este flujo, y la genera AWS, no el agente.

**Paso 2, aprobar (otro administrador).** Ve la organización, el `tenantId`, el `clientId`, los toolsets y los grupos. Nunca el secreto. Aprueba o rechaza.

Otras acciones:
- **Retirar** una solicitud propia y **rechazar** una ajena borran lo que se creó.
- **Cambiar el `tenantId` o el `clientId`** es una solicitud nueva, con su aprobación.
- **Rotar solo el secreto** no pide otra aprobación.
- **Deshabilitar** un registro activo.

Estados de un registro (nombres provisionales; se fijan al construir):

| Estado | Cuándo |
|---|---|
| Pendiente de aprobación | Pedido, falta el segundo administrador |
| Creándose | Aprobado; Mango crea la conexión (unos segundos) |
| Activo | Las personas de los grupos ya pueden conectar su cuenta |
| Falló | No se pudo crear. Texto provisional: «No se pudo habilitar {servicio}» · «Revisa los datos de la app de Entra y vuelve a pedirlo.» |
| Rechazado / Retirado | Historial |
| Deshabilitado | Un administrador lo apagó. Las conexiones de las personas dejan de servir |

Errores del alta que el producto va a responder (textos provisionales):

| Caso | Texto provisional |
|---|---|
| Organización con un formato no válido | «Escribe solo el nombre de la organización: letras, números y guiones.» |
| `tenantId` o `clientId` que no es un GUID | «Debe ser un identificador de Entra (un GUID).» |
| Ya hay un registro activo o pendiente de ese perfil y esa organización | «{servicio} ya está habilitado para esa organización.» |
| Quien aprueba es quien pidió | «Otra persona administradora tiene que aprobarlo.» |
| El perfil ya no está en la versión instalada | «Este servicio ya no está en esta versión de Mango.» |

## 3. Chat: la tarjeta «Conecta tu cuenta de {servicio}»

Cuando un agente usa por primera vez una tool remota y la persona no ha conectado su cuenta, el servicio responde que falta el consentimiento. Mango **le quita al agente la URL de consentimiento** (el agente solo sabe que falta conectar) y la entrega a la interfaz por un camino propio. Hace falta:

- **Una tarjeta fuera del texto del agente**, con «Conectar» y el nombre del servicio. Texto provisional: «Conecta tu cuenta de Azure DevOps» · «El agente necesita leer Azure DevOps con tu cuenta. Vas a iniciar sesión en Microsoft.»
- **Restricción:** la tarjeta la arma la interfaz con datos de `mango-api`, nunca con texto del modelo. Tiene que verse distinta de cualquier cosa que el agente pueda escribir en Markdown, para que un agente engañado no pueda imitarla (ver sección 8).
- **Vence a los 10 minutos.** Texto provisional al vencer: «El enlace venció» · «Vuelve a preguntar para conectar.» (O «Conectar» desde «Mis conexiones», sección 4.)
- **Después de conectar**, la persona vuelve a Mango (sección 5) y repite la pregunta. Que el chat retome solo la pregunta no está decidido: el producto, de entrada, muestra «Conectado. Vuelve a enviar tu pregunta.».
- El texto del agente en ese turno será algo como «Necesito que conectes tu cuenta»; el diseño decide si la tarjeta va dentro del mensaje, debajo o en un aviso aparte.

Lo mismo pasa en el **Playground** (D91): quien prueba un agente con tools remotas conecta su propia cuenta.

## 4. «Mis conexiones» (nuevo)

Una vista de cada persona con los servicios externos que puede usar (los de sus grupos) y el estado de su cuenta en cada uno. No existe ningún lugar parecido hoy; el diseño decide dónde vive (menú de la persona, perfil, otra entrada).

| Estado | Acción | Texto provisional |
|---|---|---|
| Sin conectar | «Conectar» | «No has conectado tu cuenta.» |
| Conectando | — | «Abriendo Microsoft…» |
| Conectado | «Desconectar» | «Conectado.» (si se puede, desde cuándo) |
| Servicio deshabilitado por la empresa | — | «Un administrador deshabilitó {servicio}.» |

- **«Conectar» sin chat:** `mango-api` hace una lectura mínima en nombre de la persona. Si ya estaba conectada, responde «Conectado» sin abrir Microsoft.
- **«Desconectar»** borra el token de esa persona. Está **sin probar** todavía (prueba P7 de D93): puede quedar en «Próximamente» en la primera versión.
- Mango nunca muestra el token ni datos de la cuenta de Microsoft más allá del estado.

## 5. La vuelta desde Microsoft

Después del login en Microsoft, el navegador vuelve a una ruta de Mango que cierra la conexión. Hace falta una pantalla corta (o un estado de «Mis conexiones») para cada resultado. Textos provisionales:

| Resultado | Texto provisional |
|---|---|
| Conectada | «Listo, tu cuenta de {servicio} está conectada.» · «Vuelve al chat y repite tu pregunta.» |
| Venció (más de 10 minutos) | «El enlace venció» · «Vuelve a pedir la conexión.» |
| Sin sesión de Mango en ese navegador | Pasa por el login de Mango y vuelve |
| La conexión era de otra persona (alguien compartió el enlace) | «Este enlace no es tuyo» · «Pide la conexión desde tu propia sesión.» Nunca dice de quién era |
| Microsoft no autorizó (canceló, el administrador de Entra no dio consentimiento, Acceso condicional) | «Microsoft no autorizó la conexión» · «Si no fuiste tú quien canceló, consulta con el administrador de Microsoft de tu empresa.» El Acceso condicional (P9) no se ha probado: puede necesitar un texto propio |
| Error inesperado | «No se pudo conectar tu cuenta» · «Inténtalo de nuevo en unos minutos.» |

## 6. Ajustes › Conectividad: registros y vencimiento del secreto

Hoy Conectividad tiene la conexión con AWS y la salud de las cuentas miembro. Hace falta un bloque para los servicios externos activos:

- cada registro con su organización, toolsets, grupos y estado;
- **el vencimiento del secreto** de la app de Entra, con un aviso antes de que venza (cuántos días antes, a definir con el producto; se sugiere 30 y 7) y otro cuando ya venció;
- «Rotar secreto» (campo solo escritura, sin aprobación) y «Deshabilitar».

Texto provisional al vencer: «El secreto de la app de Entra de {servicio} venció» · «Las personas no pueden conectar su cuenta hasta que lo rotes.» No está decidido si este aviso también va a la Bandeja de los administradores (sección 7).

## 7. Bandeja

- **Una tarea programada (D78) sin conexión** falla y deja en la Bandeja de su dueña o dueño: «Conecta tu cuenta de {servicio}» · «La tarea "{tarea}" no pudo leer {servicio} porque no has conectado tu cuenta.» con un enlace a «Mis conexiones». **Nunca lleva la URL de Microsoft** (la tarea corre sin la persona delante y la URL vence en 10 minutos).
- **Solicitudes de alta** pendientes para los administradores, como las de los packs.
- Duda abierta: el aviso del secreto por vencer (sección 6) ¿va también a la Bandeja?

## 8. La pregunta de P10: los enlaces que vienen de tools remotas

En la prueba en vivo, una página de wiki de Azure DevOps traía instrucciones escondidas. El agente no hizo lo que pedían, pero **copió en su respuesta la URL del atacante**. Con solo lectura el daño queda acotado, pero no el phishing: una respuesta del agente puede llevar un enlace que parece de confianza porque aparece dentro de Mango.

Lo que el chat hace hoy con cualquier enlace del agente:
- solo `http(s)`; el resto queda como texto;
- al pulsarlo, un diálogo: «Abrir enlace externo» · «Este enlace lo escribió el agente y te lleva fuera de Mango. Revisa la dirección completa antes de abrirla.» · «Abrir enlace»;
- las imágenes nunca se cargan («Imagen bloqueada»);
- no hay HTML crudo ni botones del modelo.

Lo que el producto puede saber y lo que no:
- **Sí sabe** si un turno usó tools remotas, y de qué servicio.
- **Sí sabe** el host de cada enlace y si es el host del servicio (por ejemplo, `dev.azure.com`).
- **No sabe** si un enlace concreto lo copió el agente de un resultado de una tool o lo escribió él. No se puede marcar enlace por enlace con certeza.

La pregunta al diseño: **¿cómo se muestran en el chat los enlaces de una respuesta que leyó contenido de un servicio externo?** Algunas posibilidades, sin imponer ninguna:
- un diálogo más fuerte para los turnos que usaron tools remotas, con el dominio destacado y el aviso de que el contenido viene de {servicio} y lo escribió alguien de fuera;
- distinguir los enlaces al host del propio servicio de los que van a otros dominios;
- una marca en el mensaje («Leyó Azure DevOps») que explique de dónde vienen los datos.

Restricciones que el diseño no puede mover:
- nada de HTML crudo ni de enlaces sin confirmar;
- la tarjeta de conexión (sección 3) no puede parecerse a nada que el agente pueda escribir;
- la interfaz no decide autorización: solo informa.

## 9. Agent Builder, Playground y Actividad

- **Agent Builder › Tools.** Las tools remotas aparecen junto a las de conectores y packs, con la marca del servicio, «Solo lectura» y «Los datos salen de AWS». Solo las ve quien está en los grupos del registro. Texto provisional si no está: «{servicio} no está habilitado para tus grupos.»
- **Grupos del agente.** Un agente con tools remotas puede compartirse con personas que no están en los grupos del registro: esas personas no pueden conectar su cuenta. Falta decidir si el Agent Builder lo avisa (y con qué texto) o si basta con el aviso en el chat.
- **Playground.** Como el chat (sección 3).
- **Actividad (D90).** Las llamadas a tools remotas se ven como las de cualquier tool, sin el contenido.

## 10. Qué no cambia

- El botón «Conectar MCP por URL» no vuelve con URL libre. Si se queda, es la entrada a los servicios externos con perfil.
- Nada de escribir en Azure DevOps: ninguna pantalla ofrece una acción de escritura.
- Los textos de error no revelan si una persona existe ni de quién era un enlace.
