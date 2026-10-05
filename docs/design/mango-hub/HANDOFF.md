# Mango — Handoff

Prototipo interactivo de una plataforma interna de agentes de IA (AWS Bedrock + Cognito + MCP). Todo el texto está en español. HTML + React sin build: cada `.jsx` se carga con `<script type="text/babel">` y exporta a `window`. Entrada única: **`Mango.html`**.

Datos de ejemplo neutros: "Usuario N", `usuarioN@empresa.com`, iniciales `UN`, cuentas `111111111111`…, OUs `ou-xxxx-…`. Sin IPs, sin claves.

## Archivos

```
Mango.html               entrada
styles.css               tokens y componentes
src/
  store.js               store global (useMango), audit log encadenado, cambios con doble aprobación, políticas de tools
  data.js                datos de ejemplo (agentes, threads, tickets, MCP, skills, schedules, evals)
  lifecycle.js           catálogo MCP, revisiones de agentes, grupos, validaciones
  i18n.js / markdown.js  textos ES/EN parciales, render de markdown
  icons.jsx system.jsx ui.jsx charts.jsx avail.jsx
  shell.jsx              sidebar + topbar; menú de cuenta con "Cerrar sesión"
  login.jsx              login, registro, verificación, recuperación, MFA, SSO, pantalla sin acceso
  app.jsx                router por vista, estado de agentes, panel Tweaks
  dashboard.jsx marketplace.jsx share-agent.jsx chat.jsx tickets.jsx admin.jsx (Agent Builder)
  agent-review.jsx mcp-catalog.jsx models-view.jsx skills.jsx knowledge.jsx schedules.jsx
  evals.jsx eval-create.jsx playground.jsx observability2.jsx costs2.jsx activity.jsx search.jsx
  approvals.jsx policies.jsx audit-budgets.jsx groups-admin.jsx people.jsx settings.jsx other-views.jsx
  gov/                   kit.jsx, data.js, mango-data.js, budgets.jsx (usuarios y valores por defecto), areas.jsx, propose.jsx, connectivity.jsx
```

## Reglas del producto implementadas

- **Rol**: viene de la cuenta (grupo de Cognito): "FinOps central" o "Líder de área" (con su área), más la marca "Admin" para administradores. No se elige en la UI; el panel Tweaks lo cambia solo para revisar. El engranaje de Ajustes del topbar solo lo ven admins. Idioma y "Primeros pasos" son Próximamente.
- **Errores**: sin conexión se reintenta al volver la red (sin guardado offline); error inesperado ofrece recargar o ir al chat; 403 indica que un admin puede dar acceso; el request_id solo se muestra si lo devuelve el servidor.
- **Login**: correo y contraseña; registro solo con el dominio de la empresa; verificación por código antes del primer ingreso (vence en 24 h); "Olvidé mi contraseña" con código (vence en 1 h); alta de MFA en el primer ingreso cuando es obligatorio (QR, secreto para copiar y primer código); MFA (app autenticadora) si está activo; contraseña y MFA no se cambian desde la cuenta: "Olvidé mi contraseña" o un admin; "Continuar con SSO" si hay IdP; una cuenta sin grupo ve "Todavía no tienes acceso". Los errores no revelan si un correo existe.
- **Cambios con doble aprobación** (`MangoStore.changes`, `propose` / `decideChange` / `withdrawChange`, `onDecide[kind]`; UI común `window.ChangeList`). Un admin propone y otro distinto aprueba; estados pendiente, aprobado, rechazado. Se usa en:
  - Ajustes › Autenticación: MFA, duración de sesión, IdP (User Pool, región y app client en solo lectura). En instalaciones de clientes MFA solo puede ser "Obligatorio"; si se intenta aprobar otro valor, el sistema lo rechaza y lo registra.
  - Restablecer el MFA de un usuario (`kind: 'mfa_reset'`): al aplicarse borra su MFA, cierra sus sesiones y en el próximo ingreso lo configura de nuevo. Nadie restablece el suyo.
  - Ajustes › Acceso de admins a conversaciones (desactivado por defecto; cada lectura va a Auditoría).
  - Compartir agentes (usuarios o grupos del directorio; toda la organización solo admin y nunca con Datos de cuentas).
  - Grupos de acceso: crear, cambiar tipo o área, eliminar.
  - Skills: cada versión nueva; los agentes siguen con la anterior hasta aprobarse.
  - Políticas de aprobación por tool de escritura.
  - Áreas y OUs (propio de `gov/areas.jsx`, mismo patrón).
- **Agentes**: se publican con aprobación de otro admin. No se eliminan ni archivan: un admin los **retira** y se conserva el historial. Modelo por defecto + modelos permitidos en la versión aprobada (el chat solo muestra esos). Presupuesto en solo lectura en el Builder; lo cambian admins en Presupuestos. Los agentes nuevos arrancan con el límite por defecto.
- **Aprobaciones humanas**: ninguna tool de escritura se ejecuta sin confirmación. Cada una tiene su política (siempre, monto, cantidad de recursos o entorno; aprobadores; vencimiento). Por debajo del umbral confirma el propio usuario en el chat con la tarjeta «¿Ejecutar esta acción?» (`approval.self_confirm`); por encima, N aprobadores distintos de quien la pidió (quien la pidió ve «Aprobar» deshabilitado). Lo vencido se rechaza solo (`approval.expire`). `window.approvalTier(tool, params)` decide el tramo; si falta el dato o no se puede interpretar, usa el tramo de aprobadores.
- **Schedules**: corren con la identidad y permisos de quien los creó; se pausan solos si esa persona pierde el acceso al agente. Solo el dueño edita, ejecuta ahora o reanuda; un admin que no es el dueño solo pausa o retira. No se eliminan. Entrega a Slack: Próximamente.
- **Skills**: las creadas en la app son solo instrucciones; las que incluyen scripts vienen instaladas con Mango y no se editan. Duplicar crea una propuesta (v1 pendiente de otro admin).
- **MCP**: único conector de Mango disponible: Cost Explorer; el resto Próximamente. Drive y Confluence son "Datos internos". Los packs de escritura muestran sus permisos de escritura.
- **Observabilidad**: sin acceso a conversaciones solo metadatos (agente, usuario, duración, tokens, costo, tools). Evals: la fuente "Conversaciones reales" requiere ese acceso y su uso se audita.
- **Ajustes**: log group, retención y X-Ray en solo lectura; Billing sin plan ni tope (los límites viven en Presupuestos); sin webhooks ni claves de terceros.

- **Organización de agentes**: "Reporta a" y "Rol" se definen en el Agent Builder (sección Organización, obligatorios al enviar; no se puede elegir a sí mismo ni a un subordinado). Van en la revisión, en el diff de versiones y al publicar. Un agente nuevo no puede enviarse sin elegir supervisor; el respaldo `manager || 'platform'` de `app.jsx` y `lifecycle.js` (`snapOf`) es solo para agentes publicados antes de que existiera el campo. Delegación A2A (KPIs, «Delegaciones recientes», «Delegar vía A2A») es Próximamente: no hay backend ni acción de permiso.
- **Nombre del agente**: «FinOps» en todas las vistas (sidebar, chat, historial, placeholder, Presupuestos, login).
- **Markdown del agente** (fuente única: `styles.css` `.md`; `markdown.js` solo emite etiquetas/clases): tablas al 100 % y 12 px, solo bordes horizontales, cabecera sin fondo en gris, columnas numéricas (todas las celdas son cifras, montos o %) alineadas a la derecha con cifras tabulares; títulos 18/15/13 px; código en mono. Todo se escapa. Enlaces solo http/https y abren el diálogo «Abrir enlace externo»: dominio (host) en negrita y, debajo, la URL completa en mono (defensa contra dominios parecidos); imágenes → «[Imagen bloqueada]».
- **Chat FinOps**: sugerencias «Gasto del mes», «Top 5 servicios», «Pronóstico de fin de mes», «Anomalías de la semana». Descripción y capacidades (Costos y uso, Áreas y OUs, Pronósticos, Anomalías, Savings Plans) y «1 MCP server» salen de lo que el agente consulta. Estados: historial cargando (esqueleto con role="status", igual que el de la conversación), vacío «Aún no tienes conversaciones.», error «No se pudo cargar el historial.» con «Reintentar»; conversación con error «No se pudo cargar la conversación» + Reintentar / Nueva conversación. Toasts: «Respuesta completa · El agente terminó de procesar tu solicitud.» al terminar una respuesta y «Nueva conversación iniciada.» al empezar una. La duración de las tools solo se muestra si se midió en esta respuesta (`measured`); en conversaciones cargadas no.
- **Login**: carrusel con botón «Pausar»/«Reanudar» (la etiqueta cambia; sin aria-pressed); puntos con patrón de pestañas completo (tab + tabpanel enlazados con aria-controls, flechas con vuelta, Inicio/Fin, solo el punto activo en el orden de tabulación); se detiene con hover, foco dentro y «reducir movimiento». Tras verificar el correo pasa directo a configurar MFA (si está activo), sin volver a iniciar sesión.
- **Sistema**: 404 (role="status", no alert) «Página no encontrada» · «La dirección no existe o ya no está disponible.» · «Volver al chat». El error inesperado muestra solo `RENDER_ERROR`, nunca el mensaje interno.
- **Conectividad**: si falla la API de la prueba, banner «No se pudo ejecutar la prueba» y se conserva el último resultado.

