# Contexto para Claude Design: lo que dejó la ronda 22 en MCP remotos (2026-10-26)

La ronda 22 dibujó todo el brief de MCP remotos (`sync-2026-10-26-mcp-remotos.md`) con las respuestas del formulario. El producto todavía no construye nada de esto: espera el backend de D93 y D94. Antes de construir hacen falta los puntos de abajo. El primero es de seguridad. Es contexto, no una especificación de pantalla: actualiza el diseño y HANDOFF.md con lo que corresponda.

## 1. «Dominio de {servicio}» tranquiliza de más (seguridad)

Hoy el diálogo reforzado del enlace marca con una insignia neutra «Dominio de {servicio}» todo enlace a `dev.azure.com`, a `visualstudio.com` o a cualquier subdominio suyo. Pero cualquiera puede crear su propia organización en `dev.azure.com/{otra-organización}` o en `{otra-organización}.visualstudio.com`. Por eso un enlace con el host del servicio puede venir de un atacante. Es justo lo que pasó en la prueba P10: el agente copió en su respuesta la URL que puso alguien de fuera.

Lo que el producto puede saber:
- el host normalizado del enlace;
- **la organización** de la ruta (`dev.azure.com/{org}/…`) o del subdominio (`{org}.visualstudio.com`);
- las organizaciones registradas en la instalación.

Propuesta, sin imponer la forma:
- **Solo un enlace a una organización registrada** se presenta como del servicio, por ejemplo «Tu organización de {servicio} ({org})».
- **Otra organización del mismo host** se trata como un dominio externo: el host destacado, el aviso de no escribir datos de la cuenta y «Cancelar» como botón principal.
- **Ninguna insignia debe leerse como «seguro»:** la interfaz informa, no garantiza.

## 2. Estados del registro que faltan

- **«Creándose»:** desde que se aprueba hasta que la conexión existe, unos segundos.
- **«Falló»:** texto provisional «No se pudo habilitar {servicio}» · «Revisa los datos de la app de Entra y vuelve a pedirlo.».
- **Historial de solicitudes rechazadas y retiradas:** hoy desaparecen de la lista. Sirve para saber quién pidió qué y por qué se rechazó.

## 3. Playground

Falta la tarjeta «Conecta tu cuenta de {servicio}» en el Playground. HANDOFF.md la deja pendiente con el mismo patrón que el chat. Quien prueba un agente con tools remotas conecta su propia cuenta.

## 4. Acceso condicional

Cuando el Acceso condicional de Microsoft bloquea el login (dispositivo no administrado, ubicación, MFA), la vuelta desde Microsoft cae hoy en «Microsoft no autorizó la conexión». Hace falta un texto propio que diga que lo bloqueó una regla de la empresa y a quién preguntar. Esta parte todavía no se ha probado (P9), así que el texto es provisional.

## 5. El proveedor como variable

El pie de «Mis conexiones» dice «Microsoft» escrito a mano («Al conectar vas a iniciar sesión en Microsoft…»). Debería ser el proveedor del perfil, como en la tarjeta y en la vuelta, para que sirva igual con GitHub o Atlassian.

## 6. «Conectar» cuando ya estaba conectado

Desde «Mis conexiones», si la cuenta ya estaba conectada, el producto lo confirma sin abrir Microsoft. Hoy el diseño no dibuja ese caso: falta el mensaje, por ejemplo «Tu cuenta ya estaba conectada.».

## 7. Lo que sigue pendiente del brief anterior

Siguen pendientes los puntos de `sync-2026-10-26-playground-skills.md`:
- los textos de error del Playground;
- la tool que falló en la traza;
- «pack no instalado»;
- el botón del aviso de cambios en otra pestaña;
- el panel en móvil;
- qué hace el botón «Skill» del chat.

Ninguno cambió en la ronda 22.