## Disponibilidad ("Próximamente")

Tweaks → "Ver disponibilidad actual". `MangoStore.AVAILABLE` = chat (solo FinOps), budgets (valores por defecto, por agente, por usuario), audit, settings (General › Autenticación, Áreas y OUs, Conectividad), login. En ese modo, solo FinOps aparece fijado (sin quitarlo), el selector de modelo y "Más opciones" del chat son Próximamente, la lista de conversaciones no muestra vista previa ni no leídos, el chat no ofrece acciones de escritura ni tickets (Aprobaciones es Próximamente), Presupuestos es solo para admins (la cuenta "FinOps central" sin Admin no lo ve); FinOps usa el límite por defecto (sin presupuesto propio); "Alertas activas" está disponible con los agentes en alerta y su %; "Por equipo" es Próximamente y sin equipos de ejemplo. Ajustes › General › Autenticación está disponible: datos de solo lectura, políticas y Restablecer MFA; "Proponer cambio" de MFA, sesión e IdP es Próximamente (hoy se configuran al instalar) y no se muestran propuestas de ejemplo; las demás secciones de General y la pestaña Grupos son Próximamente. El Audit log muestra eventos de presupuestos (de FinOps), áreas, cuenta, accesos y consultas a FinOps; no muestra "Contraseña creada" ni "MFA configurado" (esos pasos van directo al proveedor de identidad y aún no se registran). Lo demás aparece deshabilitado con la etiqueta; con el interruptor apagado las vistas muestran su diseño completo con datos de ejemplo.

## Tweaks (solo revisión)

Disponibilidad · cuenta de ejemplo (admin, creador, usuario) · "Admin que revisa" (Usuario 6, para aprobar propuestas propias) · estado de la cuenta (con o sin grupo) · MFA · IdP · tipo de instalación · estados del chat (cargando, vacío, error de historial, error de conversación) · resultado de Conectividad (error de chequeo, falla de API, límite) · vista 404 · tema · densidad · errores simulados.

## Notas para migrar

- Vite + React + TypeScript; convertir `window.X` en imports; quitar `?v=N` de `Mango.html`.
- Regla de `useMango(selector)`: devolver primitivos o referencias del state (nada de `.filter`/`.map` dentro).
- Reemplazar datos de ejemplo por Cognito, Bedrock, MCP reales y el audit log del backend.

- **Chat**: compositor con límite de 4.000 caracteres (error y envío bloqueado al pasarlo, sin contador); una respuesta cancelada conserva el texto parcial y muestra aparte "Respuesta detenida."; conversaciones agrupadas en Hoy, Ayer, Esta semana y Anteriores (más de 7 días).
- **Presupuestos (disponible hoy)**: editar el límite de FinOps y "Nuevo presupuesto" son Próximamente (FinOps usa el límite por defecto); KPIs muestran "—".
- **Áreas y OUs**: un área necesita al menos una OU para poder enviar la propuesta.
- **Audit log**: solo admins; sin encadenamiento por hash en el texto ni sección "Integridad" en modo disponibilidad.
- **Chat angosto**: botón "Conversaciones" (≤1100 px) abre el historial como panel lateral; el selector de modelo pierde la etiqueta Próximamente cuando no cabe.

- **Cabecera del chat**: el engranaje solo lo ven admins; "+" abre una conversación nueva; a ≤900 px las acciones pasan a un menú; las etiquetas "Próximamente" se ocultan de forma progresiva a 1000, 860 y 640 px.
- **Audit log · lecturas**: interruptor "Mostrar lecturas" (apagado por defecto). Apagado oculta los accesos de solo lectura permitidos (`access.view`, `read: true`); los accesos denegados (`access.denied`) y los cambios se ven siempre. Lecturas y denegados muestran la acción de permiso registrada, no la pantalla: recurso `audit.view` "Ver auditoría", `admin.view` "Ver administración", `agent.invoke` "Usar agente" (`AUDIT_PERMS`); si se quiere "Abrió Presupuestos", hay que definir el nombre de pantalla por acción. Abrir el Audit log registra `audit.view` permitido o denegado. "Mostrar más" va sin contador (paginación por cursor).
- **Audit log · chat**: `chat.query` = "Consulta del agente"; el actor es quien hizo la pregunta y el agente (`fin-01`) es el recurso; el detalle incluye tools consultadas y costo. La autorización de uso del agente de cada turno (`agent.invoke`) se agrupa dentro del evento (sección "Autorización"); si se deniega, queda aparte como "Acceso denegado" y se ve siempre.
- **Rol "Líder de área · Admin"** (`lead_admin`): admin que además lidera un área.
- **Contraseña**: mínimo 14 caracteres, con mayúsculas, minúsculas, números y símbolos (los cinco obligatorios). Cuentas creadas por un admin con contraseña temporal ven "Crea tu contraseña" en el primer ingreso (nueva + confirmación, sin código) y luego el MFA si aplica. Tweak: estado de la cuenta › "Contraseña temporal".
- **Política de uso de IA**: `authCfg.aiPolicyUrl`, se define por instalación (solo lectura en Autenticación). Si está vacía, el registro no pide aceptarla. El enlace abre en otra pestaña.
- **Restablecer MFA**: el usuario se escribe como correo. Si la API responde que no existe, se muestra «Ese correo no está en el directorio» bajo el formulario (decisión 2026-09-30: endpoint solo para admins autenticados, con permiso y auditoría; los admins ya ven correos en Auditoría y Presupuestos). En login, registro y recuperación sigue vigente no revelar si un usuario existe. En el prototipo existen usuario1–9@empresa.com; casilla obligatoria "Verifiqué la identidad del usuario por otro canal"; vence a las 72 h sin aprobación. Estados: Pendiente, Aprobado, Rechazado, Retirado (se conserva al retirarla) y Vencido.
- **Carrusel del login**: sin cifras, hashes ni lista de agentes de ejemplo; la diapositiva de presupuestos solo menciona el bloqueo al 100 %.


## Alineación con la web (sep 2026)
- Login · carrusel: las tres diapositivas viven en el DOM (las no visibles con `hidden`), cada una con id `login-slide-N` para el `aria-controls` de su punto. El panel es `role="region"` con `aria-roledescription="carrusel"` y nombre «Qué puedes hacer con Mango».
- Ajustes › Restablecer MFA: estado de error cuando la lista de solicitudes no carga → «No se pudo completar la acción. Inténtalo de nuevo.» (role="alert"). En el prototipo: panel de demo «Lista de restablecimientos MFA · Error al cargar».
- Audit log: campo `outcome` (requested/applied/rejected) + `error` que registra la API. Detalle: fila «Resultado» en la sección Evento («solicitado», «aplicado», «no se aplicó · CÓDIGO»). Lista: mismo sufijo tras el detalle. CSV: columna `resultado`. Eventos sin outcome no muestran la fila.
- Ajustes › Autenticación › Identity provider (SSO): se muestra el nombre del proveedor configurado en la instalación (`authCfg.idpName`), no el protocolo. Valores: `none` / `sso`.
- Chat: se quitó «Cargar mensajes anteriores»; la API devuelve la conversación completa.
- Audit log: la búsqueda incluye el texto del resultado y el código de error. CSV: las celdas que empiezan por =, +, - o @ llevan un apóstrofo delante (evita inyección de fórmulas).
- Restablecer MFA: si aprobar, rechazar o retirar falla, el error se muestra entre el formulario y la lista (role="alert"): 409 (cambió o ya cerrada) y 410 (venció) → «La solicitud ya no está pendiente: otro admin la decidió o venció.»; cualquier otro fallo → «No se pudo completar la acción. Inténtalo de nuevo.». Tras un 409/410 la lista sigue mostrando la solicitud como pendiente hasta recargar (comportamiento aceptado). Los errores de validación del formulario también llevan role="alert". Demo: «Aprobar/rechazar/retirar MFA».
- Login · carrusel: ilustraciones con aria-hidden; cada tabpanel lleva su título en .sr-only; el eslogan visible bajo los puntos va con aria-hidden.
- Restablecer MFA: editar el correo borra cualquier error del envío (correo inexistente, cuenta propia, solicitud pendiente, genérico). Mientras aprobar/rechazar/retirar está en curso, los botones de esa solicitud quedan deshabilitados.
- Presupuestos: aria-valuenow de las barras de consumo se limita a 100; el porcentaje visible muestra el valor real.
- Marketplace › Activos (tarjetas agrupadas): cuando se muestra «Fijados», los agentes fijados se excluyen de los grupos por categoría (contadores ajustados; grupos vacíos no se muestran). Con filtros o búsqueda no hay grupo «Fijados» y cada agente aparece una vez.


## Alineación con el producto · agentes, MCP, grupos (oct 2026)
Modo por defecto: **Disponible hoy** (panel de demo › «Ver disponibilidad actual»). Muestra lo que existe en el producto y marca el resto «Próximamente»; «Diseño completo» conserva la visión. Cada estado nuevo tiene su control en el panel de demo.

**Vistas, roles y grupos**
- `AVAILABLE` suma marketplace, admin, review, org, models, mcp. Org Chart está en `USER_VIEWS`: lo ve todo el mundo (admins y creadores, árbol completo; el resto, solo agentes que puede usar).
- Etiqueta de rol según grupo: «Admin» (mango-admin), «Creador de agentes» (mango-agent-creator), «Usuario» (resto); los grupos se listan debajo en el menú de usuario. Cuenta de demo nueva: creador sin rol FinOps (`mango-agent-creator · people`).
- Agent Builder: lo tiene quien está en mango-agent-creator o es admin. Catálogo de MCP en el menú también para creadores.
- Grupos reales: mango-admin, mango-agent-creator, finops-central, bu-lead (sistema), bu-<área>, y los que defina la instalación. No hay grupo de toda la organización. El acceso de un agente nuevo empieza vacío.

**Revisión de agentes**
- ≤760 px: lista de la cola a ancho completo; al tocar una fila se abre el detalle con «Volver a la cola» y el pie fijo abajo. El historial pasa a filas apiladas.
- Ids `<id del agente> · v<versión>`. Revisor por correo; decisiones antiguas muestran el identificador interno.
- Diff completo: categoría, ícono, color, modelos permitidos, aprobación en cada uso, usuarios, tokens por llamada, temperatura, y «otros cambios» para cualquier campo sin sección. Sin presupuesto (sección «límites»). Sin evals ni insignia «N problemas» en la cola. Sin «Datos internos». Modelo por identificador. Tool fuera del catálogo: solo «No habilitada».
- Estados: cargando, error con Reintentar, sin acceso (página), reglas sin evaluar, «ya no está en revisión», errores al decidir en el pie, «aprobación registrada · la publicación no arrancó». Publicación fallida: «Falló en «publication_expired»» + Reintentar (45 min).

**Agent Builder**
- Secretos: nunca se repite el valor; solo tipo y campo (instrucciones, descripción, nombre, rol). Aplica en ambos modos.
- Regla por tool: solo bloquean las tools que responden por toda la organización (insignia «Solo grupos centrales»). Las que filtran por usuario (Cost Explorer) se pueden compartir con áreas. Tools de ese tipo + personas sueltas: no se puede enviar. Nuevo campo «Personas» en Acceso.
- Errores del servidor con texto propio (16 casos). «No se pudo guardar» al guardar borrador.
- Presupuesto fuera de la versión; no admins ven «—» sin enlace. Tokens: si el valor actual no está entre las opciones (FinOps 8.000) se indica y se conserva. Nuevos campos: tokens por llamada y temperatura. Plantillas solo rellenan identidad e instrucciones. Categoría fuera de la lista se muestra como un segmento más.
- ≤560 px: barra superior con «Enviar» y menú «⋯» (Guardar borrador, Cancelar).
- Publicación fallida: «Reabrir como borrador». Duplicar: aviso persistente en el Builder en vez de toast.

**Catálogo de MCP**
- Modo de datos de cuentas: «Solo centrales» (AWS Billing, 9 tools) o «Por usuario» (Cost Explorer), en fila, detalle, solicitudes y tabla de tools.
- Servicio de AWS requerido (Compute Optimizer, Cost Optimization Hub): Mango no consulta si están activados. Insignia «Requiere Compute Optimizer» por tool (catálogo y Builder) y aviso en el detalle: se activan aparte en la cuenta pagadora y Mango no lo comprueba.
- Estado «Deshabilitando»; deshabilitar no despublica: los agentes responden sin esas tools y las recuperan sin revisión.
- «Retirar solicitud» para habilitación, parámetros y actualización. «Pedir actualización a X» cuando la release tiene versión nueva.
- Instalación: solo «Instalando» (sin sub-pasos). Tools de packs sin descripción. Salud de MCP: Próximamente.
- Errores: cambio de modo de identidad, genérico. (Sin error de lista de salida de red: los packs corren en una red propia sin salida a internet.)

**Marketplace**
- Sin estado, tickets ni insignias de compartido. Presupuesto solo admins y solo agentes con gasto (+ FinOps). «Más usados» deshabilitado; «Mayor gasto» solo ordena para admins; «Relevancia» = nombre. Filtro de estado y «Más»: Próximamente.
- «Retirado · motivo». Detalle sin skills, owner, versiones ni salud; herramientas como id del conector + tools. «Compartir»: Próximamente (se cambia en el Builder con una versión nueva).
- Editar/Duplicar: solo admins y quien creó el agente. **Requiere que la API entregue el creador del agente.**
- Carga y error con Reintentar. Retiro: limpieza de infraestructura en curso / fallida (visible para admins).

**Chat**: varios agentes; sin punto de estado; capacidades solo para FinOps; sin sugerencias de relleno; «Crear nuevo agente» solo para quien puede crear. Estados: sin agentes, agente no disponible, retirado (caja deshabilitada + enlace al Marketplace), tools faltantes por MCP deshabilitado, tool solo para centrales. Fijado por defecto: solo FinOps.

**Grupos y Conectividad**: miembros «—»; nombres reservados, tipo fijado por el nombre (bu-*), no cambiar un grupo propio, máximo 100; vencen a las 72 h. `bu-lead` es de tipo general (sistema, transversal): la regla «bu- = de área» no le aplica. Conectividad › Cuentas miembro: «Exige la identidad» es una sola fila (se comprueba en el rol intermedio, vale para todas); por cuenta solo el rol de lectura.

**Brains**: no admins → sin acceso. Modelos que la instalación no conoce: sin contexto ni uso de tools, «Sin precio». Uso 30 días: «Sin datos». Catálogo nunca consultado (nombres = identificador). Toast con modelos nuevos. Precios hasta USD 100.000 por millón y 4 decimales, coma decimal (el punto solo separa miles), segundo error de rango. Precios de caché proporcionales a la entrada. «Agentes que lo usan» cuenta modelos permitidos. «Sin acceso» = Bedrock no lo listó. Filtros de estado con desplazamiento horizontal ≤760 px. Errores del servidor en el pie.

**Auditoría**: detalle de turnos de chat con versión del agente y modelo. Permiso «Ver grupos». Eventos nuevos del ciclo de vida (publicación iniciada/fallida, reintentada, reabierta) y de modelos (catálogo consultado).

**Org Chart**: ≤760 px el panel va debajo del lienzo y la barra hace salto de línea. Árbol filtrado para usuarios; agentes con supervisor no visible cuelgan de un nodo «Supervisor no visible». La raíz se marca como «no es un agente». Sin puntos de estado; leyenda, «Con alertas», panel (estado, modelo, compartido, presupuesto, datos y permisos) y Costos: Próximamente. Delegación: tarjeta Próximamente, sin filas. «Nuevo agente» solo para quien puede crear. Singular «1 subordinado». +/−/0 no se interceptan con ⌘/Ctrl/Alt.

## Ronda de cierre con el producto (2026-10-02)
Decisiones del usuario: mandan los límites del producto (100 grupos, precio de modelo hasta USD 100.000, `bu-lead` general).

**Chat y menú**
- Caja que reemplaza al compositor: sin `aria-disabled` (dejaba inaccesible «Ir al Marketplace»).
- Cabecera del chat: en «Disponible hoy» sin punto «En línea», igual que el hero.
- «+» del topbar: abre el selector si hay más de un agente; con uno solo, abre su chat.
- Quitar de fijados (×) en el sidebar también en «Disponible hoy».
- Estado nuevo «No se pudieron cargar tus agentes» + Reintentar (demo: Chat · agente › Error al cargar agentes). Sin compositor.
- Cuenta de demo nueva «Usuario · finops-central» (central sin permiso de crear → «Usuario»).

**Org Chart**: «Supervisores» no cuenta el nodo «Supervisor no visible». Raíz: «Raíz · no es un agente» (cabe en 196 px).

**Agent Builder y Revisión**
- Presupuesto (admins): «Límite propio del agente» cuando lo tiene; si no, «Límite por defecto · hoy todos los agentes usan el mismo».
- Tokens por llamada fuera de las opciones: «Actual… se conserva si no eliges otro».
- «Personas» por correo (creadores y admins): el chip guarda el usuario del directorio y muestra su correo (en el prototipo se guarda el correo). Cada búsqueda audita `directory.lookup` («Búsqueda en el directorio»). Errores: «Ese correo no está en el directorio», «Hiciste demasiadas búsquedas. Espera un momento e inténtalo de nuevo.», «No se pudo buscar el correo. Inténtalo de nuevo.», «Puedes compartirlo con 50 personas como máximo» (demo: Builder · Personas por correo).
- Revisión de agente nuevo: conserva la fila «Modelos permitidos».
- Tras «la publicación no arrancó» y «ya no está en revisión» la cola no se recarga sola, para que el aviso se lea.
- Aviso de Duplicar («Copia de …»): dura esa visita al Builder; no se guarda el origen de la copia.

**Catálogo de MCP y Marketplace**
- Marketplace: el modelo se muestra por identificador; los nombres solo para creadores y admins.
- «Qué queda afectado» al deshabilitar: solo agentes publicados.
- Limpieza al retirar: «Limpiando» / «Limpieza falló», solo para admins y solo en agentes que pueden usar. Si la limpieza no arrancó, tras recargar no se sabe (queda en Auditoría y en una alarma).

**Brains**: modelo «desconocido» se deduce (sin tools y sin contexto). «Visión» se conserva cuando Bedrock la reporta.

**Auditoría**: «Publicación fallida» siempre en rojo (cualquier acción con «fail»). Nuevo evento «Búsqueda en el directorio».

**Grupos**: grupo de área sin nombre `bu-…` bloqueado, como en el diseño.

**Conectividad › Cuentas miembro** (demo: Conectividad · resultado de la prueba)
- La comprobación falla: banner propio «No se pudieron comprobar las cuentas miembro» (no reutiliza el de la conexión principal).
- Sin cuentas objetivo: la sección no aparece.
- Más de 50 cuentas: aviso «Se comprobaron 50 de N cuentas».

**Preguntas abiertas**: ninguna; el punto de la cabecera y el color de «Publicación fallida» se resolvieron como arriba (quitar / rojo siempre). Avisar si el producto prefiere otra cosa.

## Ronda del 2026-10-03
**Correcciones**
- «Requiere <servicio>» (Builder y catálogo de MCP): se muestra siempre que la tool declara un servicio; tooltip «Responde con error si la cuenta pagadora no tiene activado {servicio}; Mango no lo comprueba». Sin estado «sin activar». El aviso del detalle lista los servicios que declaran sus tools.
- Quitado el error de lista de salida de red (texto, guard y opción del panel de demo).
- Auditoría: el pedido del admin es `mcp.disable_request` «Deshabilitación de MCP pedida» (resultado «solicitado»); el cierre de la plataforma sigue como `mcp.disable` «MCP deshabilitado» (actor Sistema, «aplicado»).
- Auditoría: `approval.execute` «Acción ejecutada», `approval.execute_failed` «La ejecución falló», `approval.cancel` «Solicitud cancelada».

**Diseño listo, pendiente del producto**
- Aviso del chat «Las tools de AWS Billing son solo para usuarios centrales. {agente} respondió sin esos datos.»: no se muestra hasta que el turno informe que una tool se negó por ese motivo.
- Rol «FinOps central · Usuario» en Auditoría: el evento no dice si quien actuó puede crear agentes; hoy se muestra su rol general.


**Audiencia**: Mango también es para equipos técnicos (plataforma, DevOps, FinOps). Los textos y ejemplos no deben suponer un usuario no técnico.

## Cierre de la ronda del 2026-10-03
- Auditoría: los pedidos (`*.request`, `*_request`) van en ámbar antes que la regla roja de «disable»; «Deshabilitación de MCP pedida» sale ámbar. `approval.expire` → «Solicitud vencida».

**Aprobaciones (tools de escritura)** — disponible hoy (`approvals` en `AVAILABLE`; eventos `approval.*` visibles en Auditoría) — `approvals.jsx`, `store.js` (`execute`, `cancelApproval`), `policies.jsx`
- Aprobar no ejecuta. Lo aprobado lo ejecuta quien lo pidió con «Ejecutar» antes del vencimiento; también puede «Cancelar solicitud».
- Estados: Pendiente · Aprobada · sin ejecutar · Ejecutando · Ejecutada · Falló · Rechazada · Cancelada · Vencida. Pendientes = pendiente, aprobada y ejecutando; el resto en Resueltas. Vista rápida «Listas para ejecutar».
- Si la ejecución no llegó a iniciarse vuelve a «Aprobada» con el aviso «La acción no llegó a iniciarse. Puedes ejecutarla de nuevo.» Si se inició y falló, queda «Falló» con el error.
- Vencimiento: pendiente o aprobada sin ejecutar → «Vencida» (no «rechazada»).
- Disponible hoy: título = descripción de la tool; sin riesgo ni «Impacto» (no hay backend); ids `APR-` + 8 caracteres; filas «Pidió» y «Política».
- Pantalla angosta (<1180 px): la lista se reemplaza por el detalle con «Volver a la lista» (sin drawer).
- Quien pidió no puede firmar, ni en la bandeja ni en la tarjeta del chat; ve «Tú la pediste: la aprueba otra persona».
- Modal de política (Disponible hoy): solo «Siempre»; monto, cantidad y entorno deshabilitados. Toda política se trata como «Siempre» (lista, modal y chat), aunque tenga otra condición guardada.
- Textos corregidos: ya no dice «el agente ejecutó la acción» ni «el agente ejecutará la acción».
- Chat (Disponible hoy): las escrituras crean la solicitud y la tarjeta; ya no responde «solo puedo consultar».
- Panel de demo: «Aprobaciones · al ejecutar» (se ejecuta / falla / no llega a iniciarse). Para ver «Ejecutar»: APR-203 (pedida por Usuario 1).

**Progreso del chat** — `chat.jsx` (`runTurn`, `StreamingMessage`)
- Cuatro fases: «Pensando», «Consultando {tool}» / «Consultando una tool» (sin nombre) / «Consultando N tools», «Procesando resultados», «Escribiendo». La fase se ve también con texto parcial (debajo) y en la espera entre bloques; «Escribiendo» se reemplaza por el cursor.
- Lista de pasos del turno («N pasos · M con error», plegable) mientras corre.
- Tools en paralelo: una puede fallar; el turno sigue y la fila de la tool queda «Falló» con el motivo.
- Corte por guardrail: se conserva lo escrito y se avisa debajo de la respuesta.
- Primer mensaje: el mismo progreso en una conversación vacía.
- Panel de demo: «Chat · progreso del turno» (normal / tool sin nombre / paralelo con fallo / guardrail).
- 420 px y modo oscuro: solo tokens de color; los pasos hacen salto de línea.


## Mango instalado como cliente · Personas (2026-10-03)
Ya no hay instalación «de laboratorio»: se quitó el control «Tipo de instalación»; MFA es siempre «Fijo · obligatorio».

**Ajustes › Personas** (nueva pestaña, entre General y Grupos; solo admins) — `people.jsx`
- Directorio: persona (chip con iniciales + correo, el mismo `window.PersonChip` que usa ahora Agent Builder › Acceso › Personas), estado (Activa · Invitada · contraseña temporal · Deshabilitada · **Sin acceso** = activa sin grupos), MFA registrado o no, grupos, fecha de alta. Búsqueda por inicio del correo (filtro de prefijo del directorio), filtros Todas / Sin acceso (con contador) / Invitadas / Deshabilitadas, «Mostrar más» de 20 en 20 sin total (cursor). Las personas sin acceso van primero y hay un aviso «N personas se registraron y aún no tienen acceso a nada».
- Panel de la persona (drawer; ≤560 px a pantalla completa con «Volver»): grupos con su tipo, agregar (De sistema / De acceso) y quitar; restablecer MFA (motivo + «Verifiqué su identidad por otro canal», lo aprueba otro admin); deshabilitar / rehabilitar acceso con motivo. Nota fija: no se cambia el correo ni la contraseña de otra persona ni se ven sus conversaciones.
- **Doble aprobación** (`kind: 'member'`, vence a las 72 h, lista «Cambios de personas»): dar o quitar `mango-admin` y `finops-central`, y deshabilitar a un administrador. **Decisión de diseño: el resto de los grupos se aplica al momento y queda en Auditoría** (los permisos que dan ya pasan por revisión: publicar exige aprobación, y los datos de cuentas solo los usan grupos centrales). Avisar si el producto quiere aprobación para `mango-agent-creator` o los grupos centrales propios.
- Reglas: nadie se quita a sí mismo un grupo sensible ni se deshabilita; no se aprueba un cambio sobre la propia cuenta; no se puede quitar `mango-admin` ni deshabilitar a un admin si quedarían menos de dos administradores.
- **Arranque (pregunta para el producto)**: con un solo administrador nadie puede aprobar. Diseño propuesto: mientras haya uno solo, nombrar al segundo (`mango-admin`, desde la persona o invitándolo) se aplica sin segundo aprobador y el evento lo dice («único administrador: sin segundo aprobador»). Alternativa si el producto no la acepta: solo vía el parámetro opcional de la instalación.
- Invitar: correo de los dominios permitidos (los públicos se rechazan con su propio texto; «Ese correo ya está en el directorio» se puede mostrar porque es solo para admins), grupos opcionales sin los sensibles (salvo el arranque). Recibe contraseña temporal y configura MFA al entrar.
- Restablecer MFA se movió aquí: Autenticación ya no tiene el formulario por correo, solo un enlace «Ir a Personas»; la lista de restablecimientos (con sus errores 409/410 y de carga) vive al final de Personas. Al aprobarse, la persona queda «MFA sin registrar».
- **Primer día** (instalación recién hecha): tarjeta «Primeros pasos de esta instalación»: 1) segundo administrador, 2) áreas y OUs, 3) grupos de acceso (solo existen los 4 de sistema), 4) dar acceso (con «Ver pendientes»). Los pasos 2 y 3 llevan «Necesita un segundo administrador» mientras falte. Pie: lo que ya trae la instalación (FinOps publicado, USD 5 / USD 30, MFA obligatorio, dominios). Con la instalación recién hecha, Ajustes abre en Personas.
- La persona sin grupo sigue viendo «Todavía no tienes acceso» al entrar; el texto ahora dice que un administrador ya la ve como pendiente.
- **Necesita del backend**: listar usuarios con estado, MFA, grupos y alta; filtro por prefijo de correo; contador y filtro «Sin acceso» (activas sin grupos: el directorio no lo filtra solo); invitar, agregar/quitar de grupo, deshabilitar/rehabilitar.

**Auditoría**: `directory.signup` «Persona registrada», `directory.invite` «Persona invitada», `directory.group_add` / `group_remove` «Grupo asignado / quitado a persona», `directory.disable` / `enable`, `directory.member_propose/approve/reject/withdraw`. Categoría «Acceso y grupos», enlace «Abrir Ajustes». El evento aplicado tras una aprobación dice el id del cambio y quién lo pidió; el de aprobación dice quién aprobó.

**Ajustes › General › Instalación** (nueva sección, disponible y por defecto): versión (v0.1.0) e identificador de la publicación, «Cómo actualizar» (lo hace quien administra AWS desplegando las plantillas de una versión más nueva; la app no se actualiza), nombre de la instalación, organización de AWS, cuenta de gestión, correo de alertas, dominios, administradores iniciales y qué se configura en la app. Todo de solo lectura. Modelos por defecto, Notificaciones y Observabilidad siguen Próximamente.

**Autenticación**: descripción «MFA, plan del directorio y dominios de registro vienen de la instalación y no se editan aquí»; filas nuevas de solo lectura «Plan del directorio» y «Dominios para registrarse».

**Grupos**: ya no es Próximamente en «Disponible hoy» (existe en el producto). El modal dice «Las personas se agregan en Ajustes › Personas».

**Conectividad › Cuentas miembro**: se mantiene la lista de las OUs objetivo de la instalación (lo dice el texto). No se agregó «elegir la cuenta a probar»: la lista ya cubre todas y una prueba suelta añade un campo más sin resolver lo de las OUs; avisar si el producto la quiere.

**Panel de demo**: «Instalación» (en uso / recién instalada: deja solo usuario1 admin y usuario7 sin acceso, grupos de sistema y áreas vacías), «Personas · directorio» (carga / cargando / error), «Personas · al actuar o invitar» (funciona / falla). Para ver la doble aprobación: «Admin que revisa» › Usuario 6.



## Indicador de fase del turno (2026-10-03)
`ch-orb` en `styles.css` reemplaza al mango-spinner solo en la línea de fase (`ch-phase`, `chat.jsx` › `StreamingMessage`). mango-spinner y g-spin siguen en el resto (pasos del turno, filas de tools, botones, login, administración).
- **Figura**: tres puntos de 4 px en órbita, a 120°, dentro de una caja de 16 × 16 px (la línea reserva 20 px fijos: no mueve el contenido al aparecer, cambiar o irse). Color `--accent-ink` con opacidad 1 / .7 / .42 (efecto de estela); sigue los dos temas sin valores propios.
- **Una figura, ritmo por fase** (`data-k`): Pensando = órbita lenta (2,8 s) y los puntos respiran (escala .55→1, 1,4 s, desfasados); Consultando = órbita rápida (0,9 s); Procesando resultados = órbita de 1,6 s y los puntos se juntan hacia el centro y vuelven; Escribiendo (sin texto aún) = órbita de 1,6 s. Con texto, «Escribiendo» sigue siendo el cursor.
- **Cambio de fase**: sin transición propia; cambia el ritmo y el texto. El texto sigue siendo el `role="status"` que se anuncia; el indicador va con `aria-hidden`.
- **Observar**: indicador a la izquierda, texto (se recorta con «…» si no cabe, a 420 px), «LIVE» con su punto azul fijo a la derecha. Solo se mueve el indicador.
- **Reducir movimiento**: sin animación; queda el triángulo de tres puntos con la estela de opacidades.
- **Costo**: solo `transform` y `opacity`; sin sombras ni desenfoques.
- **Primera espera**: sin versión grande. La conversación vacía usa la misma línea de fase.


## Alineación con el producto · Personas, Instalación y aprobaciones (2026-10-04)
Confirmado por el producto (sin cambios): doble aprobación solo para lo sensible, arranque con un solo admin, reglas de Personas, directorio, MFA en Personas, Instalación de solo lectura, Grupos disponible y eventos `directory.*`. Indicador `ch-orb` implementado tal cual. «Consultando {n} tools…» usa el ritmo de «Consultando».

**Personas** — `people.jsx`, `settings.jsx`
- **Rehabilitar** a quien tiene `mango-admin` o `finops-central` lo aprueba otro admin (motivo obligatorio, 72 h). En «Cambios de personas» aparece como «Rehabilitar el acceso de {correo}». Texto: «Tiene un grupo sensible: rehabilitarla lo aprueba otro administrador.» El resto se rehabilita al momento.
- **Primeros pasos**: no hay estado «recién instalada». La tarjeta se ve mientras falte alguno de los cuatro pasos y desaparece cuando están todos (ya no hay «Listo»). Ajustes abre en Personas mientras haya un solo administrador. El control del panel pasa a llamarse «Datos de ejemplo · Instalación nueva · un solo admin».
- **Al aprobar se comprueban otra vez las reglas**: «No se pudo aprobar CHG-N: la persona fue deshabilitada / ya tiene ese grupo / quedarían menos de dos administradores. El cambio sigue pendiente.» (role="alert" sobre la lista).
- **Errores nuevos** (panel y lista): «Otro cambio de administradores está en curso. Inténtalo de nuevo en unos segundos.» y «Ya no tienes permiso de administrador: tus acciones en Personas se rechazan. Vuelve a entrar para actualizar tu sesión.» (demo: «Personas · al actuar o invitar»).
- **Directorio grande**: aviso «El directorio es más grande de lo que se lee de una vez: los contadores son un mínimo.» (demo: «Personas · directorio › Más grande de lo que se lee»).
- `directory.list` «Lectura del directorio»: se registra al abrir la lista con el número de filas y sin correos. Es una lectura, así que solo se ve con «Mostrar lecturas».
- Cuentas sin correo verificado: no aparecen en el directorio. No tienen estado propio.
- Columna de estado de 190 px. Iniciales del chip: las dos primeras letras del correo (en los datos de ejemplo, «US»).
- **Invitar**: se acepta cualquier dominio que no sea de un proveedor de correo público. Se quitó «Solo se puede invitar a correos de…». La ayuda dice «Se registran solos: {dominios}. A los demás correos de empresa se les invita aquí; los correos públicos no se aceptan.» Con un dominio externo: «Dominio externo: se invita como persona de otra empresa y queda así en Auditoría.»
- **Persona de fuera (respuesta a la pregunta)**: sí se marca. La fila lleva la insignia «Externa» y el panel «Externa · invitada de otra empresa» (tooltip «Su dominio no es de los que se registran solos»).
- Auditoría: «Persona invitada» añade «dominio externo» cuando aplica. Una invitación rechazada queda como «Persona invitada» con resultado «no se aplicó · {código}» (`invalid_email`, `public_email`, `exists`; `sensitive_group` y `unknown_group` no se pueden producir desde la pantalla). Si el correo no pasó la validación, el recurso es solo `@dominio`.
- «Persona registrada» (`directory.signup`): la etiqueta sigue, pero se quitó el evento de ejemplo porque el producto aún no lo registra.

**Instalación y Autenticación**
- «Publicación» = etiqueta de la release (`v0.1.0-g1a2b3c4`). Si es igual a la versión o falta, la fila muestra solo la versión.
- Estados: esqueleto mientras carga, y «No se pudieron cargar los datos de la instalación.» + Reintentar (demo: «Ajustes · datos de la instalación»).
- Sin cifras de presupuestos en Instalación ni en Primeros pasos: «los presupuestos por defecto de la versión» con enlace a Presupuestos.
- Autenticación: se quitó «Plan del directorio» (el producto no tiene ese dato). La descripción dice «MFA y dominios de registro vienen de la instalación».

**Aprobaciones** — `policies.jsx`, `approvals.jsx`, `chat.jsx`
- **Se quitó «todo es Siempre»** (`polEff` ya no transforma nada; el chat usa `approvalTier` también en «Disponible hoy»). En «Disponible hoy» el modal solo deshabilita las condiciones con datos que la tool no informa (tooltip «Esta tool no informa ese dato» y ayuda «Las opciones deshabilitadas dependen de datos que esta tool no informa.»). `TOOL_REPORTS`: `aws-budgets.create_budget` y `sap-s4-hana.release_payment` informan monto. Nueva política de ejemplo `aws-budgets.create_budget`: más de USD 1.000 pide 1 aprobador; hasta ese monto confirma el usuario. Para probarlo en el chat: «crea un presupuesto de 500» (confirma el usuario) o «de 5000» (aprobadores).
- Textos: «Lo que no se resuelve a tiempo queda «Vencida»», «{h} h · luego vence», «Si nadie la resuelve a tiempo, queda «Vencida» y en Auditoría.»
- **Historial**: «aprobó · falta que X la ejecute» solo mientras está «Aprobada · sin ejecutar». Si mira quien la pidió: «aprobó · falta que la ejecutes». Después dice «aprobó».
- Se quitó la fila «Entorno»: los argumentos ya están en «qué va a ejecutar».
- Ejecución fallida: muestra solo el código de la API en mono (p. ej. `AccessDenied`).
- Chat: una tool fallida solo dice «Falló», sin motivo (pasos del turno y fila de la tool).
- **Preguntas de diseño**:
  1. Pasos del turno mientras corre y grupo «N herramientas» al terminar, abierto con «Observar»: **sí**, es lo que se quiere.
  2. Tarjeta «Requiere aprobación» con argumentos: **sí**, se adopta `tool · k=v, … · política` en la tarjeta del chat y en la bandeja.
  3. Mensajes del agente tras confirmar o cancelar: **se quitaron**. El estado lo muestra la tarjeta; tras confirmar sigue apareciendo la fila de la tool ejecutada.
- Aviso de guardrail: solo en vivo; al releer una conversación cargada no se muestra (en el prototipo solo persiste en la sesión).



## Cierre de detalles (2026-10-04)
- **«Consultando…» usa el nombre de la tool**, como el producto: «Consultando get_cost_and_usage…», también en los pasos del turno. Con varias tools: «Consultando {n} tools…». No se pide el nombre del MCP. La espera de una escritura ya no muestra una fase «Consultando políticas de aprobación» (no es una tool): solo «Pensando».
- **Identificador de los cambios de personas**: aleatorio, se muestran 8 caracteres en mono (p. ej. `18106de3`), también en «No se pudo aprobar 18106de3: …». Los demás cambios siguen como CHG-N.
- **Rechazos al aprobar cuando el cambio ya no aplica**: un texto por caso, todos terminan en «El cambio ya no aplica: retíralo o recházalo.»: «el grupo {g} ya no existe», «la persona ya no tiene ese grupo», «la persona ya está deshabilitada», «la persona ya está habilitada». Los tres anteriores (deshabilitada, ya tiene el grupo, menos de dos admins) siguen con «El cambio sigue pendiente.»
- **«Externa»**: si la instalación no tiene dominios de registro, no se marca a nadie.
- **Mismo patrón en los cuatro formularios del panel**: rehabilitar con aprobación ahora también se abre con «Rehabilitar acceso…» y tiene «Cancelar», como quitar grupo, restablecer MFA y deshabilitar. *Cambio para el producto.*
- «Otro cambio en curso» al aprobar desde la lista: el producto muestra «La solicitud ya no está pendiente…» hasta que la API separe las dos respuestas. Sin cambio de diseño.


## Después de la prueba en navegador real (2026-10-04)
- **Botón de peligro (`.mk-danger`)**: usa el token nuevo `--danger-bg`, separado de `--red` (que sigue para textos e indicadores). Oscuro: `#b91c1c` con texto blanco, 6,5:1. Claro: `#c4213a`, 5,8:1. Aplica a todos los `.mk-danger`.
- **Auditoría · actor**: insignia corta en la lista («Admin», «Creador», «Usuario», «Agente», «Sistema»). El rol completo va en el panel del evento y en el texto emergente de la fila. Un actor que es un correo se corta por el medio: el inicio se recorta con «…» y el `@dominio` siempre se ve. Así dos admins con el mismo inicio se distinguen por el dominio, y por el resto del inicio cuando hay sitio.
- **Auditoría · solicitado + resultado en una fila**: el par «solicitado» → «aplicado»/«no se aplicó» (misma acción, recurso y actor, menos de 2 min) se muestra como una sola fila con el resultado final. El panel del evento añade «Solicitado · {hora} · {id} · se registra antes de aplicar». En el CSV siguen las dos filas. Si la acción misma es un rechazo («Cambio de persona rechazado»), el resultado «aplicado» se lee «registrado».
- **«Acceso permitido»** (`policy.decision`, en «Acceso y grupos», visible sin «Mostrar lecturas»), con el mismo detalle «{permiso} · permitido». Permisos nuevos en `AUDIT_PERMS`: «Ver personas» (`ViewPeople`), «Gestionar personas» (`ManagePeople`), «Decidir cambio de persona» (`ApprovePeopleChange`).
- «Lectura del directorio» es una lectura: solo se ve con «Mostrar lecturas» (ya era así en el diseño).
- **Invitar**: el modal solo valida vacío y formato. El correo público y el «ya está en el directorio» llegan como respuesta al envío, tras «Enviando…», y quedan en Auditoría. La lista de proveedores públicos vive solo en el servidor (la del prototipo es solo para simular).
- **Panel de la persona**: a ≤560 px ocupa todo el ancho (antes quedaban 60 px de la lista a 560 exactos).
- **Chip de persona**: el correo se corta por el medio (inicio con «…» + `@dominio` fijo). «tú» va dentro del chip, así que ya no baja de línea a 420 px.
- **Pestañas de Ajustes a ≤560 px**: hacen salto de línea en vez de desplazarse sin indicarlo.
- **«Cambios de personas»**: si la persona ya no está en el directorio, la tarjeta conserva su correo (es historial) y añade «Ya no está en el directorio».
- Persona borrada del directorio por fuera de Mango: desaparece en la siguiente lectura, sin estado propio (aceptado).


## Sesión que se conserva al recargar · Auditoría · detalles (2026-10-04)
**Sesión** — `login.jsx`, `app.jsx`, `settings.jsx`
1. **Recuperando la sesión**: no se usa el «Cargando…» genérico. Se muestra el armazón del inicio de sesión (marca + panel) con «Recuperando tu sesión…» y el mango-spinner donde iría el formulario (`.login-restoring`, `role="status"`, misma altura que el formulario). Si hay sesión, entra a la aplicación; si no, aparece el formulario en el mismo lugar, sin parpadeo. Demo: «Login · al abrir la app › Recuperando la sesión».
2. **Sin «Mantener la sesión en este equipo»**: la sesión se conserva para todos y su duración la fija el admin. Bajo «Entrar» va la ayuda «Sigues dentro hasta 8 h, aunque recargues o cierres el navegador. En un equipo compartido, cierra sesión al terminar.» (`.login-keep`; las 8 h salen de Autenticación).
3. **Duración de la sesión**, ayuda: «Tiempo máximo que una persona sigue dentro sin volver a ingresar, aunque recargue o cierre el navegador».
4. **Aviso antes de vencer**: 10 min antes, banda bajo la barra superior (`.sess-warn`, `role="status"`, icono de reloj ámbar): «**Tu sesión vence en 10 min.** Guarda lo que estés escribiendo: al vencer vuelves a ingresar con tu contraseña y MFA.» + «Entendido». No hay «Extender»: la duración es un máximo. Se muestra una vez por sesión. Demo: «Sesión · aviso de vencimiento».
5. **Cierre desde otra pestaña**: las demás pestañas vuelven al inicio de sesión con el aviso «Cerraste sesión en otra pestaña. Vuelve a entrar para seguir.» (`login-ok-box`). Demo: «Login · al abrir la app › Cerró sesión en otra pestaña».

**Auditoría · sesiones**
- Etiquetas: «Sesión iniciada» (`session.started`), «Sesión recuperada» (`session.renewed`), «Sesión cerrada» (`session.ended`), «Sesión rechazada» (`session.rejected`), en «Acceso y grupos».
- «Sesión recuperada» es una lectura: solo se ve con «Mostrar lecturas». Las otras tres se ven siempre. «Sesión rechazada» va con resultado «no se aplicó · {código}» en rojo.
- Motivo de `session.ended` en el panel del evento («Motivo»): `logout` «La persona cerró sesión», `expired` «Venció: pasó la duración máxima de la sesión», `disabled` «Un administrador deshabilitó su acceso», `group_removed` «Se le quitó un grupo sensible», `mfa_reset` «Se restableció su MFA».
- Ayuda de «Mostrar lecturas»: «Accesos de solo lectura permitidos y sesiones recuperadas al recargar. Los denegados, los rechazos y los cambios se ven siempre.»

**Auditoría · actor**
- **Fila**: el correo se recorta al principio, no al final. Se conservan siempre los últimos 6 caracteres de la parte local más el `@dominio`, y el resto se corta con «…»: «usuari…ntral@empresa.com». El chip de persona hace lo mismo.
- **Panel**: el correo puede partirse solo antes de la «@», nunca a mitad de palabra (`.au-mail` + `<wbr>`).
- Insignia corta de «FinOps central» sin admin: «Central» (no depende de saber si crea agentes).
- «Sistema» sin insignia; «Agente» no aparece como actor (el actor de una consulta es la persona). Coincide con el producto.
- Paginación: si el «solicitado» no está cargado, el resultado se ve solo hasta que llegue con «Mostrar más». Aceptado.

**Personas**
- Rechazo por máximo de grupos al aprobar: «No se pudo aprobar {id}: la persona ya tiene el máximo de grupos. Quítale uno antes; el cambio sigue pendiente.» El máximo lo informa la API (en el prototipo, 10).
- Invitar, ayuda con un dominio que no es de la instalación (no afirma nada antes de enviar): «No es un dominio de la instalación. Si es de otra empresa, se invita como externa; los correos públicos se rechazan al enviar.» El formato inválido devuelto por la API va bajo el campo. El mensaje al pie se borra al escribir.
- «Ya no está en el directorio»: queda para cuando el producto lo informe.

**Aspecto**
- Chat a ≤560 px: la fila de envío tiene 6 px de margen a la derecha y «Cancelar» ya no queda pegado al borde.
- Menú de Ajustes › General: la insignia «Próximamente» va debajo de la etiqueta (`.set-nav-soon`), no encima del texto.


## Después de implementar la sesión (2026-10-04)
**Correcciones**
- **Chat a ≤560 px**: la barra del compositor (`.ch-compose-bar`) hace salto de línea y se oculta la ayuda de teclado («/ comandos · ⇧↵»), que no sirve en pantallas táctiles. «Cancelar»/«Enviar» van a la derecha (`margin-left:auto`); si aun así no caben con «Skill» y sus «Próximamente», bajan a una segunda línea alineados a la derecha. Ya no se sale del cuadro.
- **Actor de Auditoría**: la columna del actor (la 3.ª: hora, evento, actor…) pasa a 230 px como mínimo (210 px a ≤1100 px). Así caben «…» + los últimos 6 caracteres + `@dominio` + la insignia con dominios normales (`mock-user@example.com` + «Admin»). Con un dominio muy largo se ve el correo completo al pasar el cursor y en el panel.
- **Chip y actor con poca parte local**: si al quitar los 6 caracteres quedarían 1 o 2 letras, el correo no se divide en dos partes: va en un solo tramo que, si no cabe, se recorta al final con «…» (nunca pasa bajo la insignia). La parte que se recorta tiene un ancho mínimo de 1ch (solo «…»). Se acabó el hueco «us uario1@…».
- **Aviso de vencimiento**: dice los minutos que quedan al aparecer («Tu sesión vence en 4 min.»). Se acepta lo que hace el producto: tras «Entendido», una recarga dentro de los últimos 10 min lo vuelve a mostrar, y sin hora de vencimiento no hay aviso. Con SSO el texto termina en «al vencer vuelves a ingresar» (sin «contraseña y MFA»). Demo: «Sesión · aviso de vencimiento › Abrió con 4 min».
- **Motivos de «Sesión cerrada»**: `rejected` «El proveedor de identidad no la renovó: se revocó o venció allí, o la cuenta se deshabilitó fuera de Mango»; `revoked` «Un administrador cerró sus sesiones (sin detalle del motivo)». Con dos cambios seguidos vale el más reciente (aceptado). Para `disabled`, `group_removed`, `mfa_reset`, `rejected` y `revoked` el panel añade bajo el motivo: «Se registra cuando su navegador intenta renovar la sesión, no en el momento del cambio. Si tenía la aplicación cerrada, puede no aparecer.»
- **«Sesión rechazada»**: como pasa al crear la sesión y no al renovar, la frase pasa a «No se pudo crear la sesión tras el ingreso». *Cambio para el producto.* El panel añade «Motivo»: `invalid_refresh_token` «El ingreso no sirve para crear la sesión», `sub_mismatch` «El ingreso es de otra persona». Otros códigos se ven solo en «Resultado».
- **«Sesión iniciada» con SSO**: «Ingresó con el SSO de la empresa · {authCfg.idpName}». «Ingresó con contraseña y MFA» queda para el ingreso propio.
- **Pantalla de carga**: se acepta que «Recuperando tu sesión…» dure hasta que la app esté lista. Al volver del SSO no se usa el «Cargando…» genérico: es el mismo armazón con «Completando el ingreso…». *Cambio para el producto.* Demo: «Login · al abrir la app › Vuelve del SSO».

**Caso nuevo: quien crea un agente y no está en sus grupos**
- **Agent Builder › Acceso**: se comprueba contra los grupos de quien edita y su correo en Personas.
  - Si no está en ninguno: aviso ámbar «No estás en ninguno de estos grupos. Cuando se publique no lo verás en el Marketplace ni podrás usarlo en el chat, aunque lo hayas creado: el uso va por grupos, también para administradores. Lo verás en el Org Chart y podrás editarlo. Para usarlo, elige también un grupo tuyo o agrega tu correo en Personas.» No bloquea el envío: compartir con otra área es válido.
  - Si está en alguno pero no en todos: nota gris «No estás en {grupos}. Lo usarás por otro de tus grupos.»
- **Org Chart › detalle**, cuando quien lo abre no puede usar el agente: caja «No puedes usar este agente» con la explicación, «Lo usan» y la lista de grupos (mono), más qué hacer: quien puede editar, «agrega uno de tus grupos en su Acceso (va con una versión nueva)»; el resto, «pide a un administrador que te agregue». Se quita «Ver en Marketplace»; «Editar» sigue para quien puede editar.
- Demo: SAP Invoicer (`sap-02`) se comparte solo con `bu-retail`. Abrirlo en el Org Chart con la cuenta Admin muestra la caja. El Marketplace del prototipo sigue mostrando todo a los admins (simplificación): en el producto no lo ve.


## Precisiones tras implementar (2026-10-04)
- **Chat a ≤560 px**: «Enviar» y «Cancelar» pasan a solo icono (36 × 36 px, `aria-label` «Enviar» / «Cancelar respuesta»; `.ch-send-btn`, la etiqueta `.ch-send-lbl` se oculta). Así caben en la misma línea que el adjuntar y «Skill», en reposo y mientras responde. El salto de línea queda solo como respaldo.
- **Aviso de vencimiento**: el texto depende de cómo ingresó esa persona, no de la instalación (como el producto). Con SSO, «al vencer vuelves a ingresar»; con el inicio de sesión propio, «… con tu contraseña y MFA», aunque la instalación tenga proveedor. Demo: «Sesión · cómo ingresó».
- **«Sesión iniciada» con SSO**: el nombre es el de la instalación, el mismo de Ajustes › Autenticación: «Ingresó con el SSO de la empresa · Okta». Sin proveedor configurado: «Ingresó con el SSO de la empresa». En los datos de ejemplo, `idpName` es «Okta».
- **Tras ingresar con el formulario propio**: el mismo armazón del inicio de sesión con «Entrando…» donde estaba el formulario, hasta que la app esté lista. Sin «Cargando…» genérico en ningún ingreso. *Cambio para el producto* (en el prototipo el paso es instantáneo).
- **Agent Builder › Acceso**: «o agrega tu correo en Personas» va siempre. Se acepta que el aviso cuente los grupos que el agente tenía y ya no están en la instalación.
- **Org Chart › detalle**: se acepta que la caja solo la vean quienes pueden crear agentes. «Lo usan» lista solo grupos. El texto ya no habla solo de grupos: «No estás en sus grupos ni entre sus personas, así que no aparece en tu Marketplace ni en el chat. El uso va por grupos y personas, también para quien lo creó y para administradores.» Vale también si se comparte solo con personas (sin «Lo usan»). La variante «pide a un administrador…» queda implementada aunque hoy no aparezca.
- **Datos de ejemplo**: se cambió el ejemplo del recorte del correo a «usuari…ntral@empresa.com». Ningún ejemplo usa dominios reales. La lista de proveedores públicos de `people.jsx` solo simula el rechazo del servidor.


## Tras la instalación (2026-10-04)
- **Avisos a ≤560 px** (`ui.jsx` › `.toast-stack`): van arriba, bajo la barra superior (56 px + safe area), a 12 px de cada borde, en vez de abajo a la derecha. Así ningún aviso («Respuesta completa» incluido) tapa el compositor, «Enviar», adjuntar ni «Skill». Duración y «×» sin cambios. Arriba de 560 px, igual que antes.
- **Org Chart › detalle · «Editar»**: solo para quien puede editar *ese* agente: administrador o quien lo creó (`canEditThis = agent.edit && (admin || owner === actor)`). El producto debe entregar ese dato con el detalle. Un creador que no lo creó no ve «Editar»; en su lugar, bajo los botones: «Solo quien lo creó ({creador}) o un administrador puede editarlo.» (gris, 12 px). Mismo criterio en Disponible hoy y Diseño completo.
- **Caja «No puedes usar este agente» · última línea**, tres variantes:
  - Puede editar ese agente: «Para usarlo, agrega uno de tus grupos en su Acceso (va con una versión nueva) o pide que te sumen a uno de esos grupos.»
  - Creador que no lo creó: «Para usarlo, pide a quien lo creó ({creador}) que agregue uno de tus grupos en su Acceso, o a un administrador que te sume a uno de esos grupos.»
  - Sin permiso de crear agentes (si el producto llega a mostrarle la caja): «Para usarlo, pide a un administrador que te agregue a uno de esos grupos.»
- Si no se conoce el creador, se omite «({creador})».
- Pendiente del producto sin cambios de diseño: «Ya no está en el directorio», separar «otro cambio en curso» de «ya se decidió», evento «Persona registrada», motivo en el turno del aviso de AWS Billing solo para usuarios centrales, motivo del fallo de tool y marca de guardrail en el mensaje guardado.
