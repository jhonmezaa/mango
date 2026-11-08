# Mango — Handoff

Prototipo interactivo de una plataforma interna de agentes de IA (AWS Bedrock + Cognito + MCP). Todo el texto está en español. HTML + React sin build: cada `.jsx` se carga con `<script type="text/babel">` y exporta a `window`. Entrada única: **`Mango.html`**.

Datos de ejemplo neutros: "Usuario N", `usuarioN@empresa.com`, iniciales `UN`, cuentas `111111111111`…, OUs `ou-xxxx-…`. Sin IPs, sin claves.

## Archivos

```
Mango.html               entrada
Reporte de tarea.html    plantillas del PDF de una tarea (Resumen de costos, Investigación de anomalía); usa doc-page.js
src/kb.css               estilos de Knowledge Bases
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
  agent-review.jsx mcp-catalog.jsx models-view.jsx skills.jsx schedules.jsx schedules-run.jsx
  kb-core.jsx (datos, permisos y acciones de Knowledge Bases) kb-source.jsx (propuesta de bucket en Aprobaciones y Bandeja)
  kb-agent.jsx (Builder, Revisión, citas del chat) kb-docs.jsx (Documentos, subida, Probar búsqueda) knowledge.jsx (lista, detalle, alta)
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
- **Schedules**: corren con la identidad y permisos de quien los creó; se pausan solos si esa persona pierde el acceso al agente (o deja de ser central, en las de anomalía). Cada persona ve las suyas; un admin ve todas, sin la instrucción ni los resultados. Solo el dueño edita y ejecuta ahora, y reanuda su propia pausa. Un admin que no es el dueño pausa (con motivo; después solo un admin la reanuda) o retira. No se eliminan. Slack y tickets: Próximamente. Ver «Schedules · resultado, estados y anomalías de costo».
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

Tweaks → "Ver disponibilidad actual". `MangoStore.AVAILABLE` = chat (solo FinOps), schedules, bandeja (Menciones Próximamente), budgets (valores por defecto, por agente, por usuario), audit, settings (General › Autenticación, Áreas y OUs, Conectividad), login. En ese modo, solo FinOps aparece fijado (sin quitarlo), el selector de modelo y "Más opciones" del chat son Próximamente, la lista de conversaciones no muestra vista previa ni no leídos, el chat no ofrece acciones de escritura ni tickets (Aprobaciones es Próximamente), Presupuestos es solo para admins (la cuenta "FinOps central" sin Admin no lo ve); FinOps usa el límite por defecto (sin presupuesto propio); "Alertas activas" está disponible con los agentes en alerta y su %; "Por equipo" es Próximamente y sin equipos de ejemplo. Ajustes › General › Autenticación está disponible: datos de solo lectura, políticas y Restablecer MFA; "Proponer cambio" de MFA, sesión e IdP es Próximamente (hoy se configuran al instalar) y no se muestran propuestas de ejemplo; las demás secciones de General y la pestaña Grupos son Próximamente. El Audit log muestra eventos de presupuestos (de FinOps), áreas, cuenta, accesos y consultas a FinOps; no muestra "Contraseña creada" ni "MFA configurado" (esos pasos van directo al proveedor de identidad y aún no se registran). Lo demás aparece deshabilitado con la etiqueta; con el interruptor apagado las vistas muestran su diseño completo con datos de ejemplo.

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
- **Avisos** (`ui.jsx` › `.toast-stack`): *sustituido, ver «Ajustes tras la segunda instalación»*.
- **Org Chart › detalle · «Editar»**: solo para quien puede editar *ese* agente: administrador o quien lo creó (`canEditThis = agent.edit && (admin || owner === actor)`). El producto debe entregar ese dato con el detalle. Un creador que no lo creó no ve «Editar»; en su lugar, bajo los botones: «Solo quien lo creó ({creador}) o un administrador puede editarlo.» (gris, 12 px). Mismo criterio en Disponible hoy y Diseño completo.
- **Caja «No puedes usar este agente» · última línea**, tres variantes:
  - Puede editar ese agente: «Para usarlo, agrega uno de tus grupos en su Acceso (va con una versión nueva) o pide que te sumen a uno de esos grupos.»
  - Creador que no lo creó: «Para usarlo, pide a quien lo creó ({creador}) que agregue uno de tus grupos en su Acceso, o a un administrador que te sume a uno de esos grupos.»
  - Sin permiso de crear agentes (si el producto llega a mostrarle la caja): «Para usarlo, pide a un administrador que te agregue a uno de esos grupos.»
- Si no se conoce el creador, se omite «({creador})».
- Pendiente del producto sin cambios de diseño: «Ya no está en el directorio», separar «otro cambio en curso» de «ya se decidió», evento «Persona registrada», motivo en el turno del aviso de AWS Billing solo para usuarios centrales, motivo del fallo de tool y marca de guardrail en el mensaje guardado.

## Ajustes tras la segunda instalación (2026-10-05)
- **Avisos, todos los anchos:** arriba a la derecha, a 8 px bajo la barra superior (64 px + 8 px + safe area = `top: 72px`), a 18 px del borde derecho, máx. 360 px. A ≤560 px, a 12 px de cada borde y ancho completo. Ya no van abajo: ningún aviso tapa el compositor ni «Enviar» en ningún ancho. Duración y «×» sin cambios.
- **«({creador})» se retira.** El Org Chart no nombra personas. Textos únicos: «Solo quien lo creó o un administrador puede editarlo.» y «Para usarlo, pide a quien lo creó que agregue uno de tus grupos en su Acceso, o a un administrador que te sume a uno de esos grupos.»
- **Tercera variante** («pide a un administrador que te agregue…»): queda reservada para cuando la caja se muestre a quien no puede crear agentes. Hoy no aparece y es correcto.
- **Cambio pendiente de una persona que ya no está en el directorio:** no se ofrece «Aprobar». En su lugar, «No se puede aprobar: ya no está en el directorio» y «Rechazar», que abre el motivo ya escrito: «La persona ya no está en el directorio.» (editable). Si es una propuesta propia, solo «Retirar», como siempre. Si la persona desaparece entre que se carga la lista y se pulsa «Aprobar», el producto responde con este error específico, no con el genérico: «No se pudo aprobar {id}: la persona ya no está en el directorio. El cambio ya no aplica: retíralo o recházalo.» Lo mismo se muestra al pasar la lista de cambios a ese estado.
- **Tarjeta de cambio a ≤560 px:** cabecera en columna. Título, estado y metadatos usan todo el ancho, y los metadatos se envuelven en línea con un espacio de 2 × 10 px. Debajo, una fila con el aviso («Otro admin debe aprobarla», etc.) y los botones, alineados a la izquierda y envolviéndose si no caben.
- **Después de «Otro cambio de administradores está en curso…» o de «La solicitud ya no está pendiente…»:** el producto vuelve a leer la lista de cambios y actualiza todas las tarjetas sin recargar la página. El aviso de error se queda visible. Así, la tarjeta que aprobó el otro admin pasa a «Aprobado · Aprobó {admin}» y la propia sigue «Pendiente».
- **Auditoría · «Lectura del directorio» (`directory.list`):** dos filas por carga de Ajustes › Personas, con un detalle legible y una sección «Lectura» en el panel (nunca las claves crudas):
  - Búsqueda: detalle «Buscó personas» o, si hubo texto, «Buscó por texto» (el texto no se registra ni se muestra); luego «· {filtro}» si el filtro no es «Todas»; luego «· {n} resultados» («1 resultado»). Ej.: «Buscó personas · 16 resultados», «Buscó personas · Sin acceso · 3 resultados», «Buscó por texto · Invitadas · 1 resultado». En «Lectura»: Qué se leyó «Búsqueda de personas» · Resultados {n} · Filtro «Todas» / «Sin acceso» / «Invitadas» / «Deshabilitadas» (siempre) · Texto buscado «Sí» / «No».
  - Lista de cambios: detalle «Leyó los cambios de personas · {n} cambios» («1 cambio»), con «· {m} de personas que ya no están» si m > 0 («· 1 de una persona que ya no está»). En «Lectura»: Qué se leyó «Lista de cambios de personas» · Resultados {n} · De personas que ya no están {m}.
  - Campos: `scope` (people|changes), `returned`, `query` (bool, solo people), `filter` (solo people; se muestra con la etiqueta del filtro de la pantalla) y `missing` (solo changes). `outcome` no se muestra en lecturas.
- **Pendiente del producto, sin cambios de diseño:** evento «Persona registrada» en Auditoría; que el turno informe el motivo del aviso «Las tools de AWS Billing son solo para usuarios centrales…»; el motivo del fallo de una tool y la marca «cortado por guardrail» en el mensaje guardado.

## Precisiones tras la tercera instalación (2026-10-05)
- **Lectura del directorio:** el texto buscado no se registra; el filtro sí se nombra. Actualizado arriba, en «Ajustes tras la segunda instalación» › Auditoría.
- **No se sabe si la persona sigue en el directorio** (directorio muy grande o lectura fallida): la tarjeta no dice nada y ofrece «Aprobar». Es lo correcto: no se marca a nadie como ausente sin saberlo, y «Aprobar» comprueba antes de aplicar. Si ya no está, sale el texto específico, la lista se vuelve a leer y la tarjeta pasa a «No se puede aprobar: ya no está en el directorio». Tal como está implementado.
- **Tras «Otro cambio de administradores está en curso…»:** la lista se lee al momento y luego cada 3 s, hasta que alguna tarjeta de cambios de administradores cambie de estado o pasen 30 s. Mientras tanto, «Aprobar» y «Rechazar» de las tarjetas de cambios de administradores quedan desactivados con el motivo «Otro cambio se está aplicando…» (gris, como los demás motivos); «Retirar» sigue disponible. El aviso de error se queda. A los 30 s sin cambios, los botones se reactivan y la tarjeta queda como esté; la siguiente acción vuelve a comprobar. La demo no reproduce este caso.
- **«Respuesta completa»:** solo sale si la persona no ve el final de esa conversación, es decir, si está en otra pantalla, si la pestaña está en segundo plano o si subió más de 80 px en la conversación. Si ve el final, no sale: la respuesta misma lo indica. El fin de la respuesta se anuncia siempre a lectores de pantalla (`aria-live="polite"`: «Respuesta completa. {agente} terminó de responder.»), salga o no el aviso.
- **Avisos sobre el contenido:** a más de 560 px se quedan arriba a la derecha, sobre el contenido, mientras duran. Es lo previsto: no desplazan nada, se cierran con «×» y la pila no capta clics fuera de los avisos (`pointer-events: none` en `.toast-stack`, `auto` en cada aviso).
- **Pendiente del producto, sin cambios de diseño:** evento «Persona registrada» en Auditoría; que el turno informe el motivo del aviso «Las tools de AWS Billing son solo para usuarios centrales…»; el motivo del fallo de una tool y la marca «cortado por guardrail» en el mensaje guardado.

## Schedules · resultado, estados y anomalías de costo (2026-10-16)
Archivos: `schedules.jsx` (lista, detalle, editor), `schedules-run.jsx` (zona horaria, estados, motivos, resultado, datos de ejemplo), `other-views.jsx` (Bandeja), `store.js` (Schedules para todos los roles y en «Disponible hoy»).

**Dónde se lee el resultado (2.1): en el detalle, con un aviso en la Bandeja**
- El resultado vive en el detalle de la tarea. En «Ejecuciones recientes», cada ejecución con resultado tiene «Ver resultado». Se abre dentro del mismo panel, no en un diálogo encima. El panel pasa de 520 a 640 px y se vuelve con «‹ Volver a la tarea» o con Esc.
- Contenido, en orden: «Resultado · {fecha}»; agente · estado · duración · costo; la caja «Anomalía que la arrancó», si la hay; «Pasos · {n} consultas», cerrado, con lo que el agente escribió antes de cada consulta y el nombre de la tool; el informe en Markdown (sin HTML, mismo render que el chat); al final, «Solo tú ves este resultado: se obtuvo con tu acceso.».
- Para separar pasos e informe, el producto guarda el texto por tramos: lo escrito antes de cada consulta (con su tool) y lo escrito después de la última. Si una ejecución solo tiene el texto completo, se muestra entero y sin «Pasos».
- Bandeja: un aviso por ejecución terminada, de tipo «Ejecución» (icono reloj). Dice «{tarea} · completada» con la primera línea del informe, o «{tarea} · no se completó» con el motivo. «Ver resultado» o «Ver ejecución» abre Schedules en esa ejecución. Los avisos de ejecución van del más reciente al más antiguo. La Bandeja no copia el resultado. Mientras la Bandeja no exista, no hay aviso y los textos nombran solo el detalle.
- «Entregar resultado en» deja de ser una elección. El campo pasa a «Resultado: Queda en el detalle de la tarea y te llega a la Bandeja. Solo tú lo ves.», con «También enviar a: Canal de Slack · Crear ticket», los dos Próximamente (2.2). La lista ya no muestra la entrega en cada fila, y la columna «frecuencia» pasa a «cuándo corre».

**Selector de agente (2.3):** como el producto, solo los agentes publicados que la persona puede usar, con la ayuda «Solo agentes publicados que puedes usar.». Sin ninguno, «Nuevo schedule» queda desactivado («No tienes agentes publicados que puedas usar»).

**Quién ve qué (2.4, 2.10):** cada persona ve las suyas y un administrador ve todas. De una tarea ajena, el administrador no ve la instrucción ni los resultados:
- En «Tarea»: «Solo {dueño} ve la instrucción y los resultados: se obtienen con su acceso, como sus conversaciones.».
- En «Ejecuciones recientes»: «Los resultados solo los ve {dueño}.», sin «Ver resultado».
- Sí ve nombre, agente, dueño, disparador, estado, duración, costo y motivo de cada ejecución. La búsqueda solo mira la instrucción de las tareas propias.
- Schedules pasa a estar disponible para todos los roles (antes, solo creadores y administradores).

**Próximas en el editor (2.5):** «Próximas, hora de {zona}: …», tres fechas en la zona elegida. Las calcula el servidor al cambiar frecuencia, hora o zona: espera de 300 ms, «Calculando…» mientras tanto, y si falla no se muestra la línea. Si la zona no es la de quien mira, se agrega «· la primera es {fecha} en tu hora». En la lista, en el detalle («Próximas · tu hora») y en «Próxima ejecución», van en la hora de quien mira, calculadas con la zona de la tarea.

**Presupuesto (2.6):** mientras el producto no calcule el presupuesto del agente, «Necesitan atención» usa la última ejecución. Si se omitió por presupuesto, la tarea sale con «La última ejecución se omitió: presupuesto agotado» (ámbar). Cuando el producto lo calcule, el aviso pasa a «Presupuesto del agente agotado: las próximas ejecuciones se omitirán».

**Estados y motivos (2.7):** «En cola» (gris), «Ejecutando…» (spinner), «Completada», «Fallida», «Omitida» y «Espera aprobación». Fallida y Omitida llevan debajo su motivo, un texto fijo por código (Fallida en rojo, Omitida en gris):
- Omitida: `budget` «Presupuesto agotado» · `access` «El creador perdió el acceso al agente» · `central` «El creador dejó de ser persona central» · `overlap` «Otra ejecución seguía en curso» · `cap` «Se alcanzó el tope de investigaciones del día» · `paused` «La tarea se pausó» · `admin_paused` «Un administrador pausó la tarea» · `retired` «La tarea se retiró».
- Fallida: `agent` «El agente falló» · `budget_reserve` «No se pudo reservar el presupuesto» · `agent_unavailable` «El agente no está disponible» · `model_disabled` «El modelo del agente no está habilitado» · `identity` «No se pudo obtener la identidad del creador» · `enqueue` «No se pudo encolar».
- Reservados hasta que el producto los distinga: `tool` «Falló una tool · {tool}» y `timeout` «Se agotó el tiempo máximo de la ejecución». Hoy esos fallos salen como `agent`. Código desconocido: «No se pudo completar».
- Pausar o retirar una tarea omite las ejecuciones que esperaban en cola (`paused`, `admin_paused`, `retired`). Los códigos son los del prototipo; los textos, los del producto.
- Si una ejecución esperó en cola: «Esperó {n} min en cola».

**Ejecutar ahora (2.8):** como el producto.
- Al pedirla: aviso «{nombre} en cola»; la línea pasa a «En cola» y luego a «Ejecutando…».
- Al completarse: «{nombre} completada» · «El resultado está en el detalle de la tarea y en tu Bandeja.», con el botón «Ver resultado» (8 s).
- Si no se completa: «{nombre} no se completó» · {motivo}, con «Ver ejecución».
- Solo en tareas por horario. Las que arrancan por anomalía no tienen «Ejecutar ahora»: no hay anomalía que investigar.

**Pausa de un administrador (2.9):** como el producto.
- Pausa del dueño: inmediata, sin motivo. El dueño ve «Pausada: no se ejecutará hasta que la reanudes.»; un admin, «Pausada por {dueño}: no se ejecutará hasta que la reanude.». Un admin no la reanuda, pero puede tomarla con «Pausar» (ayuda: «También frena a su dueño: solo un administrador la reanuda.»).
- Pausa de un admin, sea de una tarea activa o tomando la del dueño: pide un motivo obligatorio. El dueño ve «Pausada por un administrador: no se ejecutará, ni a pedido, hasta que un administrador la reanude.» y «Motivo: {motivo}»; un admin ve el correo de quien la pausó («Pausada por {correo}:», o «Pausada por ti:»). La insignia dice «Pausada por un admin» (ámbar).
- El dueño ve «Ejecutar ahora» y «Reanudar» desactivados, con «Un administrador la pausó: solo un administrador la reanuda.». «Editar» sigue activo. Cualquier administrador reanuda una pausa de administrador.

**Disparador por anomalía de costo (3)**
1. En el editor de una tarea nueva, «Disparador»: «Por horario» o «Al detectar una anomalía de costo». Con el segundo no hay frecuencia ni zona, y aparece: «Hasta 5 investigaciones por día. Arranca sola cuando AWS publica una anomalía de costo y recibe sus datos. Una a la vez: si llega otra mientras investiga, espera en cola. Pasado el tope, las siguientes se omiten hasta el día siguiente (UTC).». Al editar, el disparador se muestra fijo: «… · No se cambia al editar; para otro disparador, crea otra tarea.».
2. Para quien no es persona central, la opción está desactivada y debajo se lee, siempre visible: «Solo las personas centrales pueden suscribirse a las anomalías de costo.».
3. En la lista: «Al detectar una anomalía de costo» (icono de rayo) y «Hasta 5 por día» en lugar de frecuencia y zona. «Próxima» muestra «—», o «Tope de hoy alcanzado» si ya corrió 5 veces. No cuentan para el indicador «Próxima ejecución».
4. En el detalle, la sección «Disparador»: Arranca · Tope «Hasta 5 investigaciones por día» · Hoy «{n} de 5 · se reinicia a las {hh:mm} (tu hora)» · Si llegan varias «Una a la vez; la siguiente espera en cola». El día es UTC, como las fechas de AWS, y cuentan las ejecuciones que arrancaron, no las omitidas.
5. Por decisión de seguridad, de la anomalía la ejecución solo recibe el id, el monitor y las fechas: ningún texto de AWS llega a la pantalla. Cada ejecución muestra «Anomalía · {fechas} · {id corto}», con los 8 primeros caracteres del id en mono, para distinguir las del mismo día. La caja «Anomalía que la arrancó» del resultado muestra las fechas y el id completo. Las ejecuciones de antes de que se guardara el id muestran solo las fechas, en la fila y en la caja. Servicio, cuenta e impacto los lee el agente con su tool y van en el informe. «Ver anomalía» solo cuando la aplicación tenga una página de anomalías. Si AWS vuelve a publicar una anomalía ya investigada, no se crea otra ejecución: no existe el caso «ya investigada».
6. «Costo estimado · mes» suma las tareas por horario (costo medio × ejecuciones del mes) y, para las de anomalía, lo que costaron en los últimos 30 días. El subtítulo, solo si hay tareas por anomalía: «Horario: costo medio · anomalías: últimos 30 días».
7. «Se ejecuta como…» no cambia. En «Entrega y control»: «Si {dueño} pierde el acceso o deja de ser central: La tarea se pausa sola».
8. Si llegan varias: la que llega mientras otra investiga queda «En cola» («Espera a que termine la investigación anterior») y corre cuando esa termina, dentro del tope. Si no llega a correr: «Omitida» · «Otra ejecución seguía en curso».
- Si el dueño deja de ser central, se ve «Pausada automáticamente hace {t}. {dueño} dejó de ser persona central. Solo se reanuda si vuelve a ser persona central; si no, retírala.», con «Reanudar» desactivado.

**Demo:**
- «Investigar anomalías de costo» (de Usuario 1) muestra ayer con 5 investigaciones, 2 omitidas por el tope y una que no alcanzó a correr; hoy lleva 3 de 5, una de ellas tras esperar en cola.
- «Cohort retention Q3» (de Usuario 2) está pausada por un administrador.
- La última ejecución de «Budget check diario» se omitió por presupuesto agotado, así que la tarea sale en «Necesitan atención».

**Pendiente del producto:**
- «Presupuesto del agente agotado» en «Necesitan atención».
- Guardar el texto de cada ejecución por tramos (pasos e informe).
- El aviso en la Bandeja.
- Distinguir el fallo de una tool (con su nombre) y el tiempo máximo agotado; hoy salen como «El agente falló».
- Siguen pendientes también: el evento «Persona registrada»; que el turno informe el motivo del aviso de AWS Billing; el motivo del fallo de una tool y la marca «cortado por guardrail» en el mensaje guardado.

## Precisiones tras implementar Schedules (2026-10-16)
Actualizado en la sección anterior:
- Motivos nuevos de Omitida y Fallida, con los textos del producto. `tool` y `timeout` quedan reservados.
- De la anomalía, solo fechas e id corto (id completo en el resultado). Se quita el caso «ya investigada».
- Quien pausó se muestra por su correo.
- «Necesitan atención» por presupuesto se calcula con la última ejecución, hasta que el producto calcule el presupuesto del agente.

**Pendiente del producto:**
- Calcular «Presupuesto del agente agotado».
- Distinguir el fallo de una tool y el tiempo máximo agotado.
- La Bandeja.


## Bandeja, gobernanza de tools y reportes de tarea (2026-10-16)
Archivos: `other-views.jsx` (Bandeja), `schedules.jsx` y `schedules-run.jsx` (reportes), `gov/connectivity.jsx` (comprobación diaria), `mcp-catalog.jsx` (`ToolKind`), `admin.jsx`, `policies.jsx`, `lifecycle.js`, `audit-budgets.jsx`, `store.js`, `app.jsx` (panel de demo), `Reporte de tarea.html` (plantillas del PDF).

**A. Schedules: confirmado**
- Todo lo de «Lo que quedó cerrado» coincide con el diseño. Motivos nuevos, anomalía solo con fechas, sin «ya investigada», correo de quien pausó y presupuesto por la última ejecución ya están en «Schedules · resultado, estados y anomalías de costo».
- Única diferencia: el diseño muestra «Anomalía · {fechas} · {id corto}» (8 caracteres en mono) y el id completo en «Anomalía que la arrancó»; el producto, solo fechas. *Cambio para el producto*: el id ya llega a la ejecución, distingue las anomalías del mismo día y va en el nombre del PDF.

**B. Bandeja** (disponible hoy: `inbox` en `AVAILABLE`; «Menciones» Próximamente; sin avisos de ejemplo)
- **Pestañas (2.3):** «Archivado» deja de ser pestaña. Pasa a un botón «Archivado» junto a «{n} sin leer», que cambia a «‹ Volver a la bandeja». Quedan Todo · Sin leer · Aprobaciones · Menciones: caben en los 440 px de la lista con «Próximamente». A ≤480 px se oculta la etiqueta; la pestaña sigue desactivada, con el texto emergente. *Cambio para el producto.*
- **Pantalla angosta (2.1), ≤900 px:** el patrón de Aprobaciones. Tocar un aviso reemplaza la lista por el detalle, con «‹ Volver a la lista» arriba. Esc también vuelve. El foco va al título del aviso y, al volver, a su fila. Archivar desde el detalle vuelve a la lista.
- **Más de una página (2.2):** «Mostrar más» al final de la lista, sin contador (como Auditoría y Personas), en Todo, Sin leer y Archivado. No carga sola al llegar al final. Mientras carga, «Cargando…» en el botón; si falla, «No se pudieron cargar más avisos.» con «Reintentar» (role="alert"). Sin más páginas, el botón no aparece (tampoco bajo «Nada por aquí.»). Cada pestaña pide su página con su filtro al servidor. *Cambio para el producto.*
- **Errores (2.5):** se adopta lo del producto. «No se pudo cargar la bandeja» con «Reintentar» (el estado de error de las demás pantallas); al cargar, cinco filas de esqueleto (role="status"). Si marcar, desmarcar, archivar o «Marcar todo como leído» falla: aviso «No se pudo guardar el cambio. Vuelve a intentarlo.» y el aviso queda como estaba. Si falla marcar como leído al abrir, no hay error: sigue sin leer y se reintenta la próxima vez que se abra.
- **«Ver resultado» de una ejecución que ya no existe:** Schedules abre la tarea, si existe, con el aviso «Esa ejecución ya no está disponible · Los resultados se guardan 90 días.».
- **Qué deja aviso (2.4).** Se confirma que no dejan aviso: cada ejecución omitida, las solicitudes propias mientras esperan y lo que confirma en el chat quien lo pidió. Se agregan dos avisos (Diseño completo; *cambio para el producto*):
  1. **La tarea dejó de correr** (tipo «Tarea», icono de pausa). Lo recibe el dueño, una vez por evento: «{tarea} · se pausó sola» («Perdiste el acceso al agente: no se ejecutará mientras no lo recuperes. Si no lo vas a recuperar, retírala.» o «Dejaste de ser persona central: no se ejecutará mientras no vuelvas a serlo.»); «{tarea} · un administrador la pausó», con «Motivo: …» y sin el correo del admin; «{tarea} · un administrador la retiró», con su motivo. Botón «Ver tarea». Sin estos avisos, una tarea que deja de correr solo se descubre entrando a Schedules.
  2. **Respuesta a tu solicitud** (tipo «Tu solicitud», en la pestaña Aprobaciones): «Aprobaron tu solicitud: {acción}», con la tarjeta de siempre («Ejecutar», «Cancelar solicitud» y el vencimiento), y «Rechazaron tu solicitud: {acción}», con el motivo. Aprobar no ejecuta: si quien pidió no se entera, la aprobación vence.
  - Reanudar no deja aviso.
- Orden: lo que te piden aprobar va arriba; el resto, del más reciente al más antiguo.
- Demo: panel › «Bandeja» (normal, cargando, error, falla al marcar o archivar, falla «Mostrar más», ejecución que ya no existe). Avisos de tarea: cuenta «Creador · finops-central» (Usuario 2: Cohort retention Q3, pausada por un admin) o «Creador · people» (Usuario 3: IAM audit mensual, se pausó sola). Respuesta a una solicitud: cuenta Admin (APR-203). Los avisos de más de un día aparecen leídos.

**C. Gobernanza de tools**
- **Comprobación diaria** (Ajustes › Conectividad, debajo de «Cuentas miembro», `DailyCheck`): se adopta lo del producto.
  - Cabecera «Comprobación diaria de las cuentas miembro» y la explicación: 06:30 UTC, `mango-health`, solo la entrada, CloudTrail y topic de alertas.
  - Resumen «{n} válidas · {n} inválidas · {n} pendientes» (singular con 1) y «Última comprobación: {fecha}».
  - Una fila por cuenta, con nombre, id e insignia.
  - El motivo va bajo la cuenta: en rojo si es inválida, en gris si está pendiente. Son inválidas «El rol intermedio de Mango rechazó la entrada.», «El rol de lectura no existe en esta cuenta o no acepta a Mango.» y «La sesión no quedó en esta cuenta.»; quedan pendientes «AWS no respondió; se vuelve a comprobar mañana.» y «No se alcanzó a comprobar en esta ronda.».
  - Si el rol intermedio no exige la identidad, arriba va la fila roja «Exige la identidad del usuario»: «El rol intermedio de Mango no la exige: sin ella, Mango no lee ninguna cuenta miembro…», con la insignia «no la exige».
  - Estados de carga, error y «aún no ha corrido», con los textos del producto. Sin cuentas objetivo, no aparece.
  - No se agregan «Volver a comprobar» ni historial: la prueba manual de arriba cubre lo primero.
  - Demo: «Conectividad · comprobación diaria».
- **Tool destructiva:** insignia roja «Destructiva · nunca se habilita», con el texto emergente «El manifiesto firmado la clasifica como destructiva: Mango no la habilita para ningún agente, ni con aprobación.». `ToolKind` (`mcp-catalog.jsx`) es la única fuente de la insignia de tipo; la usan el catálogo y el Builder.
  - Detalle del pack: aviso rojo «Una tool es destructiva: Mango nunca la habilita, ni con aprobación, y no se puede dar a un agente. El resto del pack funciona igual.». En «Antes de aprobar», «Incluye tools destructivas: no se habilitan, ni con aprobación.». En la fila del catálogo, «· 1 destructiva» en rojo. La tabla de tools tiene el filtro «Destructivas» solo si existe alguna.
  - Agent Builder: la fila queda desactivada, sin casilla y con «· No se puede dar a un agente.»; «Todas» no la incluye. Tampoco aparece en las políticas de aprobación.
  - Una tool sin clasificar se muestra como «Escritura · confirmación o aprobación», más la insignia gris «Sin clasificar» («El manifiesto no la clasifica: cuenta como escritura»).
  - Demo: «Catálogo de MCP · EC2 Operations con tool destructiva y sin clasificar» (`terminate_instances`, `modify_instance_attribute`).

**D. Reportes descargables** (solo Diseño completo: en «Disponible hoy» la casilla es Próximamente y no se ve nada más)
Decisiones sobre lo que el producto no había decidido:
1. **Formato: solo PDF**, A4 vertical (el contenido también cabe en Carta). Es lo que se adjunta a un caso o se reenvía a finanzas, y muchos correos y gestores de casos bloquean un HTML descargado, que además puede llevar código. Un solo formato da un solo estado, un límite y una auditoría.
2. **Lo pide la tarea, no el agente:** casilla «Reporte descargable» en el editor, apagada por defecto, que se puede cambiar al editar (vale para las próximas ejecuciones). No se escribe en la instrucción: Mango le pide al agente los datos.
3. **Un tipo fijo por disparador:** por horario, «Resumen de costos»; por anomalía, «Investigación de anomalía». Solo con agentes que leen Cost Explorer o la facturación; con otro agente la casilla queda desactivada: «{agente} no consulta costos: el reporte solo existe para agentes que leen Cost Explorer o la facturación.».
4. **Desde el chat, no por ahora:** el reporte pertenece a una ejecución, que es la que tiene dueño, retención y auditoría. Quien lo quiera en el momento crea la tarea y usa «Ejecutar ahora».
5. **Nombre del archivo:** `{tarea}-{AAAA-MM-DD}-{hhmm}.pdf`, con la fecha y la hora en la zona de la tarea. En las de anomalía, `{tarea}-{AAAA-MM-DD}-{id corto}.pdf`, con fecha UTC y los 8 caracteres de la anomalía. La tarea va en minúsculas, sin acentos, con guiones y hasta 60 caracteres. Ej.: `cierre-mensual-de-costos-2026-10-01-0800.pdf`.
6. **Límites:** 10 MB por archivo (uno normal pesa entre 250 y 450 KB). Tablas de hasta 25 filas, más «Otros {n}». Serie diaria de hasta 400 días. Notas y conclusión de hasta 4.000 caracteres; siguiente paso, hasta 280.
7. **Estados.** El reporte tiene estado propio y la ejecución sigue «Completada»:
   - Generando: «Generando el PDF · {tipo}» y «El informe ya está abajo; el PDF tarda un poco más.». En la fila de la ejecución, «Generando el PDF…».
   - Listo: tarjeta con «{tipo} · {periodo}», el nombre del archivo, «PDF · {n} páginas · {n} KB · se guarda hasta el {fecha}» y «Descargar». En la fila, «Descargar PDF» junto a «Ver resultado».
   - No se pudo: «No se pudo generar el PDF · {tipo}» con su motivo. `data`: «El agente no entregó los datos del reporte.»; `size`: «El reporte superó el tamaño máximo (10 MB).»; `render`: «No se pudo armar el PDF.». Solo `render` ofrece «Generar de nuevo», con los mismos datos, sin volver a ejecutar al agente y sin costo. En la fila, «No se generó el PDF» en rojo.
   - Al descargar: «Preparando…» mientras pide el enlace; si falla, «No se pudo preparar la descarga. Vuelve a intentarlo.» (role="alert").
   - Una ejecución fallida u omitida no tiene reporte.
8. **Quién lo ve:** solo el dueño descarga. Un administrador lee en «Entrega y control» «Reporte · PDF · {tipo} · solo {dueño} lo descarga», y en cada ejecución «PDF listo · solo {dueño} lo descarga», sin botón.
9. **Descarga y auditoría:** cada clic pide un enlace nuevo, que vence a los 5 min; la pantalla nunca lo muestra ni lo copia. Evento `schedule.report_download` «Reporte descargado», siempre visible: no es una lectura, porque el contenido sale de Mango. Registra actor, tarea, ejecución y archivo, sin el contenido, y su panel tiene la sección «Descarga».
10. **Bandeja:** el aviso de ejecución no cambia; con el PDF listo, su detalle suma «Descargar PDF». Si «Ejecutar ahora» genera un reporte, el aviso de completada termina con «El PDF tarda un poco más.».
11. **Pie del resultado:** «Solo tú ves este resultado y descargas el PDF: se obtuvo con tu acceso. Cada descarga queda en Auditoría.».

**Plantillas** (`Reporte de tarea.html`, dos páginas cada una; en el prototipo, «Descargar» abre esta página en el reporte que corresponde):
- Común: cabecera «Mango · {tipo}» y «Uso interno»; título; quién lo generó y cuándo; tira de tres cifras; cada bloque cierra con «Fuente: {tool} · …»; «Sobre este reporte» (de dónde salen los datos, las cifras, quién lo ve, hasta cuándo y el archivo); pie con tarea, ejecución y página. Tipografía IBM Plex Sans y Mono (licencia OFL, el servidor las incrusta): cuerpo y tablas de 11,5 a 12 pt; fuentes, leyendas y pie de 9,5 a 10 pt. El acento de Mango solo marca la anomalía y el siguiente paso. Las subidas van en rojo y las bajadas en verde, porque es costo.
- Resumen de costos: Total del periodo · Contra {periodo anterior} (% y USD) · Promedio diario (con el periodo en curso, «Pronóstico de cierre»). Costo diario en barras, con el promedio del periodo anterior punteado. Servicios que más gastan: 8, más Otros y Total, con barra. Cuentas: 5, más Otras y Total. Notas del agente en Markdown.
- Investigación de anomalía: Impacto · Esperado · Real. Costo diario desde 14 días antes, con la ventana de la anomalía resaltada y lo esperado punteado. «Qué la explica»: tipo de uso, servicio, cuenta, impacto y parte. Conclusión, «Siguiente paso» y «Consultas del agente» (lo que escribió antes de cada consulta, con la tool). El id, el monitor y las fechas los pone Mango, no el agente.
- **Datos que entrega el agente:**
  - `cost_summary`: periodo (desde y hasta), total, total anterior, pronóstico (opcional), serie diaria `[{fecha, costo}]`, por servicio `[{servicio, costo, anterior}]`, por cuenta `[{cuenta, nombre, costo, anterior}]` y notas.
  - `anomaly`: esperado, real, serie diaria `[{fecha, costo, esperado}]`, causas `[{tipo de uso, servicio, cuenta, impacto}]`, conclusión y siguiente paso.
  - El servidor valida los datos y calcula variaciones, partes y totales; si no pasan la validación, el reporte falla con `data`.
- **Para decidir en el producto:**
  - Cómo entrega el agente los datos: una salida estructurada al final o una tool interna. Si es una tool, no cuenta como consulta en «Pasos».
  - Las cifras del PDF son las que copió el agente. Si el servidor pudiera tomar las series de la respuesta de cada tool (por el id de la llamada), el documento sería más confiable; cada bloque ya cita su consulta.

**Demo de reportes:**
- «Cierre mensual de costos» (de Usuario 1, el día 1 a las 08:00): septiembre y agosto tienen el PDF listo y julio, «No se pudo armar el PDF» con «Generar de nuevo». Con «Ejecutar ahora» se ve «Generando…» y después el PDF listo.
- «Investigar anomalías de costo» ahora pide reporte: la investigación de S3 de hoy no lo tiene («El agente no entregó los datos del reporte.»).
- Panel: «Schedules · reporte PDF» (falla la descarga / «Ejecutar ahora» falla el PDF).

**Pendiente del producto:**
- Bandeja: «Archivado» fuera de las pestañas, «Mostrar más», el detalle a ≤900 px y los avisos «Tarea» y «Tu solicitud».
- Schedules: el id corto de la anomalía; los reportes PDF (parte D).
- Siguen pendientes: «Presupuesto del agente agotado», distinguir el fallo de una tool y el tiempo máximo agotado, el evento «Persona registrada», el motivo del aviso de AWS Billing en el turno y la marca «cortado por guardrail» en el mensaje guardado.

## Lo que tomó el producto de la ronda del 2026-10-16 (2026-10-19)
Revisado por el producto en «Disponible hoy», claro y oscuro, a 1440, 560 y 420 px.

**Cerrado, coincide con el diseño:** Schedules (id corto y completo de la anomalía), «Necesitan atención» por presupuesto, ejecución que ya no existe, Bandeja (Archivado, «Mostrar más», detalle a ≤900 px, carga, marcar al abrir), comprobación diaria, clase de cada tool y casilla del reporte Próximamente. Ningún pack de la versión trae una tool destructiva ni sin clasificar; en el prototipo se ven con el panel de demo.
- **Ejecuciones sin id:** las de antes de esta versión no tienen id de anomalía. La fila dice «Anomalía · {fechas}» y la caja «Anomalía que la arrancó», solo las fechas. Demo: la ejecución de hace tres días de «Investigar anomalías de costo» (sin PDF: es anterior a los reportes).

**Respuestas**
- **«Mostrar más» bajo una lista vacía (2.3):** confirmado, sin más páginas no aparece, tampoco bajo «Nada por aquí.». Era un fallo del prototipo: contaba las páginas de todos los avisos y no las de la pestaña. Ahora cada pestaña cuenta las suyas y vuelve a la primera al cambiar. Supone que una página vacía no trae cursor: si el servidor filtra después de leer, sigue leyendo hasta llenar la página o agotar el cursor. Si «Mostrar más» no trae nada, el botón desaparece.
- **Cuerpo del aviso de aprobación (2.4):** se queda el del producto, `{tool} · k=v, … · {regla}`, la misma línea de la tarjeta del chat. Ya se había decidido el 2026-10-04 (pregunta 2) y el prototipo no lo aplicaba. Va en mono en la fila (recortado con «…») y en el detalle (parte donde haga falta). Se quita «Política: …». Fuente única: `window.apCallLine` (`approvals.jsx`). En Diseño completo, el impacto va como frase aparte en el detalle, no en la fila.
- **Reportes (2.2):** sin cambios de diseño. Las tres decisiones nuevas ya estaban: solo el dueño descarga (D.8); se guarda 90 días, como el resultado de su ejecución («se guarda hasta el {fecha}» y «Hasta cuándo» de las plantillas); cada descarga queda en Auditoría (D.9). Siguen abiertas las dos de «Para decidir en el producto»: cómo entrega el agente los datos y si las cifras salen de la respuesta de cada tool.
- **Avisos «Tarea» y «Tu solicitud» (2.1):** siguen solo en Diseño completo, sin cambios.

**Pendiente del producto:**
- Bandeja: avisos «Tarea» y «Tu solicitud».
- Schedules: reportes PDF (parte D).
- Siguen: «Presupuesto del agente agotado», distinguir el fallo de una tool y el tiempo máximo agotado, el evento «Persona registrada», el motivo del aviso de AWS Billing en el turno y la marca «cortado por guardrail» en el mensaje guardado.


## Knowledge Bases, primera versión (D88) y lo que quedaba de la ronda del 2026-10-19 (2026-10-22)
Archivos: `kb-core.jsx`, `kb-source.jsx`, `kb-agent.jsx`, `kb-docs.jsx`, `knowledge.jsx`, `kb.css`, `data.js` (`knowledgeBases`), `lifecycle.js`, `admin.jsx`, `agent-review.jsx`, `approvals.jsx`, `other-views.jsx`, `chat.jsx`, `audit-budgets.jsx`, `store.js`, `shell.jsx`, `app.jsx`, `Reporte de tarea.html`.

**Dónde se ve.** Knowledge Bases está completa en los dos modos («Disponible hoy» y Diseño completo): menú, Builder, Revisión, Aprobaciones, Bandeja, chat y Audit log (`kb.*` entra en los eventos de «Disponible hoy»). Es la primera versión: solo S3. Confluence, Google Drive y GitHub quedan en el selector como Próximamente; los datos de ejemplo son todos de S3. La lista la ven creadores y administradores: depende de `mango-agent-creator` o `mango-admin`, no de `finops-central` (`canView` en `store.js`; ver «Ronda 17 e instalación real»).

**A1. Se mantiene.** Indicadores, búsqueda, filtros «Todas» · «Necesitan atención» · «Sin sincronizar», filtro por fuente (ahora «S3 · archivos subidos» / «S3 · bucket»), columnas, panel con «Resumen», «Documentos», «Probar búsqueda» y «Acceso y sync», frecuencias, «Sincronizar ahora» y los motivos de «no indexado».

**A2.1 · Una sola fuente por knowledge base (decisión de diseño).** Se elige al crearla y no se cambia: «Subir archivos» o «Un bucket que ya existe». No se mezclan, por tres motivos: un bucket es un espejo (lo que se borra en el bucket sale de Mango) y los archivos subidos no lo son, así que en una misma lista «Quitar» valdría para unos documentos y no para otros; la aprobación del bucket frena toda la knowledge base, y con las dos fuentes quedaría a medias; y el agente ya puede usar hasta 5, así que combinarlas es asociar dos. El alta lo dice: «No se cambia después. Para combinar las dos, crea una de cada una y asócialas al mismo agente». Si el producto modela las fuentes como lista, vale con una sola por knowledge base. Mezclar se puede agregar después sin romper nada; separar, no.

**Estados.** Bucket: Sincronizada · Sincronizando · Con avisos · Error · Sin sincronizar · Pendiente de aprobación · Bucket rechazado · Sin bucket (propuesta retirada) · No empezó · Borrando. Archivos subidos: Indexada · Indexando · Con avisos · Sin documentos · Borrando (no hablan de «sincronizar»). «Necesitan atención» = avisos, error, rechazado, sin bucket y no empezó; «Sin sincronizar» = nunca sincronizada y pendiente de aprobación. Debajo de la insignia, en la lista: la última sincronización, «por presupuesto», «supera el tope», «llave propia (KMS)» o «espera a un administrador». *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*

**A2.2 · Subir archivos** (Documentos › «Subir archivos», o el pie del panel; al crear una knowledge base de archivos se abre ahí).
- Zona para arrastrar o «elígelos en tu equipo». Tipos PDF, DOCX, TXT, MD, CSV y XLSX; hasta 50 MB por archivo y 20 por vez («Puedes subir 20 archivos por vez: se tomaron los primeros 20.»). Siempre a la vista: «Esta knowledge base: {n} de 1.000 documentos · {x} de 5 GB».
- Cada archivo: «Subiendo {n} %» con barra → «Subido · {tamaño}» o «Rechazado · {motivo}»: «Tipo no admitido», «Supera 50 MB», «La knowledge base pasaría de 1.000 documentos», «La knowledge base pasaría de 5 GB» (en el navegador) y «El contenido no es del tipo que dice» (lo responde el servidor al terminar de subir). Los subidos y los rechazados se quitan con «×». *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*
- «Guardar {n} archivos»: pasan a la lista como «Indexando» y luego «Indexado» o «No indexado · {motivo}». Ayuda: «Al guardar empieza la indexación. Lo que subas y no guardes se descarta mañana.». Mientras otra indexación está en curso, «Guardar» se desactiva: «Espera a que termine la indexación en curso para guardar.».
- Salir con archivos subidos sin guardar (volver, otra pestaña, cerrar o Esc): «Tienes {n} archivos subidos sin guardar. Si sales, no se agregan a la knowledge base y se descartan mañana.» con «Salir sin guardar» / «Seguir aquí».
- «Quitar» en cada documento (solo archivos subidos) pide confirmar en la misma fila: «Deja de aparecer en las respuestas de los agentes.». Mientras se borra, «Borrando». Para actualizar uno, se quita y se vuelve a subir.
- No se descarga el original: ni en Documentos ni en las citas. Documentos lo dice al final: «Los originales no se descargan desde Mango en esta versión.».
- Documentos muestra «No indexados», «En curso» e «Indexados» (20 y «Mostrar más»), con tamaño, páginas y fecha. *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*

**A2.3 · Un bucket que ya existe.**
- Campo «Bucket y prefijo» (`s3://bucket/prefijo/`). El servidor comprueba al enviar: «Ese bucket es de Mango y no se puede usar como fuente.» y «Ese bucket no está en la cuenta de AWS de la instalación. Solo se aceptan buckets de esa cuenta.» (en el prototipo, `mango-…` es de Mango y `otra-cuenta` o `externo`, de otra cuenta).
- Es una propuesta (`KBS-N`): la aprueba o rechaza un administrador distinto de quien la propuso, también si la propuso un admin. Mientras tanto la knowledge base está «Pendiente de aprobación» y no se lee nada; al aprobarse arranca la primera sincronización. Rechazo: «Bucket rechazado» con el motivo y «Proponer otro bucket». Quien la propuso puede «Retirar propuesta» (queda «Sin bucket»).
- Cambiar el bucket o el prefijo de una aprobada («Acceso y sync› Cambiar bucket o prefijo») es una propuesta nueva. **Decisión de diseño:** mientras se decide, sigue sincronizando desde el actual; si se aprueba, la siguiente sincronización lee el nuevo y saca lo que ya no esté. Un cambio rechazado deja una línea gris con el motivo.
- **Tarjeta de la solicitud** (Aprobaciones y Bandeja; `KbSourceFacts` + `KbSourceDecision`): «Leer un bucket en {kb}» o «Cambiar el bucket de {kb}»; knowledge base, bucket (y «Ahora lee de» si es un cambio), quién lo propuso, «La consultan» (grupos), frecuencia y «Comprobado: Es de la cuenta de AWS de la instalación y no es de Mango.»; historial; «Aprobar» (nota opcional) y «Rechazar» (motivo obligatorio, con sugerencias). Quien lo propuso: «Tú lo propusiste: lo aprueba otro administrador.» + «Retirar propuesta». En Aprobaciones van en la misma cola que las acciones (insignia «Bucket de S3», cuentan en «Esperan tu firma» y en el contador del menú); los admins ven todas, el resto solo las suyas. En la Bandeja, arriba con lo que te piden aprobar, en la pestaña Aprobaciones, con «Ver en Aprobaciones» y «Abrir knowledge base». Sin vencimiento (el contexto no lo pide). *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*
- **Llave propia (KMS):** se detecta al sincronizar. «Error» con «No se pudo leer el bucket: está cifrado con una llave propia del cliente (KMS) y esta versión no puede leerlo.». El aviso va también en el alta, en la tarjeta de aprobación y en «Acceso y sync». *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*
- «Documentos» de un bucket: «Vienen de {bucket}. Para agregar, cambiar o quitar documentos, hazlo en el bucket: se refleja en la próxima sincronización.». La frecuencia solo existe para buckets; las de archivos muestran «Indexación: cada archivo se indexa al guardarlo».

**A2.4 · Estados de la sincronización.**
- No empezó por presupuesto: «No empezó por presupuesto: los embeddings costarían unos USD {x} y el presupuesto no alcanza.» + «Vuelve a sincronizar cuando haya presupuesto.». *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*
- Supera el tope: «No empezó: el bucket tiene {n} documentos y el tope es 1.000.» (o «…ocupa {x} y el tope es 5 GB.») + «Acota el prefijo o reparte los documentos en varias knowledge bases.». Si ya había contenido: «Los agentes siguen usando lo indexado hace {t}.». *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*
- Ya hay una en curso: «Sincronizar ahora» se desactiva mientras se sabe que sincroniza; si el servidor responde que ya había una (otra pestaña, la programada), aparece bajo el botón «Ya hay una sincronización en curso de esta knowledge base. Espera a que termine.» (role="alert") y el estado pasa a «Sincronizando».
- Borrando: la fila sigue en la lista, atenuada, con «Borrando» y spinner, y el panel queda de solo lectura: «Ya no se usa en respuestas nuevas. Sale de la lista cuando se comprueba que ningún agente puede recibir sus fragmentos.».
- Borrar (dueño o admin, al final de «Acceso»): confirmación en línea. Con agentes publicados que la usan, el botón está desactivado: «No se puede borrar: la usa {agentes}, ya publicado(s). Quítala en una versión nueva de ese(os) agente(s) y vuelve a intentarlo.». El bucket no se toca.

**A2.5 · Agent Builder** (sección nueva «Knowledge bases», entre Tools y Límites).
- Solo ofrece las que su autor puede usar: las de grupos en los que está, sin las que se están borrando. Cada fila: nombre, fuente, tamaño, grupos y su estado si no está al día. Hasta 5 («{n} de 5»; al llegar, las demás se desactivan con «Máximo 5 por agente»).
- Si el agente ya tenía una que quien edita no puede usar: «Esta knowledge base ya estaba y no puedes usarla · No estás en sus grupos · se conserva», con «Quitar».
- Es parte de la versión: entra en el diff (`kbs` en `snapOf`, `diff` y `diffCount`). Reglas al enviar: más de 5, o una que ya no existe o se está borrando. Errores del servidor nuevos: «Una de las knowledge bases ya no existe o se está borrando. Quítala para enviar.» y «Ya no estás en los grupos de una de las knowledge bases que agregaste. Quítala o pide que te sumen a sus grupos.».
- **Revisión:** «knowledge bases · n» (o «n agregadas, m quitadas») debajo de tools, con sus grupos, su estado y el acceso parcial de cada una. Demo: REV-39 agrega Release Archive a DevOps Sentinel; REV-40 (Onboarding Buddy) usa Políticas de RH.
- **Chat:** las respuestas pueden traer «Fuentes · {kb}»: «[n] {documento} · p. {página}», y al tocar una se ve el fragmento en texto plano. Sin enlace al original. El paso del turno dice «Buscó en {kb} · {n} fragmentos». Demo: conversación de People Docs sobre vacaciones. *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*

**A2.6 · La alerta de exposición (D26) cambia de sentido** (cambio de seguridad). Ya no dice que alguien «podría ver su contenido a través del agente»: la búsqueda va con la identidad de quien pregunta. Ahora es **«Acceso parcial»**: grupos que usan un agente que la consulta y no están en la knowledge base, a quienes el agente les responde sin su contenido.
- Lista: insignia «Acceso parcial» («Algún agente que la consulta lo usan grupos que no están en esta knowledge base: a esas personas les responde sin su contenido.»).
- Detalle: «Acceso parcial. Estos grupos usan un agente que la consulta pero no están en esta knowledge base. A esas personas el agente les responde sin su contenido: la búsqueda se hace con la identidad de quien pregunta.», una fila por agente con sus grupos y «Si deben recibirlo, agrega esos grupos en «Acceso».». En «Agentes que la usan»: «Lo usan grupos sin acceso».
- Builder: «{kb}: {grupos} usa(n) este agente pero no está(n) en esa knowledge base. A esas personas el agente les responde sin su contenido…». Con personas agregadas por correo: «Las personas agregadas por correo reciben su contenido solo si están en sus grupos.» (no se puede saber de antemano).
- Ayuda de «Grupos que pueden consultarla»: «Solo las personas de estos grupos reciben su contenido, también a través de un agente…». Al crear o editar sin estar en ninguno de los grupos elegidos: «No estás en ninguno de estos grupos: verás sus documentos, pero no podrás probar la búsqueda ni recibir su contenido en el chat.».

**A2.7 · Quién ve qué** (`KB.access`).
- Lista: creadores y administradores. Documentos: quien la creó, administradores y creadores en sus grupos. Probar búsqueda: además, estar en sus grupos.
- **Decisión de diseño · editar:** grupos, frecuencia, documentos, bucket y borrar los cambian quien la creó o un administrador, como los agentes. Un creador en sus grupos ve documentos y prueba la búsqueda, pero no la edita; así nadie se suma solo a los grupos de una knowledge base ajena. Confirmar con el producto («crean y editan» los creadores).
- Estados por pestaña: Documentos, para quien no los ve: «No ves los documentos de esta knowledge base · Los ven quien la creó, los administradores y los creadores de agentes que están en sus grupos: {grupos}.». Probar búsqueda, para quien no ve los documentos: «No puedes probar la búsqueda · La prueba devuelve contenido…». Para quien los ve y no está en los grupos: «No estás en los grupos de esta knowledge base · La búsqueda se hace con tu identidad, igual que la de un agente: sin estar en {grupos} no recibirías nada. Haberla creado / Ser administrador no basta.».
- Resultados: fragmentos en texto plano con documento, página (si la hay) y puntaje; «Sin resultados.» si no hay. Sin contenido indexado, la pestaña lo dice («…el bucket espera aprobación», «…sube archivos para probarla»).

**A2.8 · Datos que quizá no estén.** «Consultas · 30 días» (indicador y «Uso · 30 días» del detalle): Próximamente, sin cifras; con la métrica, la cifra (demo). Embeddings: «Amazon Titan Embeddings v2 · Bedrock». Tamaño: en tokens después de indexar; antes, en bytes («48 MB · los tokens se conocen al indexar»). El detalle suma «Topes: {n} de 1.000 documentos · {x} de 5 GB». *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*

**A3 · Auditoría** (categoría Ajustes, «Abrir Knowledge Bases»; sección «Knowledge base» en el panel con knowledge base, agente, bucket, documento, documentos, fragmentos y motivo):
- `kb.create` «Knowledge base creada», `kb.update` «Knowledge base editada» (antes y después de grupos y frecuencia), `kb.upload` «Documentos agregados», `kb.doc_remove` «Documento quitado» (solicitado → aplicado), `kb.source_propose` «Bucket propuesto», `kb.source_approve` «Bucket aprobado», `kb.source_reject` «Bucket rechazado», `kb.source_withdraw` «Propuesta de bucket retirada», `kb.sync` «Sincronización de knowledge base» (solicitado → aplicado, o «no se aplicó» con `in_progress`, `kms_key`, `budget` o `limit`), `kb.delete` «Knowledge base borrada» (solicitado → aplicado cuando ningún agente puede recibir sus fragmentos).
- **Cambio de nombre:** `kb.query` pasa a ser «Consulta a knowledge base», una por cada consulta de un agente (quien preguntó, agente, knowledge base, fragmentos). Es una lectura: solo con «Mostrar lecturas». La prueba pasa a `kb.search_test` «Búsqueda de prueba», siempre visible. En las dos se registra quién, dónde y cuántos fragmentos; ni el texto buscado ni los fragmentos.

**B1 · Página de la Bandeja que llega vacía con cursor.** Si la primera página de una pestaña llega vacía y con cursor, no se dice «Nada por aquí.», que se contradice con el botón: se dice **«Nada entre los avisos más recientes.»** y debajo «Mostrar más», que trae los siguientes. Sin cursor sigue «Nada por aquí.» sin botón. Si una página posterior llega vacía con cursor, la lista no cambia y «Mostrar más» sigue. *Cambio para el producto* (solo el texto). Demo: Bandeja › «Página vacía con cursor» (mejor con «Creador · people», que no tiene aprobaciones fijadas arriba).

**B2.** Avisos «Tarea» y «Tu solicitud»: sin cambios, siguen solo en Diseño completo.

**B3 · PDF «Investigación de anomalía»** (`Reporte de tarea.html`, ejemplo actualizado al caso real: generado minutos después del aviso).
1. **Día que Cost Explorer aún no tiene completo.** Si la serie de los días de la anomalía suma menos que el real de AWS (más de un 5 % por debajo), los días de la anomalía que empezaron menos de 24 h antes de generar el PDF (en la práctica, el día UTC en curso; *corregido el 2026-10-23: así está el ejemplo y lo implementado*) se dibujan rayados con la etiqueta «incompleto» (leyenda: «aún incompleto en Cost Explorer») y bajo el gráfico va: «El {día} todavía no está completo en Cost Explorer, que puede tardar hasta un día. En los días de la anomalía la serie suma USD {suma} y AWS informa un real de USD {real}: el real de arriba es el de AWS.». No se inventa otra cifra para ese día. La tarjeta «Real» dice «según AWS». «Sobre las cifras» lo explica y la fuente del gráfico dice la hora de la consulta. Con varios días rayados, el texto nombra el rango.
2. **Fuente de «Qué la explica» por fila.** La fila que viene de la anomalía (`get_anomalies`) lleva «¹», el impacto que estimó AWS y la cuenta «—». El pie pasa a «Fuentes: ¹ get_anomalies · causa principal que informa AWS en la anomalía, con el impacto que estima AWS; la anomalía no trae la cuenta. El resto: get_cost_and_usage · …». Si todas las filas salen de una sola consulta, el pie es el de antes. En los datos de `anomaly`, cada causa lleva de qué consulta salió (lo sabe el producto, no lo escribe el agente). *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*

**Demo (panel):** «Knowledge Bases · «Sincronizar ahora»» (arranca / ya hay una en curso), «Knowledge Bases · al subir» (normal / un PDF no es del tipo que dice), «Knowledge Bases · consultas de 30 días» (Próximamente / con la métrica), «Knowledge Bases · subida abierta › Agregar 5 archivos de ejemplo» (uno se rechaza por tipo, otro por tamaño y `Formulario-escaneado.pdf` queda «No indexado · OCR sin texto legible»), Builder › errores de knowledge base, Bandeja › «Página vacía con cursor». Ejemplos: Security Baseline espera aprobación (propuso Usuario 3; firma Usuario 1); AWS Runbooks tiene un cambio de prefijo pendiente (propuso Usuario 6); SAP Procurement con avisos; Data Dictionary con llave propia; Release Archive supera el tope; Etiquetado de costos no empezó por presupuesto; Customer Docs rechazado; Guías de onboarding 2025 borrándose; Políticas de RH con acceso parcial (People Docs lo usa mango-admin). Para los estados de acceso: cuenta Admin en Políticas de RH (ve documentos, no prueba) o Data Dictionary (la creó y no está en sus grupos); «Creador · people» en AWS Runbooks (no ve documentos).

**Para decidir en el producto:**
- Qué presupuesto frena la sincronización (el de la instalación, el de quien la creó o uno propio) y si se muestra la estimación en dólares. El texto dice «el presupuesto no alcanza» sin nombrarlo. Si también frena el indexado de archivos subidos, va el mismo aviso y los archivos quedan sin indexar. *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*
- Editar una knowledge base: solo quien la creó y los administradores (arriba).
- Si quien propuso un bucket recibe un aviso «Tu solicitud» cuando se aprueba o se rechaza (el diseño no lo agrega; hoy lo ve en la knowledge base). *→ Corregido el 2026-10-23: ver «Ronda 17 e instalación real».*

**Pendiente del producto:**
- Knowledge Bases completo (D88), con las decisiones de arriba.
- Bandeja: texto de la página vacía con cursor; avisos «Tarea» y «Tu solicitud».
- Schedules: reportes PDF (parte D) con los dos casos de B3.
- Siguen: «Presupuesto del agente agotado», distinguir el fallo de una tool y el tiempo máximo agotado, el evento «Persona registrada», el motivo del aviso de AWS Billing en el turno y la marca «cortado por guardrail» en el mensaje guardado.


## Ronda 17 e instalación real (2026-10-23)
Archivos: `kb-core.jsx`, `knowledge.jsx`, `kb-docs.jsx`, `kb-agent.jsx`, `kb.css`, `data.js`, `chat.jsx`, `lifecycle.js`, `agent-review.jsx`, `other-views.jsx`, `store.js`, `audit-budgets.jsx`, `people.jsx`, `groups-admin.jsx`, `login.jsx`, `app.jsx`, `Reporte de tarea.html`.

**1. Construido como el diseño (confirmado, sin cambios):** lista, alta, panel, subida, «Quitar», «Sincronizar ahora» y borrar de Knowledge Bases; sección del Builder; bloque de la Revisión; tarjeta de la propuesta de bucket en Aprobaciones y Bandeja; «Nada entre los avisos más recientes.»; «Buscó en…» y «Fuentes» del chat; día incompleto y fuente por causa del PDF.

### 2.1 Knowledge Bases
- **Tope de una fuente.** Con más de 1.000 documentos o 5 GB, el servidor copia hasta el tope y la knowledge base se usa. Insignia «Con avisos» y, debajo en la lista, «supera el tope». Resumen: «Se copió hasta el tope: el bucket tiene más de 1.000 documentos o 5 GB.» y, para quien edita, «Acota el prefijo o reparte los documentos en varias knowledge bases.» (el texto de la web decía «reparas»: es una errata). Ya no existe «No empezó · supera el tope» ni el código `limit`. Demo: Release Archive.
- **Llave propia (KMS).** Se rechaza al proponer el bucket, como uno de Mango o de otra cuenta: «Ese bucket está cifrado con una llave propia del cliente (KMS) y esta versión no puede leerlo. Usa otro bucket o una knowledge base de archivos subidos.». Nunca llega a «Error». El alta y «Acceso y sync» lo avisan: «Al proponerlo se rechazan los buckets de Mango, los de otras cuentas y los cifrados con una llave propia del cliente (KMS), que esta versión no puede leer.». La tarjeta de aprobación lo da por comprobado: «Comprobado: Es de la cuenta de AWS de la instalación, no es de Mango y no usa una llave propia (KMS).» (se quitó «El cifrado se comprueba al sincronizar…»). Prototipo: un bucket con «kms» o «cifrado» en el nombre.
- **Error: fuente aprobada que no se pudo leer.** Estado real y distinto del de KMS. Lista: «Error» · «no se pudo leer». Resumen: «No se pudo sincronizar: Mango no pudo leer el bucket.» + «Los agentes siguen usando lo indexado hace {t}.» (o «Todavía no hay nada indexado.») y, para quien edita, «Vuelve a intentarlo con «Sincronizar ahora». Si sigue fallando, pide a quien administra AWS que revise el bucket.». Auditoría: «no se aplicó · {código}» (en el prototipo `sync_failed`). Demo: Data Dictionary (falló hace 5 h; lo indexado es de hace 2 días).
- **Primera sincronización tras aprobar.** El servidor espera hasta unos 2 minutos a que el acceso nuevo quede listo; la knowledge base ya está «Sincronizando». Debajo en la lista, «preparando el acceso»; en el resumen, «Preparando el acceso al bucket aprobado: puede tardar hasta 2 minutos. Después empieza la sincronización.». Vale también al aprobar un cambio de bucket.
- **«Sin bucket» sin propuesta retirada.** Si la propuesta del alta no llega a enviarse: al crear, aviso «Se creó la knowledge base, pero no se pudo enviar el bucket. Propónlo en «Acceso y sync».» (el panel se abre ahí, con el formulario relleno). Resumen: «Sin bucket. La propuesta del bucket no llegó a enviarse: no se lee nada.»; en «Acceso y sync», «No se envió · {bucket}». «Se retiró la propuesta…» queda solo para cuando alguien la retiró. *Cambio para el producto:* distinguir los dos casos.
- **Lo que el servidor no da** (tokens y fragmentos de una knowledge base, páginas de un documento, consultas de 30 días): no se muestran, en los dos modos. Lista y Builder: «{n} docs · {bytes}». Indicador «Documentos» (antes «Documentos indexados»): suma todos los documentos; subtítulo en bytes. Resumen: sin fila «Fragmentos»; «Tamaño» en bytes. Documentos: sin «págs.». «Consultas · 30 días» y «Uso · 30 días»: Próximamente. Con los datos (panel de demo) vuelven tokens, fragmentos, páginas y consultas. La página de una cita del chat sí llega (viene con el fragmento).
- **Quién la ve en el menú:** solo `mango-agent-creator` y `mango-admin`. No depende de `finops-central`: una persona central que no crea agentes no la ve (si la viera, recibiría «No tienes acceso»). En el prototipo `canView('knowledge')` mira creador o admin; `knowledge` salió de OWNER_VIEWS y CREATOR_VIEWS.
- **«Con avisos» para quien no ve los documentos:** sin cifra, «Algunos documentos no se pudieron indexar: los agentes no los ven.». La fila «Documentos» del resumen muestra solo el total.
- **Motivos de un documento** (textos de la web: aceptados). Al guardar, el servidor rechaza el archivo, que queda en la lista de subida como «Rechazado · {motivo}»: «El contenido no es del tipo que dice», «El tamaño no es el que se subió», «No se terminó de subir», «Está vacío», «La knowledge base llegó a su tope», «No se pudo guardar». Al indexar queda en Documentos como «No indexado · {motivo}»: «OCR sin texto legible», «Protegido con contraseña» (antes «PDF protegido…»: vale para PDF, DOCX y XLSX), «Formato no soportado», «No se pudo indexar». Si el servidor da alguno en el otro momento, el texto es el mismo.
- **Guardar con rechazos.** «Guardando…»; los aceptados entran en la knowledge base («{n} archivos guardados · indexando»); los rechazados se quedan en la lista con su motivo y un aviso: «{n} archivos no se guardaron: los rechazó el servidor al guardar. Siguen en la lista con su motivo; quítalos o corrígelos y vuelve a subirlos.». Si no hubo rechazos, vuelve a Documentos como antes. Ayuda: «Al guardar se comprueba cada archivo y empieza la indexación…».
- **Errores del servidor** (textos de la web: aceptados, salvo uno): «Ese bucket no existe en la cuenta de AWS de la instalación.», «No se pudo comprobar el bucket. Inténtalo de nuevo.», «Ya hay una propuesta pendiente para esta knowledge base.», «Esta knowledge base ya lee ese bucket y prefijo.» (sustituye al «Es el mismo bucket…» del navegador), «No se pudo empezar la sincronización. Inténtalo de nuevo.» (bajo «Sincronizar ahora», role="alert"), «Se creó la knowledge base, pero no se pudo enviar el bucket. Propónlo en «Acceso y sync».», «No se pudo buscar. Inténtalo de nuevo.». *Cambio para el producto (texto):* «La búsqueda está ocupada. Inténtalo en un momento.» pasa a «Hay demasiadas búsquedas en curso. Inténtalo de nuevo en unos segundos.» (dice por qué y no culpa a la persona). Los de Probar búsqueda van bajo el campo, role="alert", y se borran al escribir.
- **Ícono de subida:** se usa el de documento, como la web (botones, pie del panel y zona de arrastre).

### 2.2 Builder y Revisión
- **Revisión** (textos de la web, con un ajuste): «Hay knowledge bases que ya no existen o se están borrando: {ids}. Hay que quitarlas.» y «Quien editó esta versión no está en los grupos de estas knowledge bases: {ids}. Hay que quitarlas.» («Quien la editó» → «Quien editó esta versión»: «la» no tenía a qué referirse). Van en «No cumple las reglas de publicación» y bloquean «Aprobar». Las reglas de knowledge bases ya se evalúan en los dos modos. Demo: «Revisión · reglas de knowledge bases».
- **Builder sin la lista:** aviso «No se pudieron cargar las knowledge bases. Las que ya tiene el agente se conservan.» + «Reintentar». Debajo, «Tiene {n} knowledge bases · se conservan» con sus ids (no hay nombres sin la lista) y «Quitar» en cada una; no se pueden agregar. Demo: «Builder · lista de knowledge bases».

### 2.3 Chat
- **Fuentes:** una línea por cita, «[n] {documento} · p. {página}» (y «· {kb}» si son de varias). No se abren: el texto del fragmento nunca llega al navegador. Se guardan con la respuesta.
- **«Buscó en…»** se ve solo durante el turno y no se guarda: al volver a abrir la conversación solo quedan las fuentes (se quitó de la conversación de ejemplo).
- **Sin resultados:** «Buscó en las knowledge bases · ningún fragmento» (sin nombrar la knowledge base: no llega cuál), con el ícono en gris, y la respuesta sin «Fuentes». *Cambio para el producto (texto):* la web dice «· 0 fragmentos».
- Demo: escribe a People Docs; «Chat · búsqueda en knowledge bases» (con / sin fragmentos).

### 2.4 Aprobaciones y Bandeja
- «Resueltas» no muestra las propuestas decididas antes del 23/10: aceptado, sin cambio de diseño (quedan en Auditoría).
- Filtros: las propuestas solo aparecen con «Todas» o «Esperan tu firma» y sin filtro de agente ni de riesgo. Es lo que ya hacía el prototipo.

### 2.5 PDF de anomalía
- **Día incompleto:** se raya el día que empezó menos de 24 h antes de generar el PDF (en la práctica, el día UTC en curso), como el ejemplo y lo implementado. Corregido en B3.1.
- **«Sobre las cifras»:** «Costo en USD, como lo devolvió la consulta. Cost Explorer puede tardar hasta un día en completar el costo de un día, y AWS puede ajustar los últimos días.».
- **Cuenta de una causa:** si AWS la informa, va en la fila de `get_anomalies`; si no, «—». Pie: «… con el impacto que estima AWS y la cuenta, si AWS la informa (si no, «—»).». El ejemplo la muestra.

### 3. Líder de área sin área (nuevo)
Regla del servidor: con `bu-lead` y sin `finops-central`, exactamente un grupo `bu-<área>`.
- **Al entrar (403 `area_required`):** pantalla propia en el armazón del inicio de sesión, como «Todavía no tienes acceso». Sin área: «Tu cuenta no tiene área» · «Tu cuenta {correo} es de líder de área (bu-lead), pero no tiene ningún grupo de área. Un líder de área ve el gasto de una sola área, así que no puedes entrar hasta que tengas la tuya.». Con dos o más: «Tu cuenta tiene más de un área» · «… tiene {n} grupos de área: {grupos}… hasta que te quede una.». «Qué sigue»: «Pide a un administrador de Mango que te deje exactamente un grupo de área (bu-…) en Ajustes › Personas: ya te ve marcado ahí. Cuando lo haga, vuelve a comprobar; no hace falta que cierres sesión.». Botones «Volver a comprobar» y «Cerrar sesión». Si sigue igual: «Todavía no tienes un área. Si ya te lo corrigieron, espera unos segundos y vuelve a comprobar.». Queda en Auditoría como «Acceso denegado» · `area_required`. Los grupos de la cuenta salen del token.
  - *Cambio para el producto:* «Volver a comprobar» pide tokens nuevos (renovación con el refresh token, que trae los grupos actuales). Así la persona entra en cuanto el admin lo corrige, sin volver a iniciar sesión ni esperar hasta 60 min. Vale también para «Todavía no tienes acceso».
- **Ajustes › Personas · quién está mal:** insignia «Sin área · no entra» o «{n} áreas · no entra» (ámbar) en la fila; aviso arriba «{n} líderes de área no pueden entrar. Tienen bu-lead y ningún grupo de área, o más de uno: un líder de área necesita exactamente uno.» + «Ver cuáles» (filtro «Área por corregir», que solo aparece si hay alguno); en el panel, «No puede entrar a Mango. … En cuanto lo corrijas puede entrar con «Volver a comprobar», sin cerrar sesión.».
- **422 `area_required`** (no se aplica). Mismo texto si lo responde el servidor (en el panel, role="alert") y, antes de enviar, en la pantalla:
  - Dar bu-lead sin área: «No se puede dar bu-lead: no tiene un grupo de área y un líder de área necesita exactamente uno. Dale antes su grupo bu-<área>.» (con dos o más: «… tiene {n} grupos de área ({grupos}) … Quítale antes los que sobran.»).
  - Quitar la única área: «No se puede quitar {grupo}: es su única área y un líder de área necesita una. Para pasarlo a otra, usa «Cambiar de área»; para que deje de ser líder, quítale antes bu-lead.».
  - Dar otra área: «No se puede dar otra área a un líder de área: ya tiene {grupo}. Para pasarlo a {nuevo}, usa «Cambiar de área».».
  - Pedir quitar finops-central si queda sin área: «No se puede quitar finops-central: tiene bu-lead y ningún grupo de área, así que no podría entrar. Antes, déjale exactamente un área o quítale bu-lead.». Al aprobarlo: «No se pudo aprobar {id}: sin finops-central quedaría como líder de área sin exactamente un área. Déjale antes un área o quítale bu-lead. El cambio sigue pendiente.».
  - Invitar: «Un líder de área necesita exactamente un área: elige también su grupo bu-<área>.» o «… deja solo uno de {grupos}.» (bloquea «Enviar invitación»).
  - En la pantalla, «Agregar» se desactiva con el texto debajo; las opciones del selector lo anticipan («bu-lead · antes, su área», «bu-retail · usa «Cambiar de área»»); «Quitar» se desactiva con la explicación bajo el grupo.
  - Se aplican los cambios que arreglan o acercan a quien ya estaba mal (darle su área, quitarle una de sobra, quitarle bu-lead) y los que no tocan la regla. Se rechaza lo que deja mal a alguien que estaba bien o lo empeora.
- **«Cambiar de área…»** (en el grupo de área de un líder): elige el grupo nuevo y se aplica al momento, en un paso: quita el actual y da el nuevo a la vez, así nunca queda sin área. Ayuda: «… Su sesión abierta sigue con el área anterior hasta que se renueve (como mucho, una hora).». Auditoría: `directory.area_change` «Área cambiada» («Cambió el área de {correo}: bu-retail → bu-finanzas»). *Cambio para el producto:* hoy son cuatro pasos (quitar bu-lead, quitar el área, dar la nueva, volver a dar bu-lead); hace falta una operación que cambie los dos grupos a la vez.
- **Grupos · eliminar un `bu-<área>` que es la única área de algún líder:** al confirmar, aviso «Es la única área de {n} líderes de área: {correos, hasta 5} y {n} más. Si se elimina, no podrán entrar a Mango hasta tener otra. Cámbialos de área antes en Ajustes › Personas.». La propuesta lo repite en su resumen («· es la única área de {n} líderes de área, que no podrán entrar»), así lo ve quien aprueba. Avisa, no bloquea (el grupo puede retirarse a propósito). *Cambio para el producto:* leer los miembros del grupo al proponer (ListUsersInGroup).
- Demo: «Estado de la cuenta al entrar» › «Líder de área sin área» / «con dos áreas» (en la pantalla, cambia a «Con grupo» y pulsa «Volver a comprobar» para entrar). Directorio: usuario10 (sin área) y usuario18 (bu-retail y bu-finanzas). Para el aviso de Grupos: eliminar bu-retail.

### 4. Decisiones
- **Presupuesto de la sincronización:** se acepta lo implementado. «Sincronizar ahora» usa el presupuesto de quien la pide; la programada (y la primera tras aprobar), el de quien creó la knowledge base. El texto lo nombra: «No empezó por presupuesto: los embeddings costarían unos USD {x} y tu presupuesto no alcanza.» / «La sincronización programada no empezó por presupuesto: … y el presupuesto de {creador} no alcanza.». La estimación va solo si el servidor la da (sin ella: «… {presupuesto} no alcanza para los embeddings.»). Para quien edita: «Vuelve a sincronizar cuando haya presupuesto: «Sincronizar ahora» usa el de quien la pide; la programada, el de quien la creó.». Auditoría nombra siempre a la persona. Demo: Etiquetado de costos (la programada, por el presupuesto de Usuario 2); «Sincronizar ahora» la vuelve a frenar con el tuyo.
- **Quién edita una knowledge base:** quien la creó y los administradores; un creador en sus grupos la ve y prueba la búsqueda. Sin cambios; sigue pendiente de confirmar por el producto.
- **Aviso a quien propuso un bucket:** sí, como «Tu solicitud» (Diseño completo, con los demás avisos de ese tipo): «Aprobaron tu bucket para {kb}» · «Aprobó {admin}. Empieza la primera sincronización.»; «Rechazaron tu bucket para {kb}» · «Rechazó {admin}: «{motivo}». Puedes proponer otro desde la knowledge base.»; con un cambio, «Aprobaron / Rechazaron el cambio de bucket de {kb}» («La siguiente sincronización lee el prefijo nuevo.» / «Sigue leyendo el bucket actual.»). Con la tarjeta de la propuesta, «Ver en Aprobaciones» y «Abrir knowledge base». Sin aviso, un rechazo deja la knowledge base sin usar y nadie se entera. Demo: cuenta «Creador · finops-central» (Usuario 2: Customer Docs rechazado, Etiquetado de costos aprobado).

**Panel de demo:** «Knowledge Bases · al guardar archivos» (un PDF no es del tipo que dice), «Knowledge Bases · respuesta del servidor» (no se pudo comprobar, propuesta pendiente, al crear no se pudo enviar, no se pudo empezar, búsqueda saturada o falla), «Knowledge Bases · tokens, fragmentos, páginas y consultas de 30 días» (sustituye a «consultas de 30 días»), «Builder · lista de knowledge bases», «Revisión · reglas de knowledge bases», «Chat · búsqueda en knowledge bases», «Estado de la cuenta al entrar» (dos opciones nuevas). Buckets que el servidor rechaza en el prototipo: `mango-…`, `otra-cuenta` / `externo`, `no-existe`, `kms` / `cifrado`.

### 5. Pendiente del producto
- Knowledge Bases: textos y estados de arriba marcados *Cambio para el producto* («Sin bucket» no enviado, búsqueda saturada, «ningún fragmento»); Confluence, Google Drive y GitHub como fuentes; descargar el original desde Mango; tokens, fragmentos, páginas y consultas de 30 días.
- Líder de área: la pantalla de `area_required`, los textos del 422, «Volver a comprobar» con tokens nuevos, «Cambiar de área» en un paso y el aviso al eliminar un grupo de área.
- Bandeja: los avisos «Tarea» y «Tu solicitud» (ahora también el de bucket).
- Siguen: «Presupuesto del agente agotado», distinguir el fallo de una tool del tiempo agotado, «Persona registrada», el motivo del aviso de AWS Billing en el turno y la marca «cortado por guardrail».


## Gobernanza y Actividad · disponibilidad actual (2026-10-24)
Archivos: `other-views.jsx` (Governance), `activity.jsx`, `audit-budgets.jsx`, `store.js`, `policies.jsx`, `settings.jsx`, `app.jsx`, `styles.css`. `governance` y `activity` entran en `AVAILABLE`.

### Gobernanza
- **Quién la ve:** administradores y finops-central, en los dos modos (`canView('governance')`). finops-central firma aprobaciones aunque no sea admin (`approval.decide` en la cuenta «Usuario · finops-central», que ahora es Usuario 5).
- **Sin admin:** solo lo que puede abrir. Sin fila de presupuestos («Disponible hoy») ni de cambios de áreas, sin «Gasto de equipos», «Eventos auditados · 24 h», actividad reciente ni botón «Audit log»; las políticas van a todo el ancho. Subtítulo: «Qué necesita atención y cómo se están resolviendo las aprobaciones. Presupuestos, cambios de áreas y auditoría los ven los administradores.»; vacío: «No hay aprobaciones que esperen tu firma.».
- **Necesita atención:** «{n} aprobaciones esperan tu firma» (como en Aprobaciones: sin las que pediste ni las que ya firmaste, más los buckets que te toca decidir; sin riesgo); «{n} presupuestos pasaron el 80 %» (FinOps con el límite por defecto y los límites por usuario; rojo si alguno se agotó); «{n} cambios de áreas pendientes» (abre Ajustes › Áreas y OUs). Sin la fila de agentes que no están en línea: un agente está publicado o retirado.
- **Indicadores:** «Aprobaciones pendientes» · «La primera vence en {t}»; «Decisiones · 7 días»; «Eventos auditados · 24 h», sin lecturas y con el tope del servidor («Más de 5000»), debajo «Sin lecturas · con hash y Object Lock en S3» (no hay cadena ni digest). Sin «Gasto de equipos»: no hay presupuestos de equipo.
- **Políticas:** una fila por tool con solicitudes pendientes o de los últimos 7 días, con su regla (condición, aprobadores y vencimiento, `polSummary`) y cuántas solicitudes. No hay nombre de política.
- **Actividad reciente:** eventos reales de 7 días con los textos de Auditoría (evento; persona · detalle · resultado): solicitudes, aprobaciones, rechazos y vencimientos; cambios de políticas; cambios de presupuesto y turnos bloqueados por presupuesto; cambios de áreas; agentes retirados; versiones aprobadas o rechazadas; grupos y personas en grupos; solicitudes de packs. El Audit log de «Disponible hoy» muestra ahora también esos eventos. Evento nuevo `budget.block` «Turno bloqueado por presupuesto».
- **Estados nuevos:** cargando (esqueleto, role="status") y error («No se pudo cargar Gobernanza» · «Vuelve a intentarlo en unos segundos.» + «Reintentar»). Demo: panel › «Gobernanza» (normal, cargando, error, más de 5000 eventos).
- **Correcciones (los dos modos):** «Decisiones · 7 días» contaba como rechazadas las ejecutadas y las vencidas; «esperan tu firma» incluía las propias; los cambios de áreas no aparecían nunca (comparaba con la fecha de hoy y no con la del ejemplo); quien no es admin veía auditoría y cambios de áreas que no puede abrir.

### Actividad
- **Quién ve qué:** cada persona, lo de sus turnos de chat y sus tareas. Un admin, lo de todos; de otras personas solo metadatos (texto de la fila abierta: *sustituido, ver «Gobernanza y Actividad tras la instalación»*). «Abrir conversación» y «Ver ejecución» solo en lo propio; «Ver presupuestos», solo para admins.
- **Desfase:** lo propio aparece al momento; lo de otras personas, cuando termina su turno, con la hora de cada llamada. Demo: con la cuenta de admin, la primera consulta en vivo trae un turno de otra persona que estaba en curso.
- **«En vivo»:** cada 15 s; se pausa con la pestaña oculta y al volver consulta enseguida.
- **Lo que no hay:** parámetros de las tools (no se guardan), tickets, publicaciones y estado de los agentes («de {n} publicados»; «sin actividad en el periodo» solo para admins y sin estado). De presupuesto, solo «no respondió: se agotó el presupuesto».
- Tools por nombre, como en el chat. Las tareas toman los pasos de sus ejecuciones en Schedules («Tarea · {nombre}» en lo propio).
- **Retención:** con «7 días», al final: «Aquí se ven hasta 7 días. La actividad se guarda 30 días.».

### Pendiente del producto
- Confirmado por el producto: un admin ve la tool de cada llamada ajena, con el resultado o la latencia.
- `budget.block`: nombre y texto del evento del turno bloqueado.


## Gobernanza y Actividad tras la instalación (2026-10-25)
Archivos: `activity.jsx`, `other-views.jsx`, `audit-budgets.jsx`, `gov/kit.jsx`, `app.jsx`, `chat.jsx`, `lifecycle.js`, `marketplace.jsx`, `store.js`, `styles.css`.

### Actividad
- **De otra persona** (fila abierta): el texto nombra lo que muestra la fila. Llamada: «De otra persona: solo ves el agente, la tool, la hora y la latencia.» · error: «… la tool, la hora y el resultado.» · aprobación: «… la tool, la hora y el estado.» · turno bloqueado: «De otra persona: solo ves el agente y la hora.».
- **Sin texto que no existe:** la fila con error no lleva línea debajo (la respuesta de la tool no se guarda). «pidió aprobación para {tool}» va sin descripción (esta vista no tiene el catálogo).
- **Estado de la aprobación**, a la derecha (donde va la latencia): «pendiente» (ámbar; también aprobada sin ejecutar), «ejecutada» (verde), «rechazada» (rojo), «vencida» (gris). En el CSV va en «resultado»; el turno bloqueado, «bloqueado».
- **Latencia:** «N ms» bajo 1 s; «N,N s» bajo 1 min (19.319 ms → «19,3 s»); «M min S s» hasta el techo del turno (600 s → «10 min»). También en «Latencia media» y en la fila de la tool del chat (`window.fmtDur`). El CSV conserva los ms. Ejemplos en segundos: las llamadas de un turno van una tras otra y los pasos de una tarea reparten la duración de su ejecución (cuadran con Schedules).
- **≤760 px:** se ve la columna de latencia, resultado o estado; se oculta el ícono de tipo.
- **Tope de 1000 por consulta:** «Eventos · {periodo}» dice «Más de 1000» · «Se muestran los 1000 más recientes». Al final de la lista: «Este periodo tiene más de 1000 eventos. Se muestran los 1000 más recientes.». Indicadores, tipos y «agentes más activos» se calculan sobre esos 1000.
- **Cargando:** esqueleto de indicadores, filas y «agentes más activos» (role="status"). La barra de filtros se queda: cambiar de periodo vuelve a consultar.
- **Error:** «No se pudo cargar la actividad» · «Vuelve a intentarlo en unos segundos.» + «Reintentar».
- **Sin acceso (403):** «No tienes acceso a Actividad» · «Tu cuenta no tiene permiso para ver la actividad. Un admin de Mango puede darte acceso.».
- En los tres, «En vivo» y «Exportar CSV» se desactivan.
- **Falla «En vivo»** (*cambio para el producto*): la lista se queda y en la barra aparece «No se pudo buscar actividad nueva. Se vuelve a intentar en 15 s.» (role="status") hasta que una consulta funcione.
- Demo: panel › «Actividad» (normal, cargando, error, falla «En vivo», sin acceso, más de 1000 eventos en 7 días; esta última con la cuenta de admin, pasa a «7 días»).

### Gobernanza · sin acceso (403)
- Aviso propio: «No tienes acceso a Gobernanza» · «Gobernanza es para administradores y para FinOps central. Un admin de Mango puede darte acceso.».
- `GovKit.Denied` recibe la vista. Presupuestos, Ajustes y Audit log siguen con el aviso compartido.
- Demo: panel › «Gobernanza» › «Sin acceso (403)», o entra por URL con «Líder de área» o «Creador».

### «Agente aprobado» y «Agente retirado» (Gobernanza y Audit log)
- Texto propio, como el resto (persona · detalle · resultado). La persona es quien aprobó o retiró (el actor del evento).
  - Aprobado: «{agente} · v{n} · creado por {correo}».
  - Retirado: «{agente} · v{n} · motivo: “{motivo}”».
- Panel del evento: sección «Agente» con Agente, Versión, Creado por y, al retirar, Motivo.
- No se muestran el hash del contenido ni los identificadores de usuario. La persona va por su correo; si el identificador no se resuelve, se omite. Los datos crudos siguen en «Copiar JSON».
- El agente va por nombre; si ya no está en el catálogo, por su id.
- Ejemplo: «Agente aprobado» de FinOps v3, hace 8 h. Para «Agente retirado», retira un agente desde Agentes con la cuenta de admin.

### Pendiente del producto
- Resolver `created_by` a correo para el texto de «Agente aprobado».
- Falla de «En vivo»: confirmar el texto.


## Playground y Skills · disponibilidad actual (2026-10-25)
Archivos: `playground.jsx`, `skills.jsx`, `admin.jsx`, `agent-review.jsx`, `lifecycle.js`, `settings.jsx` (`ChangeList`), `gov/kit.jsx`, `store.js`, `app.jsx`. `playground` y `skills` entran en `AVAILABLE`. Todo lo de abajo es el modo «Disponible hoy»; «Diseño completo» no cambia.

### Playground
- **Quién:** creadores de agentes (mango-agent-creator) y administradores (`canView`, ya no por OWNER_VIEWS). «Qué probar»: «Tus borradores» (abiertos y rechazados, con el motivo) y «Publicados que editas» (admin: todos; si no, los que creó; misma regla que «Editar» en el Org Chart).
- **Se cambia solo para la sesión:** system prompt, modelo y temperatura (0–1). Tools, knowledge bases, skills, límites y acceso, en el Agent Builder. Las skills de la versión se listan de solo lectura: «Se cargan igual que en el agente publicado.».
- **Modelo:** los habilitados en Brains; con tools, solo los que admiten tools (`caps.tools`) · «Solo modelos que admiten tools.». Modelo que ya no está habilitado: el selector queda en «Elige un modelo», «{modelo} ya no está habilitado. Elige otro para probar y enviar.» y la misma línea en «Antes de enviar».
- **Costo:** bajo «Qué probar»: «… Nada de lo que pruebes aquí llega a los usuarios. Cada prueba cuesta como un turno de chat y se cobra a tu presupuesto mensual y al del agente.». Al comparar: «Son dos pruebas por pregunta, una por columna, y se cobran las dos.».
- **Tools:** «Las de lectura se ejecutan de verdad, con tu identidad: lo que no puedes consultar en el chat tampoco lo consulta aquí. Las de escritura nunca se ejecutan: la prueba se detiene cuando el agente pide una.». «No disponible» = pack no instalado (el agente responde sin ella).
- **Escritura pedida:** en la traza, la tool con «pediría aprobación · no se ejecuta» y la insignia «pidió escritura»; la tarjeta termina con «La prueba se detuvo aquí: el agente pidió {tool}, que es de escritura. En el Playground no se ejecuta ni se crea una solicitud en Aprobaciones.».
- **Preguntas sugeridas** (*textos para el producto*; fijos, sin datos, iguales para cualquier agente): «Explica qué puedes hacer y con qué herramientas», «Dame un ejemplo de una pregunta que respondes bien y respóndela», «¿Qué haces si te falta un dato para responder?» y «Prueba de seguridad» (`PG_ATTACK`). «Ejecutar todas» manda esas 4 (8 pruebas al comparar). Si el producto prefiere textos por categoría, van en `PG_FIXED`.
- **Cola:** corren hasta 2 a la vez; el resto, en la tarjeta: «En cola · empieza cuando termine otra prueba. Corren hasta 2 a la vez.».
- **Tarjeta:** texto, tools con su duración y «bien», tiempo, tokens de entrada y salida, costo en USD. Insignias: «Guardrail» (ámbar, «El guardrail base bloqueó la entrada o la salida»), «Supera tokens», «Tope de iteraciones», «Supera tiempo». 👍/👎 con «Solo en esta pantalla: no se guardan». «Guardar como caso» desactivado con «Próximamente» (no hay evals; también Costos › «Playground» y Evals › «Desde Playground»).
- **Vacío:** «Cada prueba es una pregunta sola, sin historial, y solo la ves tú. No se guarda: al salir de esta pantalla se pierde.».
- Las respuestas de `pgRespond` son del prototipo; el producto da la del modelo.

**Bloqueos** (aviso sobre las respuestas; «Ejecutar», «Ejecutar todas» y las sugeridas se desactivan):
- **Posible secreto:** ya no deja probar. «Hay un posible secreto en el prompt» · «Quítalo para probar: el prompt se manda al modelo y un secreto no puede llegar a su contexto. Tampoco se podrá enviar a aprobación.». Bajo el prompt: «Posible secreto en el prompt. Quítalo para probar y para enviar a aprobación.».
- **Sin presupuesto, tuyo:** «Tu presupuesto mensual se agotó» · «Las pruebas se cobran a tu presupuesto y al del agente, como un turno de chat. No puedes probar hasta el próximo mes o hasta que un admin lo suba.».
- **Sin presupuesto, del agente:** «El presupuesto mensual de {agente} se agotó» · «No se puede probar ni usar este agente hasta el próximo mes o hasta que un admin lo suba.».
- **Límite:** «Llegaste al límite de pruebas» · «Puedes hacer hasta 60 pruebas por hora y 2 a la vez. Podrás probar de nuevo en {n} s.» (cuenta atrás con los segundos que da el servidor).

**Estados**
- No disponible en la instalación (pantalla entera): «El Playground no está disponible en esta instalación» · «Esta instalación de Mango no tiene el Playground. Los agentes se siguen creando y enviando a aprobación desde el Agent Builder.».
- Cargando la lista: esqueleto del panel. Error: «No se pudieron cargar tus agentes» + «Reintentar».
- Cargando la versión elegida: esqueleto bajo «Qué probar». Error: «No se pudo cargar esta versión» · «Elige otra o inténtalo de nuevo.» + «Reintentar». Guardar y enviar se desactivan.
- Nada que probar: «No tienes nada que probar» · «Aquí aparecen tus borradores y los agentes publicados que puedes editar.» + «Crear agente».
- Falla a mitad: la tarjeta conserva lo recibido y «No se pudo completar la respuesta.» + «Reintentar» (role="alert").
- Borrador cambiado en otra pestaña (al guardar): «Este borrador cambió en otra pestaña» · «No se guardó. Recarga para ver la última versión; perderás los cambios de esta pantalla.» + «Recargar».
- Sin acceso (403): «No tienes acceso al Playground» · «El Playground es para quien edita agentes: creadores de agentes y administradores. …».
- Demo: panel › «Playground».

### Skills
- **Quién:** administradores y creadores de agentes (como Knowledge Bases; ya no exige finops-central). Proponen los dos; aprueba o rechaza, con motivo, un administrador distinto de quien propuso. Quien propuso solo la retira. Vence a las 72 h (en «Disponible hoy», `chgStatus` y `decideChange`).
- **Sin «Incluida con Mango» ni «Scripts»:** en «Disponible hoy» no se listan las skills con scripts; la cabecera: «Playbooks reutilizables sobre uno o más MCP, escritos como instrucciones. Cada versión la aprueba un administrador distinto de quien la propone: hasta entonces, los agentes siguen con la anterior.».
- **Ejecuciones · 30 d:** texto emergente «Veces que un agente cargó la skill en los últimos 30 días»; «Sin datos» con 0.
- **Detalle:** «Dueño» = «{correo} · propuso la v1»; «Última versión» = «v{n} · aprobó {correo} · {hace}». Sección nueva «Versiones · {n}»: «v{n} · Propuso {correo} · aprobó {correo} · {hace}».
- **Editor:** contador al pasar de 18.000 caracteres («{n} / 20.000»), tope de 20.000; hasta 10 entregas (el campo desaparece al llegar) y 10 MCP («{n} de 10»; el resto se desactiva). Mismos errores de antes más «Hasta 10 MCP», «Hasta 10 entregas».
- **Topes del servidor** (*textos para el producto*): 200 skills: «La instalación llegó al máximo de 200 skills. No se pueden crear más.» · 20 propuestas abiertas: «Ya hay 20 propuestas de skills abiertas, el máximo. Espera a que se decida alguna o retira una tuya.». Van bajo el editor (role="alert"); el editor no se cierra.
- **Tarjeta de aprobación** (`SkChangeBody` en `ChangeList`, solo pendientes): campos que cambian (nombre, categoría, descripción, MCP, entrega) y el texto completo de las instrucciones. En una versión nueva, «Comparar con v{n}» cambia a un diff por líneas contra la versión aprobada (y «Ver texto completo» vuelve). Nota de la lista: «Las proponen administradores y creadores de agentes; las aprueba o rechaza un administrador distinto. Vencen a las 72 h.».
- **Estados:** cargando (filas de esqueleto), error («No se pudieron cargar las skills» + «Reintentar»), sin acceso («No tienes acceso a Skills» · «Skills es para administradores y creadores de agentes. …»). Demo: panel › «Skills».

### Agent Builder · Skills (sección nueva, entre Knowledge bases y Límites)
- Hasta 10 skills por versión, cada una fijada como `skill@vN` (`snap.skills`). Fila: nombre, `id@vN`, sus MCP; si hay una versión aprobada más nueva, insignia «v{m} disponible» y «Pasar a v{m}»; «Quitar».
- «Agregar skill…» lista las aprobadas en su última versión; las que tienen un MCP sin habilitar salen desactivadas («· MCP no habilitado»). Al llegar a 10: «Ya tiene 10 skills, el máximo». Debajo: «Se agregan en su última versión aprobada. Si la skill recibe una versión nueva, el agente sigue con la suya hasta que pases a la nueva y se apruebe esta versión del agente.».
- Los agentes publicados no traen skills en «Disponible hoy» (hasta ahora no había dónde elegirlas).
- **Errores** (validación local y del servidor; *textos provisionales*):
  - No aprobada: «La skill {nombre} v{n} ya no está aprobada. Pásala a la última versión o quítala.»
  - MCP no habilitado: «La skill {nombre} requiere {MCP}, que no está habilitado. Quítala o pide que lo habiliten.»
  - MCP sin tools en el agente (ámbar en la fila): «La skill {nombre} requiere {MCP} y el agente no tiene ninguna de sus tools. Agrega una o quita la skill.»
  - Más de 10: «Un agente puede usar hasta 10 skills. Quita alguna.»
  - Del servidor, sin nombre (panel › «Builder · error del servidor al enviar»): «Una de las skills ya no está aprobada en la versión elegida. …», «Una de las skills requiere un MCP que no está habilitado. …», «Una de las skills requiere un MCP del que el agente no tiene ninguna tool. …».
- **Diff y Revisión:** `diff().skills`; cuenta un cambio por skill. Revisión: bloque «skills · {n} agregadas, {m} quitadas, {k} cambian de versión», con «~ {skill} · v2 → v3» para el cambio de versión y los errores de cada una. Historial de versiones: fila «skills».

### Pendiente del producto
- Chat: el popover «Skills y tools» y el botón «Skill» del compositor siguen en «Próximamente». **Falta decidir qué hace el botón «Skill».**
- Confirmar los textos marcados y si las preguntas sugeridas van por categoría.
- Que el 429 del Playground traiga los segundos de espera, y que el «sin presupuesto» diga de quién.


## Barra lateral colapsada · riel corto (2026-10-25)
Archivos: `shell.jsx` (`RailGroup`), `styles.css` (`.sb-rail-group`, `.sb-fly*`). La barra expandida y el menú del móvil no cambian.
- **Riel:** vistas principales · agentes fijados (hasta 4; con más, 3 + «Más agentes fijados ({n})») · un ícono por grupo: Gobernanza (Shield), Construir (Skill), Operación (Activity). Un grupo sin vistas visibles (`S.canView`) no aparece.
- **Ícono de grupo:** fondo y barra de acento a la izquierda si la vista actual está dentro; punto de acento si algo dentro tiene contador (aprobaciones pendientes, revisiones). Botón con `aria-haspopup="menu"`, `aria-expanded` y `aria-label` «{grupo}, contiene la vista actual, {n} pendientes».
- **Menú flotante** (a la derecha del riel, alineado con el ícono, ajustado al alto de la ventana): título del grupo; cada vista con ícono, nombre y, a la derecha, «Próximamente», su contador o ✓ si es la actual (fondo de acento, `aria-current="page"`). Las «Próximamente» no navegan.
- **Abrir y cerrar:** al pasar el cursor (120 ms) se abre y se cierra al salir (220 ms). Clic: lo fija abierto; otro clic lo cierra. Clic fuera o elegir una vista lo cierra.
- **Teclado:** Enter, Espacio, → o ↓ abren y llevan el foco a la primera vista; ↑/↓, Inicio/Fin recorren; Esc cierra y devuelve el foco al ícono; Tab cierra.
- El estado colapsado sigue guardado por persona (`mango-sb-collapsed`).
- **Títulos en el riel:** al pasar el cursor o con foco, cada ícono muestra su nombre en una etiqueta flotante a la derecha (`.sb-tip`, fuera del scroll del riel): vistas principales (con su contador, «· {n}», o «· Próximamente»), agentes fijados, «Más agentes fijados ({n})», «Expandir» y la cuenta. Los íconos de grupo no la llevan: su menú ya muestra el nombre. Se oculta al hacer scroll y mientras hay un menú abierto. Sustituye al `title` nativo.


## MCP remotos de terceros · piloto Azure DevOps (2026-10-26)
Brief D93/D94. Solo en **Diseño completo**; en «Disponible hoy» todo sigue en Próximamente (el botón «Conectar MCP por URL» queda igual). Archivos: `src/remote-core.jsx` (perfiles, registros, conexión, acciones, tarjeta del chat, diálogo de enlaces), `src/remote-views.jsx` (catálogo, ficha y alta, Mis conexiones, vuelta, Conectividad, Builder, Bandeja), `src/remote.css`. Estado en el store: `remoteRegs`, `remoteConn`, `remoteReturn`, `rmOpen`.
- **Catálogo › Servicios externos** (pestaña nueva; el botón de la cabecera pasa a «Agregar servicio externo» y abre la pestaña). Una tarjeta por perfil de la versión: operador, host, «Solo lectura», «Los datos salen de AWS», toolsets y estado. Ficha en drawer: organizaciones, tools por toolset (todas Lectura), permisos en Microsoft, host fijo, requisitos. Creadores ven ficha y estado; el alta solo admins.
- **Alta en dos pasos**: formulario (org con prefijo fijo `dev.azure.com/`, sin URL; tenantId y clientId GUID; secreto solo escritura; vencimiento; toolsets; grupos). Al enviar aparece la URL de redirección con «Copiar», visible mientras está pendiente. Quien pidió ve «Otra persona administradora tiene que aprobarlo.» y «Retirar solicitud»; el aprobador ve todo menos el secreto. Rechazar pide motivo y borra lo creado. Activo: «Rotar secreto» (sin aprobación), «Cambiar tenant o app» (solicitud nueva, la actual sigue hasta aprobarse), «Deshabilitar» (motivo). Errores del brief: duplicado, mismo aprobador, perfil fuera de la versión. Las solicitudes también salen en «Solicitudes pendientes».
- **Chat**: tarjeta «Conecta tu cuenta de {servicio}» debajo del mensaje del agente, fuera de `.md`, con cabecera de sistema «Mango · No lo escribió el agente», cuenta atrás de 10 min, estados abriendo / vencido / «Conectado. Vuelve a enviar tu pregunta.».
- **P10 · enlaces**: las tres ideas juntas. Marca «Leyó {servicio} · contenido de fuera de Mango» sobre la respuesta; los enlaces a dominios que no son del servicio llevan su host en rojo al lado del texto; el diálogo de un turno con tools remotas avisa de dónde vino el contenido, muestra el host grande con «Dominio de {servicio}» o «No es un dominio de {servicio}», y en ese caso «Cancelar» es el botón primario y el otro dice «Abrir de todas formas». Solo informa: no bloquea.
- **Mis conexiones**: en el menú de la persona (modal). Servicios de sus grupos con los estados del brief, más «no se puede conectar» cuando el secreto venció. «Desconectar»: *sustituido, ver «MCP remotos ya construidos (2026-10-27)»*.
- **Vuelta desde Microsoft**: vista `connect-return` con los seis resultados del brief. Nunca dice de quién era un enlace ajeno.
- **Ajustes › Conectividad**: bloque «Servicios externos» con org, toolsets, grupos, estado, vencimiento del secreto (avisos a 30 y 7 días y vencido), «Rotar secreto», «Deshabilitar».
- **Bandeja**: «Conecta tu cuenta de {servicio}» por tarea programada sin conexión (con «Ir a Mis conexiones», sin URL de Microsoft); solicitudes de alta fijadas arriba para admins; **propuesta**: el aviso del secreto por vencer o vencido también va a la Bandeja de los admins (pregunta abierta del brief).
- **Agent Builder › Tools**: grupo por registro activo con las marcas; quien no está en sus grupos ve «{servicio} no está habilitado para tus grupos.». **Propuesta**: aviso en el Builder cuando el agente es visible para grupos o personas fuera del registro. Las tools remotas van en `snap.remoteTools`, aparte de `snap.tools`.
- Actividad sin cambios.
- Panel de demo: registro, secreto, tu cuenta, error al pedir o aprobar, «Chat · servicio externo», «Vuelta desde Microsoft».


## Lo que queda tras la ronda 22 (2026-10-26)
**MCP remotos**
- **A1 · enlaces**: `RM.classifyLink` saca la organización de la ruta (`dev.azure.com/{org}/…`) o del subdominio (`{org}.visualstudio.com`). Solo una organización registrada en la instalación (habilitada, deshabilitada o creándose) se presenta como «Tu organización de {servicio} ({org})», en texto gris y sin insignia, con «Mango solo comprueba la dirección, no lo que hay en la página». Otra organización del mismo host va como externa: insignia roja corta «Otra organización» y debajo «{org} está en {servicio}, pero no es una organización registrada por tu empresa.» (otro dominio: «Otro dominio» · «No es un dominio de {servicio}.»), «Cancelar» como botón principal y el aviso de no escribir datos. En el mensaje, la etiqueta roja muestra `host/org`. La demo trae los tres casos: la organización registrada, otra organización y otro dominio.
- **A2 · estados**: «Creándose» (insignia azul con spinner; unos segundos tras aprobar) → «Habilitado» o «Falló» («No se pudo habilitar {servicio}» · «Revisa los datos de la app de Entra y vuelve a pedirlo.», con «Pedir de nuevo»). Rechazar y retirar borran secreto y URL, pero la solicitud queda en «Historial de solicitudes» de la ficha: org, estado, quién pidió, quién rechazó o retiró, motivo.
- **A3 · Playground**: si el agente tiene tools remotas y tu cuenta no está conectada, la prueba responde «Necesito que conectes…» y debajo va la misma tarjeta de Mango que en el chat.
- **A4 · Acceso condicional** (provisional, P9 sin probar): «Una regla de acceso de tu empresa bloqueó la conexión» · «El Acceso condicional de {proveedor} no dejó iniciar sesión desde este dispositivo o esta red, o pidió un paso que no se completó. Consulta con el administrador de {proveedor} de tu empresa.».
- **A5**: el pie de Mis conexiones usa los proveedores de los perfiles listados.
- **A6**: «Conectar» con la cuenta ya conectada en el servidor muestra en la fila «Tu cuenta ya estaba conectada.» sin abrir el proveedor.

**Playground** (las cajas de bloqueo van arriba de las pruebas, como las demás; además, hay una pista junto al campo afectado del panel izquierdo)
- model_without_tools: «Elige un modelo para probar» · «{modelo} no admite tools y este agente usa tools o knowledge bases.»; bajo el selector, «{modelo} no admite tools. Elige uno que las admita.».
- version_not_testable: «Esta versión no se puede probar» · «Solo se prueban los borradores y la versión publicada. Elige otra.».
- skill_unavailable: «Una skill de esta versión ya no está aprobada» · «{skill} v{n} ya no está aprobada. Cámbiala en el Agent Builder para probar.», con «Abrir en el Agent Builder»; la skill queda marcada «Ya no aprobada» en el panel.
- skills_unavailable: *sustituido, ver «MCP remotos ya construidos (2026-10-27)» › 7*. Antes: no bloquea. En el lugar de las skills: «No se pudieron cargar las skills de esta versión» · «La prueba corre igual, sin ellas. Inténtalo de nuevo en unos segundos.» · «Reintentar».
- agent_retired: «Este agente se retiró» · «Ya no se puede probar. Elige otro en «Qué probar».».
- Traza: «{n,n} s · falló» en rojo, con la insignia «1 falló» / «N fallaron»; «…» mientras corre. En «Disponible hoy» la traza ya no dice «pack no instalado» ni «no disponible»: una tool así sale como «falló». La insignia «No disponible» queda solo en el panel izquierdo.
- «Este borrador cambió en otra pestaña»: «Recargar» va dentro del cuerpo, como en el producto.
- Móvil (≤900 px): el panel izquierdo ya no tiene scroll propio; se desplaza toda la pantalla.
- Sesión que vence: igual que en el chat, termina la sesión (nada nuevo que dibujar).

**Chat · botón «Skill»**: **se quita** del compositor, porque sugería forzar una skill y eso no se puede. El popover «Skills y tools» se queda (en «Disponible hoy» sigue Próximamente hasta que exista): «Qué puede usar {agente}» · «Lo fija la versión que te responde. Cambiarlo es una versión nueva del agente, con su aprobación.». Las skills de la versión (hasta 10) van con nombre, descripción y versión, y la nota «Son instrucciones: no ejecutan nada. El agente carga una cuando le sirve; si quieres que use alguna, pídelo en tu mensaje y puede seguirlo o no.». Se quitó la insignia «write» de las skills. No se muestra qué skill se usó en un turno.


## MCP remotos ya construidos (2026-10-27)
El producto ya los construyó (rondas 22 y 23); siguen apagados por defecto hasta probar el Acceso condicional (P9). Archivos: `remote-core.jsx`, `remote-views.jsx`, `remote.css`, `chat.jsx`, `playground.jsx`, `share-agent.jsx`, `admin.jsx`, `lifecycle.js`, `other-views.jsx`, `app.jsx`. Todo solo en «Diseño completo».

### 1. «Desconectar» (D97)
- Sale de Próximamente. En Mis conexiones abre un diálogo: «Desconectar {servicio}» · «Mango borra tu conexión ahora y deja de leer {servicio} con tu cuenta en el chat, en tus tareas y en el Playground.» Lista: «Si un agente lo necesita, el chat te ofrece «Conectar» otra vez.» · «Tus tareas que lo usan van a fallar, y la Bandeja te avisa.» · «Para volver a conectar, inicias sesión en {proveedor} otra vez.». Pie gris: «Mango no cambia nada en tu cuenta de {proveedor}.» (no dice que Microsoft quitó el permiso). Botón de peligro «Desconectar» → «Desconectando…».
- Hecho: aviso «Desconectaste tu cuenta de {servicio}»; la fila vuelve a «No has conectado tu cuenta.» y la Bandeja vuelve a mostrar «Conecta tu cuenta de {servicio}».
- `disconnect_not_confirmed`: en el mismo diálogo, rojo: «No se pudo confirmar que se desconectó» · «Tu conexión puede seguir activa. Inténtalo de nuevo.»; el botón pasa a «Reintentar».

### 2. Alta y ficha
- **URL de redirección**: ahora es la callback de AWS, una por registro (ejemplo `https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/{uuid}`). Ayuda: «… La da AWS al crear la conexión de este registro: es distinta para cada uno y no es una dirección de Mango.».
- **Permisos en Microsoft**: los del perfil. «Azure DevOps MCP · delegados · de lectura» con sus permisos como chips (`vso.*` del ejemplo) y `offline_access` aparte (Microsoft Entra). Pie: «Los que pide el perfil del servicio.». Sin descripción por permiso.
- **Tools**: cinco grupos (Proyectos, Work items, Wiki, Pipelines, Búsqueda de código) con nombres reales (`core_project`, `wit_work_item`, `wiki`, `search_wiki`, `pipelines_build`, `search_code`…). Son ejemplo: la UI los pinta desde el perfil. Pie: «Los grupos y los nombres salen del perfil del servicio. Ninguno trae tools de escritura.». En toda la UI «toolsets» pasa a «grupos de tools» y «Grupos» a «Grupos de personas».
- **Se quitaron** la descripción, «Requisitos» y la descripción de cada permiso (el perfil no los trae). Si el producto los agrega al perfil, vuelven arriba de la ficha.
- **Cambiar tenant o app**: aviso ámbar en el formulario y en la revisión: «Al aprobarse, todas las personas tendrán que conectar su cuenta otra vez.». Grupos de tools y de personas se muestran sin editar: «Esta solicitud solo cambia tenant, app y secreto. Los grupos se cambian con «Cambiar grupos», sin que nadie reconecte.». Al habilitarse, las conexiones se borran.
- **Deshabilitar**: «Mango borra la conexión con {servicio} y el secreto de la app de Entra. Nadie podrá usar sus tools ni conectar su cuenta, y quienes ya la conectaron pierden la conexión. …» + «Para volver a habilitarlo hay que pedirlo de nuevo, con el secreto, y otra persona administradora tiene que aprobarlo.». En el registro deshabilitado: «Secreto de la app: Borrado al deshabilitar», sin URL; junto a «Pedir de nuevo»: «Pide el secreto otra vez y otra aprobación.».

### 3. Lo nuevo
- **Cambiar grupos** (registro activo, botón junto a «Rotar secreto»): formulario con grupos de tools y de personas, «Es una solicitud con doble aprobación, como el alta. Nadie tiene que volver a conectar su cuenta. Mientras no se apruebe, siguen los grupos actuales.». Sin cambios: «No cambiaste ningún grupo.». La revisión muestra el cambio con insignias «+ agregado» (verde) y «− quitado» (rojo, tachado). Insignia «Cambio de grupos» en la ficha, en Solicitudes pendientes y en la Bandeja. Uno a la vez por registro. Rechazada o retirada, queda en el historial.
- **Compartir fuera de los grupos del servicio** (`remote_audience_outside_groups`): aviso ámbar en «Compartir»: «Este agente usa tools de {servicio}, que solo está habilitado para {grupos}. Lo compartes con {toda la organización / los grupos … / n personas sueltas}: quien no esté en esos grupos usa el agente sin esas tools.». No bloquea.
- **`remote_not_usable`**: Builder (error del servidor, sección Tools): «Usas tools de Azure DevOps, pero no estás en los grupos de ese servicio. Quítalas o pide a un administrador que agregue uno de tus grupos.». Revisión: «Quien editó esta versión no está en los grupos de Azure DevOps: sus tools no se pueden usar. Hay que quitarlas.».
- **Builder**: se acepta que el catálogo no traiga el servicio a quien no está en sus grupos; la fila «no está habilitado para tus grupos» se quitó. Si el agente ya tiene tools de ese servicio, arriba de Tools: «Este agente tiene {n} tools de {servicio}, que no está habilitado para tus grupos» · «Para guardar una versión, quítalas o pide a un administrador que agregue uno de tus grupos al servicio.» + nombres + «Quitarlas». Se arma con los ids de `remoteTools` (prefijo del perfil), sin pedir los grupos.

### 4. Vuelta desde Microsoft
- **Terminando la conexión** (nuevo, primero en todos los casos con servicio): spinner · «Terminando la conexión…» · «Mango está guardando tu conexión con {servicio}. No cierres esta página.».
- **Sin sesión**: pantalla completa, fuera del marco de la app, con la marca arriba y sin nombrar el servicio: «Inicia sesión en Mango para continuar» · «Este navegador no tiene tu sesión de Mango abierta. Después de ingresar, vuelve a pulsar «Conectar» donde empezaste.» · «Iniciar sesión».
- **Se perdió el dato** (recarga o vuelta por el inicio de sesión de Mango): en vez de «El enlace venció», sin nombrar el servicio: «Vuelve a pulsar «Conectar»» · «No se pudo terminar la conexión: la página se recargó o tuviste que volver a iniciar sesión en Mango. Tu cuenta no quedó conectada.». «El enlace venció» queda solo para el enlace de 10 min.
- **Canceló en Microsoft** (*provisional*, falta probar qué devuelve): «Cancelaste el inicio de sesión» · «Tu cuenta de {servicio} no quedó conectada. Puedes intentarlo otra vez desde Mis conexiones.». Si el producto recibe lo mismo que «no autorizó», se usa ese texto.

### 5. Tarjeta «Conecta tu cuenta» y Bandeja
- Error al pulsar «Conectar» (tarjeta del chat y del Playground, y fila de Mis conexiones): el título y el cuerpo cambian en la tarjeta (título en rojo, `role="alert"`), el botón pasa a «Reintentar» y la cuenta atrás sigue. Textos: genérico «No se pudo iniciar la conexión» · «Inténtalo de nuevo en unos segundos.»; `identity_unavailable` «El servicio de identidad no responde» · «Mango no pudo pedir el inicio de sesión en {proveedor}. Inténtalo de nuevo en unos minutos.»; `rate_limited` «Demasiados intentos seguidos» · «Espera un minuto y vuelve a pulsar «Conectar».».
- Bandeja, `remote_connect` con el servicio fuera de Mis conexiones: aviso propio (tipo «Tarea», ámbar, no ejecución fallida): «Tu tarea no pudo leer {servicio}» · «La tarea "{tarea}" usa {servicio}, que ya no está en tus conexiones: lo deshabilitaron o ya no es de tus grupos. Va a fallar mientras el agente use sus tools.» · «Ver tareas».

### 6. Enlaces
- Solo cuentan las organizaciones de los servicios activos de los grupos de esa persona. Otra organización: «{org} está en {servicio}, pero no es una organización que puedas usar en Mango.».
- Builder: confirmado, todo servicio externo lleva «Los datos salen de AWS».

### 7. Pendiente de la ronda 23
- **Playground · skills_unavailable** ahora bloquea, arriba de las pruebas: «No se pudieron cargar las skills de esta versión» · «La prueba no puede correr sin ellas. Inténtalo de nuevo en unos segundos.» · «Reintentar». En el panel: «No se pudieron cargar. Sin ellas la prueba no corre.».
- **Skill no aprobada, plural**: «{n} skills de esta versión ya no están aprobadas» · «{a} v{n} y {b} v{n} ya no están aprobadas. Cámbialas en el Agent Builder para probar.». «Abrir en el Agent Builder» va a la derecha de la caja, fuera del cuerpo (como las demás acciones de `Banner`).
- **Popover «Qué puede usar {agente}»**: sin latencia ni salud (solo «{n} tools»). El botón muestra «–» en los dos contadores hasta abrirlo; al abrir, «Cargando…»; error: «No se pudo cargar qué puede usar {agente}» · «Inténtalo de nuevo en unos segundos.» · «Reintentar» (el contador sigue en «–»).

**Panel de demo** (nuevos): registro › «Cambio de grupos · pidió Usuario 6 / pediste tú»; «al pulsar «Conectar»» (error, identidad, demasiados intentos); «al desconectar» (no se confirma); «Vuelta desde Microsoft» › terminando, se perdió el dato, canceló; «Bandeja · tarea con servicio externo»; «Builder · tools de un servicio fuera de tus grupos»; «Revisión · quien editó no está en los grupos del servicio»; «Compartir · el agente usa Azure DevOps»; «Chat · «Qué puede usar» al abrirlo»; Playground › «Dos skills ya no aprobadas»; Builder › error «Servicio externo fuera de tus grupos».

**Pendiente del producto**: *sustituido, ver «Ronda 24 · MCP remotos (2026-10-28)»*.


## Ronda 24 · MCP remotos (2026-10-28)
Respuesta al contexto de la ronda 24. Archivos: `remote-core.jsx`, `remote-views.jsx`, `app.jsx` (panel de demo y vuelta a pantalla completa). Solo en «Diseño completo».

### 1. Se aceptan las diferencias de la web
- **Nombre del servicio**: sale del perfil; si no se sabe, «un servicio externo». Vale para `remote_not_usable` y para todo texto con {servicio}.
- **Permisos en {proveedor}**: una línea por recurso con sus permisos como chips, como trae el perfil (`Azure DevOps MCP` · `.default (delegado, lectura)`; `Microsoft Entra` · `offline_access`). Se quitó «delegados · de lectura». Se quitaron los `vso.*` de ejemplo.
- **«Compartir»**: sigue en Próximamente; el aviso ámbar de Builder › Tools cubre `remote_audience_outside_groups`. El aviso dibujado en «Compartir» queda para cuando exista.

### 2. La vuelta de Microsoft avisa a la pestaña que pidió «Conectar» (D100)
- **La pestaña que pidió «Conectar»** (tarjeta del chat y del Playground, fila de Mis conexiones): «Abriendo {proveedor}…» → **esperando**: «Inicia sesión en {proveedor} en la otra pestaña» · «Al terminar, la conexión se completa aquí. No cierres esta pestaña.», con «Abrir de nuevo» (por si cerró la de Microsoft) y la cuenta atrás → **«Terminando la conexión…»** · «Mango está guardando tu conexión con {servicio}.» → **«Conectado»** · «Tu cuenta de {servicio} quedó conectada. El agente sigue con tu pregunta.». El agente sigue solo: no se vuelve a enviar la pregunta (en la demo la respuesta aparece debajo de la tarjeta). Mis conexiones se actualiza sola.
- **No se pudo terminar** (en la tarjeta y en la fila, rojo, botón «Reintentar», la cuenta atrás sigue): `session_changed` «No se pudo terminar la conexión» · «Tu sesión de Mango cambió mientras iniciabas sesión en {proveedor}. Vuelve a pulsar «Conectar».»; no autorizó / canceló: «{proveedor} no autorizó la conexión» · «Tu cuenta no quedó conectada. Si no fuiste tú quien canceló, consulta con el administrador de {proveedor} de tu empresa.»; Acceso condicional: «Una regla de acceso de tu empresa bloqueó la conexión» · «Consulta con el administrador de {proveedor} de tu empresa.»; resto: «No se pudo conectar tu cuenta» · «Inténtalo de nuevo en unos minutos.». Enlace de 10 min vencido: la tarjeta pasa a «El enlace venció».
- **La vista de vuelta** (`connect-return`): siempre a pantalla completa con la marca arriba, fuera del marco de la app (es una pestaña auxiliar). Primero, spinner: «Terminando la conexión…» · «Mango la termina en la pestaña donde pulsaste «Conectar». No cierres esta página.». No nombra el servicio hasta que la otra pestaña confirma.
  - Hecho: servicio arriba + «Listo, vuelve a tu pestaña de Mango» · «Tu cuenta de {servicio} quedó conectada. El agente sigue ahí con tu pregunta. Puedes cerrar esta pestaña.» · «Cerrar esta pestaña». **Si la abrió Mango** (`window.opener`), muestra «Listo…» unos 2 s y se cierra sola.
  - Sin pestaña que la termine (se cerró, o su sesión cambió; reemplaza a «Vuelve a pulsar «Conectar»»): «Pídelo de nuevo desde Mango» · «La conexión solo se termina en la pestaña de Mango donde pulsaste «Conectar», y esa pestaña se cerró o cambió de sesión. Tu cuenta no quedó conectada.» · «Abrir Mango». La vuelta espera la respuesta unos 3 s antes de mostrarlo.
  - `consent_ambiguous` (texto propio): «No se pudo saber qué conexión terminar» · «Tienes más de una conexión a medias en Mango. Vuelve a pulsar «Conectar» en la que quieras terminar.». Con D100 casi no debería pasar: la pestaña sabe qué pidió.
  - Los resultados de Microsoft (canceló, no autorizó, Acceso condicional, venció) se muestran en la vuelta y también se avisan a la pestaña, que los muestra en la tarjeta. «Cancelaste el inicio de sesión» ya no nombra el servicio y dice «… desde Mango».
  - Botón de todos los errores: «Abrir Mango».
- **Varias pestañas de Mango**: solo la que pidió «Conectar» responde y termina; las demás no muestran nada (Mis conexiones se refresca al abrirlo).
- **Sin sesión**: con D100 la vuelta no necesita sesión para avisar, así que esta pantalla no debería salir. Si sale, texto que sirve para los dos casos (formulario de Mango o SSO): «Inicia sesión en Mango para continuar» · «Este navegador no tiene tu sesión de Mango abierta. Ingresa: si Mango puede, termina la conexión solo; si no, te pide que vuelvas a pulsar «Conectar».».

### 3. «Desconectar» con el secreto de la app vencido
- Conectada: «Tu cuenta sigue conectada, pero los agentes no pueden leer {servicio} hasta que un administrador renueve su configuración.» + «Desconectar» (secundario). Sin conectar: el texto de siempre, sin botón (no hay nada que quitar).

### 4. Bandeja · `remoteGone` sin el nombre del servicio
- «Tu tarea no pudo leer un servicio externo» · «La tarea "{tarea}" usa un servicio externo que ya no está en tus conexiones: lo deshabilitaron o ya no es de tus grupos. Va a fallar mientras el agente use sus tools.» · «Ver tareas». Ya no depende de que el aviso traiga el nombre (si lo trae, se pone en lugar de «un servicio externo»).

### 5. Servicios externos apagados en la instalación (`RemoteMcpEnabled`)
- Lo dice el perfil. Aviso ámbar arriba de la pestaña «Servicios externos», de cada ficha y de Ajustes › Conectividad: «Los servicios externos están apagados en esta instalación» · «Los enciende quien administra AWS con el parámetro `RemoteMcpEnabled` de la instalación. Mientras tanto puedes ver las fichas, pero no habilitar ni cambiar nada.».
- Tarjeta del catálogo: insignia gris «Apagado en la instalación» en lugar del estado. Ficha: «Habilitar para una organización» desactivado + «Apagado en la instalación». En un registro, el pie solo dice «Apagado en la instalación: no se puede aprobar ni cambiar nada.».
- **`remote_disabled`** si aun así llega (el perfil no lo dijo): bajo el botón del formulario, «Los servicios externos están apagados en esta instalación. Los enciende quien administra AWS con un parámetro de la instalación.». También al aprobar y al reintentar.
- No cubierto: qué ven chat, Playground y Mis conexiones con la función apagada y registros viejos. Propuesta: Mis conexiones vacía con el mismo aviso, sin nombrar el parámetro.

### 6. «Falló»: el texto depende del código, y «Reintentar»
- Código de plataforma (`target_timeout`, `target_failed`): «No se pudo habilitar {servicio}: el servicio no quedó listo a tiempo» / «…: la plataforma no pudo crear el servicio» · «Fue un fallo de la plataforma, no de los datos de la app de Entra. Reinténtalo: no pide el secreto ni otra aprobación.». «Reintentar» es el principal.
- Código de la app de Entra (`provider_rejected`, *nombre por confirmar*): «No se pudo habilitar {servicio}: {proveedor} rechazó los datos de la app de Entra» · «Revisa el tenant, el id de la app y el secreto en Entra, y pídelo de nuevo.». «Pedir de nuevo» es el principal.
- Código desconocido: «No se pudo habilitar {servicio}» · «Reinténtalo. Si vuelve a fallar, revisa los datos de la app de Entra y pídelo de nuevo.».
- Debajo, en gris: «Código: `{código}`». En Conectividad, el título + «Reinténtalo desde el catálogo.» o «Revisa la app de Entra y pídelo de nuevo.».
- **«Reintentar»** (`POST …/registrations/{id}/retry`, solo desde «Falló»; cualquier admin, también quien pidió): sin confirmación (no cambia nada de lo aprobado ni borra nada). «Reintentando…» → «Creándose» con «Reintentado por {persona}» → «Habilitado» o «Falló». Aviso: «Reintentando · Mango vuelve a crear la conexión». Pie: «Reintentar usa la misma aprobación y no cambia nada de lo aprobado. Pedir de nuevo pide el secreto otra vez y otra aprobación.». Errores bajo los botones: `release_changed` «Esta versión de Mango cambió el perfil de {servicio} desde que se aprobó. Hay que pedirlo de nuevo.»; `busy` «Ya se está reintentando. Espera unos segundos.».

**Panel de demo** (nuevos o cambiados): «Servicios externos · en la instalación» (encendidos, apagados, apagados sin que el perfil lo diga); «código del fallo»; «al reintentar»; «Vuelta desde Microsoft · y lo que ve tu pestaña al pulsar «Conectar»» (la opción elegida abre la vuelta y también decide cómo termina «Conectar» en el chat y en Mis conexiones).

### 7. Sigue abierto
*Sustituido, ver «Ronda 25 · MCP remotos (2026-10-28)».*

### 7 (anterior). Sigue abierto (sin cambios en esta ronda)
- MCP remotos: qué devuelve cancelar en Microsoft (prueba en vivo); nombre real del código de fallo de la app de Entra; chat y Mis conexiones con la función apagada; si el perfil agregará descripción, requisitos y descripción de permisos.
- De rondas anteriores (lista del contexto de la ronda 24, §5): respuesta cortada por tope y por tiempo, cuota de Bedrock, autoscroll mientras responde, «+» con el primer mensaje sin guardar, dos «Reintentar» en el historial, sesión que no se renueva y error a pantalla completa; 429 dentro de la app, página «Demasiadas solicitudes» y esperas que no son de un minuto; correos rechazados en ingreso y registro; `area_required`; destello de «Otro cambio se está aplicando…» y «Aprobar» a 420 px y en oscuro; «0 resultados»; «Tokens por llamada»; «Sin bucket» no enviado y fuente aprobada que no se pudo leer; 13 de 23 vistas en Próximamente.


## Ronda 25 · MCP remotos (2026-10-28)
Respuesta al contexto de la ronda 25. Archivos: `remote-core.jsx`, `remote-views.jsx`, `remote.css`, `app.jsx`. Se aceptan las diferencias del §2 del contexto (sin `window.opener`, sin «Cancelaste…», sin `nosession`, Conectividad apagada con «Rotar secreto» y «Deshabilitar», `remoteGone` como ejecución fallida hasta leer Mis conexiones).

### Decisiones
- **«Conectado» en la tarjeta (chat y Playground):** «Conectado» · «Tu cuenta de {servicio} quedó conectada. Envía tu pregunta otra vez para que el agente lea {servicio}.» + **«Enviar de nuevo»** (principal). Lo hace la interfaz: manda la última pregunta de la persona como un turno nuevo, igual que si la escribiera. Tras pulsarlo: «Enviaste tu pregunta otra vez.» y el check. *Cambio para el producto:* el botón. Si el producto llega a continuar el turno solo, se vuelve al texto de la ronda 24 y se quita el botón.
- **Vuelta · «Listo»:** «Tu cuenta de {servicio} quedó conectada. En la pestaña donde pulsaste «Conectar», envía tu pregunta otra vez. Esta ya no hace falta.». Ya no dice que el agente sigue. Intenta cerrarse a los 2 s; si el navegador no la deja, el botón se reemplaza por «El navegador no deja que Mango cierre esta pestaña. Ciérrala tú: tu pestaña de Mango ya está al día.». No lleva a Mango (abriría otra pestaña de Mango más).
- **Navegador bloqueó la pestaña (`popup_blocked`):** «El navegador bloqueó la pestaña de {proveedor}» · «Permite las ventanas emergentes de Mango en este navegador y vuelve a pulsar «Conectar».», en rojo con «Reintentar» (un clic nuevo suele bastar). *Cambio para el producto:* distinguirlo del error genérico (`window.open` devuelve `null`).
- **«Abrir de nuevo»:** se acepta como está. La cuenta atrás mide la conexión pedida en el chat, no la URL.
- **Rama de la app de Entra en «Falló»:** se quita. «Reintentar» es siempre el principal; el código desconocido sigue con «Reinténtalo. Si vuelve a fallar, revisa los datos de la app de Entra y pídelo de nuevo.». Si algún día existe el código, se vuelve a dibujar.
- **«Reintentado por {persona}»:** no hace falta. Mientras se crea de nuevo: «Aprobado por {persona}». El reintento ya queda en Auditoría (`remote_mcp.retry`).
- **Función apagada fuera de administración:** Mis conexiones sin lista, con «Los servicios externos están apagados en esta instalación» · «Cuando un administrador los encienda, aquí vas a poder conectar tu cuenta.». Tarjeta del chat y del Playground (si llega): «Los servicios externos están apagados» · «Esta instalación de Mango tiene apagados los servicios externos, así que el agente no puede leer {servicio}. Si lo necesitas, avisa a un administrador de Mango.», sin botón. Ninguno nombra el parámetro.
- **Enlace inventado para «autorizar»:** en un turno con la tarjeta «Conectar», los enlaces del texto del agente que no son de una organización registrada no se pueden abrir: texto tachado en rojo, sin enlace, con el destino en el texto emergente («Enlace quitado por Mango · {dominio}»). Debajo del texto: «Mango desactivó un enlace del agente. Para conectar tu cuenta usa solo «Conectar», en el aviso de Mango.» (plural: «{n} enlaces»). Los de tu organización siguen igual. *Cambio para el producto.*
- **Vuelta sin sesión:** se quita del diseño.
- **«Cancelaste el inicio de sesión»:** se conserva en el diseño para cuando la prueba en vivo diga que Microsoft lo distingue.

**Panel de demo:** «Chat · servicio externo» › «Falta conectar · el agente escribió un enlace»; «al pulsar «Conectar»» › «El navegador bloqueó la pestaña»; se quitaron «App de Entra» y «Sin sesión de Mango». Con «en la instalación: Apagados», el chat y Mis conexiones muestran el estado apagado.

### Sigue abierto
- Qué devuelve cancelar en Microsoft (prueba en vivo); si el perfil agregará descripción, requisitos y descripción de permisos.
- Lo de rondas anteriores (§5 del contexto), sin cambios: respuesta cortada por tope y por tiempo, cuota de Bedrock, autoscroll, «+» sin guardar, dos «Reintentar», sesión que no se renueva y error a pantalla completa; 429; correos rechazados; `area_required`; «Otro cambio se está aplicando…» y «Aprobar»; «0 resultados»; «Tokens por llamada»; Knowledge Bases; vistas en Próximamente.


## Ronda 26 · MCP remotos (2026-10-29)
Respuesta al contexto de la ronda 26. Archivos: `remote-core.jsx`, `remote-views.jsx`, `remote.css`, `app.jsx`. Se aceptan las diferencias del §2 (enlaces quitados también en el Playground; «Enviar de nuevo» sin turno en curso ni agente usable; la tarjeta apagada «si llega»).

### Decisiones
- **«Enviar de nuevo» tras recargar:** se quita si la conversación ya tiene una pregunta de la persona después de la tarjeta. Queda «Enviaste tu pregunta otra vez.» y el check. Se deduce de la conversación, sin guardar que se pulsó. Si no hay pregunta posterior, se ofrece otra vez.
- **«Enviar de nuevo» con un turno en curso:** sale desactivado, y debajo del texto: «Podrás enviarla cuando termine la respuesta en curso.». Al terminar ese turno se activa solo. Si el agente o la versión ya no se pueden usar, sigue como está (sin botón).
- **Enlaces mientras se lee «Mis conexiones»:** no se marca nada hasta saberlo. Los enlaces del agente salen como texto normal, sin tachar, sin aviso y sin poder abrirse. Al llegar la lista: los de tu organización vuelven a ser enlaces y el resto se tacha, con el aviso. Así no hay un destello en rojo.
- **Playground:** confirmado. La regla vale en cualquier turno con la tarjeta «Conectar».
- **Toolset «Repositorios»:** sale en el catálogo como cualquier otro, con tres marcas propias que pone Mango (el perfil no trae descripción), según el id del toolset:
  - En la ficha, debajo del nombre del grupo: la insignia ámbar «Código fuente» y «Da al agente el código fuente de la organización: archivos, commits y pull requests, con la cuenta de cada persona.».
  - En el alta y en la petición de cambio, al marcarlo: el aviso ámbar «Repositorios da al agente el código fuente» · «El agente va a poder leer archivos, commits y pull requests de los repositorios a los que llega la cuenta de cada persona.». No bloquea.
  - En el detalle de la petición, para quien aprueba: el chip «Repositorios · código fuente» en ámbar.
  *Cambio para el producto:* una lista de toolsets sensibles en Mango (`repositories`) hasta que el perfil lo diga.
- **Búsqueda de código:** en la ficha, debajo del grupo: «**Requisito:** Necesita la extensión Code Search de Microsoft instalada en la organización. Sin ella, la búsqueda no encuentra nada y el agente responde que no hubo resultados.». No se repite en el alta ni en el chat: Mango no puede saberlo.

**Panel de demo:** nuevo «Chat · servicio externo · conversación» (Normal, Otro turno responde, Recargada · ya hay una pregunta después, Mis conexiones sin leer). El perfil de ejemplo trae «Repositorios» con seis tools.

### Sigue abierto
- Qué devuelve cancelar en Microsoft (prueba en vivo); si el perfil agregará descripción, requisitos y descripción de permisos (si los trae, reemplazan los textos de Mango de «Repositorios» y «Búsqueda de código»).
- Lo de rondas anteriores (§5 del contexto), sin cambios.


## Ronda 27 · MCP remotos y recarga (2026-10-29)
Respuesta al contexto de la ronda 27. Archivos: `remote-core.jsx`, `remote-views.jsx`, `login.jsx`, `app.jsx`, `styles.css`, `remote.css`. Se aceptan las diferencias del §2 («Enviar de nuevo» desactivado casi no se ve en el chat; en el Playground no se desactiva). El id del toolset pasa a `repos`.

### Campos del perfil por toolset
Cuando el perfil firmado los traiga (`sensitivity`, `note`, `requirement`):
- **Lo pone Mango, según `sensitivity`** (hoy solo `source_code`): la insignia «Código fuente», el tono ámbar, el chip «{toolset} · código fuente» en el detalle y el título del aviso al marcarlo: «{toolset} da al agente el código fuente». Un valor que Mango no conoce no muestra nada.
- **Viene del perfil, tal cual:** `note` (debajo del grupo en la ficha y como cuerpo del aviso ámbar) y `requirement` (en la ficha, tras «**Requisito:**»). Mango no los reescribe ni los traduce.
- Si el perfil no trae ninguno de los tres, no se muestra nada (como hoy en la web). Si trae `sensitivity` sin `note`, el aviso lleva solo el título.
- Textos de ejemplo del perfil: Repositorios · «El agente lee archivos, commits y pull requests de los repositorios a los que llega la cuenta de cada persona.»; Búsqueda de código · «Necesita la extensión Code Search de Microsoft instalada en la organización. Sin ella, la búsqueda no encuentra nada y el agente responde que no hubo resultados.».

### Enlaces cuando «Mis conexiones» falla
Siguen como texto sin marcar y sin poder abrirse, y debajo del texto del agente: «Mango no pudo comprobar los enlaces del agente, así que no se pueden abrir. **Volver a comprobar**» (vuelve a leer Mis conexiones). No se tachan, porque Mango no sabe si son de tu organización.

### Recargar la página
Sin «Recuperando tu sesión…» en ningún caso (se quita del inicio de sesión; «Completando el ingreso…» sigue solo para la vuelta del SSO).
- **La pestaña tenía sesión** (aviso local): al instante, el armazón de la app con esqueletos. Barra lateral (logo real de Mango, nombre, cinco filas, tres filas más, la persona abajo) y área principal (barra superior, título y dos líneas, campo de escribir). Mismo ancho de barra lateral, mismos colores y tema que la app; en móvil, solo el área principal. Al renovar los tokens se reemplaza por la app en la misma vista.
- **No tenía sesión:** portada neutra, el fondo de la app y el logo de Mango centrado (44 px), sin formulario ni texto. Luego, el inicio de sesión.
- **Tenía sesión y ya no se pudo renovar:** del armazón pasa al inicio de sesión, con el aviso «Tu sesión terminó. Vuelve a entrar para seguir.».
- **Espera larga (en frío):** a los 1,2 s aparece, arriba del todo, una barra de 2 px en el color de acento que corre de izquierda a derecha (indeterminada). Nada más: ni texto ni spinner. Con movimiento reducido, la barra queda fija y los esqueletos sin brillo.
- **Lector de pantalla:** `role="progressbar"`, `aria-busy` y el nombre accesible «Cargando Mango» (no se ve).
- Si la carga falla, va al error a pantalla completa (sigue abierto en §5, sin dibujar).

**Panel de demo:** «Recargar la página» (Con sesión · 0,4 s, Con sesión · en frío, Tenía sesión · ya no, Sin sesión, Sin sesión · en frío); «Servicios externos · el perfil trae datos de toolsets» (Sí / Todavía no); en «Chat · servicio externo · conversación», «Mis conexiones falló». Se quitó «Recuperando la sesión» de «Login · al abrir la app».

### Sigue abierto
- Qué devuelve cancelar en Microsoft (prueba en vivo); si el perfil agregará descripción del servicio y de permisos.
- El error a pantalla completa al cargar (y si ofrece «Ingresar» o «Cerrar sesión»).
- Lo de rondas anteriores (§5 del contexto), sin cambios.


## Ronda 28 e Inicio (2026-10-30)
Respuesta al contexto de la ronda 28 y de Inicio (D102). Archivos: `dashboard.jsx`, `charts.jsx`, `store.js`, `login.jsx`, `app.jsx`, `remote-core.jsx`, `styles.css`. Se aceptan las diferencias del §A2 (el aviso local es del navegador, no de la pestaña; «Tu sesión terminó» se dice una vez; si la renovación no responde, se conserva el aviso).

### A3 · Decisiones
- **Fin de la sesión: un solo texto.** «Tu sesión terminó. Vuelve a entrar para seguir.» al recargar y cuando termina con la app abierta. Se retira «Tu sesión expiró. Vuelve a iniciar sesión.» del inicio de sesión: la persona no necesita saber si venció o la cerraron. (La pantalla de error 401 dentro de la app, al pulsar «Ingresar», ya lleva al inicio de sesión con este aviso.)
- **Nota de enlaces sin comprobar:** solo si el texto del agente tiene al menos un enlace. Sin enlaces, la nota no explica nada. *Cambio para el producto.*
- Ronda 26 (cancelar en Microsoft, descripción del servicio): sin cambios, sigue abierto.

### Error a pantalla completa al cargar (A4, ahora dibujado)
Sale cuando la renovación no responde tras los reintentos. Portada neutra (fondo y logo de 44 px) con «No se pudo abrir Mango» · «Mango no responde. Inténtalo de nuevo en unos minutos.», «Reintentar» (primario) y «Cerrar sesión» (secundario, porque el navegador sigue recordando la sesión). Sin «Ingresar»: si hay sesión no sirve, y si no la hay ya se habría ido al inicio de sesión. `role="alert"`. Sigue abierto qué decir cuando la sesión no se renueva dentro del chat.

### Inicio
**Disponibilidad:** en «Disponible hoy», Inicio está para administradores y finops-central (`isSoon('dashboard')` mira el rol). Líder de área y el resto siguen en «Próximamente» hasta que el producto tome las variantes de abajo; en «Diseño completo» se ven las tres.

**Alcance según la cuenta**
- Organización (admin o finops-central): «Así va Mango en toda la organización en el periodo seleccionado.» · Invocaciones: «Turnos de toda la organización que llegaron a un agente, en el chat y en el Playground.»
- Área (bu-lead): «Así va tu área, {Área}, en el periodo seleccionado.» · «Turnos de las personas de tu área que llegaron a un agente, en el chat y en el Playground.»
- Personal: «Así va tu uso de Mango en el periodo seleccionado.» · «Tus mensajes que llegaron a un agente, en el chat y en el Playground.»
- Gasto en Bedrock: «Costo de Bedrock en USD {de toda la organización | de las personas de tu área | de tus mensajes}: las respuestas de los agentes y el título de las conversaciones nuevas.»
- «Responder N aprobaciones» solo para quien puede firmar (`approval.decide`).

**Presupuestos**
- Admin: «Presupuestos cerca del límite», los cuatro agentes, con «Ver presupuestos».
- Todos los demás (finops-central sin admin, bu-lead, resto): «Tu presupuesto», una fila «Límite personal · USD x de USD y · %», **sin enlace** (no tienen esa pantalla). Info: bu-lead «Mango no tiene presupuestos por área. Este es tu límite personal del mes.»; resto «Tu límite personal del mes, para todos los agentes.». Es lo que ya hace el producto con finops-central.

**Saludo sin nombre:** solo «Buenas noches» (sin coma ni correo). Lo de antes de la @ tampoco es un nombre (`nombre+algo`).

**Tarjetas sin fuente:** en «Disponible hoy» se **ocultan** Estado de agentes, Tickets resueltos y Latencia p95 (lo que recomienda la revisión: no mostrar lo que no tiene fecha). Quedan Gasto, Invocaciones y Presupuestos en la misma rejilla de dos columnas. También se quita «Ver detalles» (lleva a vistas en «Próximamente»); «Exportar» se queda. *Cambio para el producto.*

**Desde cuándo hay datos** (la respuesta trae el primer día)
- Los días antes de ese día no son cero: no se suman ni se dibujan. En el gráfico, esa zona va rayada con «Sin datos» y una línea discontinua en el primer día. Con un solo día de datos, un punto.
- Bajo el total: «Cuenta desde el {d mmm aaaa}».
- Si el periodo anterior no está completo, no se muestra el porcentaje ni «… periodo anterior» (el título de «Cuenta desde…» lo explica: «No hay datos de todo el periodo anterior, así que no se compara.»).
- Tooltip en un día sin datos: el día con «Sin datos» y, debajo, «Mango cuenta desde el {fecha}. Antes no hay datos, no es que no hubiera gasto.».
- Sin ningún día con datos en el periodo, el total es «—».

**Carga y error**
- Cargando: saludo y filtros quedan; en la rejilla, una tarjeta esqueleto por tarjeta que se va a mostrar (título, cifra, línea, gráfico). `role="status"`, `aria-busy`, «Cargando Inicio».
- Error: en lugar de la rejilla, una tarjeta `role="alert"` «No se pudo cargar Inicio» · «Inténtalo de nuevo en unos segundos.» con «Reintentar» a la derecha (debajo a ≤560 px).

**Se acepta lo del producto:** «Actualizado hace unos segundos / hace N minutos / hace N horas», contado desde que se leyó la respuesta (igual en todas las tarjetas). «Quitar Comparar» como botón propio junto a la píldora (ya no es un control dentro de otro). Toast de Exportar: «Exportado a CSV».

**Panel de demo:** «Recargar la página» › «Con sesión · no responde»; «Inicio · al cargar» (carga, cargando, error); «Inicio · desde cuándo hay datos» (todo el periodo, hace 12 días, desde hoy); «Inicio · nombre de la persona». Las variantes por rol, con «Cuenta de ejemplo».

### Sigue abierto
- Lo de A4 que no se tocó aquí (respuesta cortada por su tope, cuota de Bedrock, 429, correos rechazados, `area_required`, administración, Agent Builder, Knowledge Bases, menú).
- Cancelar en Microsoft; descripción del servicio en el perfil.


## Ronda 29 (2026-10-30)
Respuesta al contexto de la ronda 29. Archivos: `dashboard.jsx`, `charts.jsx`, `store.js`, `login.jsx`, `app.jsx`, `audit-budgets.jsx`. Se aceptan todas las diferencias del §2. Reemplaza lo que contradiga «Ronda 28 e Inicio».

### Alineado con el producto
- **Inicio para todas las cuentas** también en «Disponible hoy» (`isSoon` ya no mira el rol). Organización, área o lo propio según responde el servidor; mientras carga, el subtítulo sale del rol.
- **Sin «Cerrar sesión» en «No se pudo abrir Mango».** Solo «Reintentar». Seguridad gana: sin servidor no se revoca la cookie.
- ~~Saludo sin nombre siempre~~ — corregido en la ronda 30: ver abajo.
- **Área = su identificador**, tal cual: «Así va tu área, finanzas, …».
- **Semanas contadas en parte, fecha de la organización, CSV con vacíos:** como el producto.

### Decisiones (§4)
- **«Cerrar sesión» cuando Mango no responde: no se ofrece.** Un cierre sin confirmar obliga a explicar que la sesión sigue abierta, y eso no ayuda a nadie en la pantalla de error. En un equipo compartido, la persona puede cerrar el navegador; la sesión vence sola.
- **Invocaciones nombra las tareas:** «Turnos {de toda la organización | de las personas de tu área} que llegaron a un agente, en el chat, en el Playground y en las tareas programadas.» · personal: «Tus mensajes que llegaron a un agente, en el chat, en el Playground y en tus tareas programadas.» *Cambio de texto para el producto.*
- **Nombre visible del área:** se queda el identificador. Sin una fuente para el nombre, no se inventa uno.
- **Antes del primer turno:** todo el gráfico va rayado con «Sin datos», total «—», sin «Cuenta desde…». El tooltip, bajo el día con «Sin datos»: «Mango todavía no tiene datos. Empieza a contar con el primer turno.» Etiqueta del gráfico: «{título} · todavía sin datos». Demo: «Inicio · desde cuándo hay datos» › «Antes del primer turno».
- Ronda 26 (cancelar en Microsoft, descripciones del perfil): sigue abierto.

### De rondas anteriores (§5)
- **Marcas del eje:** el diseño toma la regla del producto (`axisTicks` y `fmtTick` en `charts.jsx`). Cuatro partes de niceMax si las etiquetas pueden decirlas (invocaciones sin decimales; USD < 10 en céntimos, ver ronda 30); si no, paso de 1, 2 o 5 y el tope sube a la marca siguiente. USD < 10 con céntimos: «USD 0», «USD 0,25», «USD 0,01». Con máximo 1 invocación: 0 y 1.
- **Presupuesto de un agente descartado:** en Presupuestos, «Agente descartado · {id}» (el id en lugar del nombre que ya no existe). Inicio sigue sin mostrarlo. *Cambio de texto para el producto.*
- Sin tocar: sesión que no se renueva en el chat, respuesta cortada por su tope, cuota de Bedrock, subir a leer mientras responde, «+» con el primer mensaje sin guardar, dos «Reintentar» en el historial, 429, correos rechazados, `area_required`, administración, Agent Builder, Knowledge Bases, menú.


## Ronda 30 (2026-10-30)
Respuesta al contexto de la ronda 30. Archivos: `dashboard.jsx`, `charts.jsx`, `app.jsx`. Se aceptan las diferencias del §2.

- **Saludo (D102, corrige la ronda 29):** con nombre, «{Buenos días | Buenas tardes | Buenas noches}, {nombre}»; sin nombre, el saludo solo, sin coma. Vuelve el control de demo «Inicio · nombre de la persona» (Con nombre · Sin nombre).
- **Decimales del eje: una sola regla, la del producto.** USD por debajo de 10 en céntimos, siempre dos decimales. Si las cuatro partes no caben en céntimos, paso de 1, 2 o 5. Con máximo 0,5: «USD 0», «USD 0,10» … «USD 0,50».
- **«Agente descartado» solo cuando la API lo dice:** se acepta. Si la lectura de nombres falla, el id a secas. No hace falta dibujarlo aparte. (En el prototipo los nombres siempre se leen.)
- Sigue de la ronda 26: cancelar en Microsoft; descripciones del perfil.
- Sin tocar, igual que en la ronda 29: todo el §5 (chat y sesión, 429, ingreso y registro, administración, Agent Builder, Knowledge Bases, menú).


## Ronda 31 (2026-10-31)
Respuesta al contexto de la ronda 31. Archivo: `charts.jsx`. «Una sola regla» pasa a ser literal: `axisTicks` da las mismas marcas que el producto. Reemplaza lo dicho del eje en las rondas 29 y 30.

- **Marcas del eje:**
  - Si las cuatro partes de niceMax caben en la precisión, van esas: invocaciones enteras, USD por debajo de 10 en céntimos. Con tope 5: «USD 1,25, 2,50, 3,75, 5,00».
  - Si no caben, se usa el paso más chico de 1, 2 o 5 que divida niceMax en **cinco partes como mucho**. Pico USD 2: «USD 0, 0,50 … 2,50». Pico USD 5: «USD 0, 2 … 10». Pico de 5 invocaciones: «0, 2 … 10».
  - **Por debajo de un céntimo** el paso baja a 0,001, 0,0001…, y la etiqueta lleva los decimales del paso. Pico USD 0,0042: «USD 0, 0,001 … 0,005». Ya no es «siempre dos decimales»: son dos como mínimo.
- **Columna del eje:** su ancho sale de la etiqueta más larga (11 px tabular, unos 6,6 px por carácter más 8 px de aire), **con un mínimo de 48 px**. Antes era `axisW = 48` fijo. En Gasto en Bedrock, «USD 2,50» ya no se monta sobre la gráfica. *Cambio para el producto:* medir la etiqueta real (`measureText` o el ancho del `<text>`) vale igual.
- Sigue de la ronda 26: cancelar en Microsoft; descripciones del perfil.
- Sin tocar: todo el §5.


## Ronda 32 (2026-11-01)
Respuesta al contexto de la ronda 32. Sin cambios en el diseño.

- **Eje de Inicio: cerrado.** La web y `axisTicks` coinciden en marcas, etiquetas y ancho de la columna. Se acepta la única diferencia que queda: un pico de USD 0,00000002 repite etiquetas porque ocho decimales no alcanzan. Ningún gasto real llega ahí.
- Sigue de la ronda 26: cancelar en Microsoft (prueba en vivo); descripciones del perfil.
- Sin tocar: todo el §5 (chat y sesión, 429, ingreso y registro, administración, Agent Builder, Knowledge Bases, menú).


## Ronda 34 (2026-11-02) · lo abierto del §5
Responde todo lo abierto del §5 que quedaba de las rondas anteriores. Archivos: `chat.jsx`, `login.jsx`, `admin.jsx`, `kb-core.jsx`, `app.jsx`, `styles.css` y uno nuevo, `Demasiadas solicitudes.html`. Lo marcado *Producto* es un cambio para la web. Ronda 26 sigue abierta (cancelar en Microsoft; descripciones del perfil).

### Chat y sesión
- **Respuesta cortada por su tope: solo se avisa, sin «Continuar».** Bajo el texto, un aviso neutro (`mc-alert`, ícono Info, `role="status"`):
  - por tope de tokens: «**Respuesta incompleta.** El agente llegó a su largo máximo de respuesta. Lo de arriba es lo que alcanzó a escribir. Si necesitas el resto, pídelo en un mensaje nuevo; por ejemplo, «sigue desde donde quedaste».»
  - por una tool cortada: «… El agente llegó a su largo máximo mientras preparaba una consulta a `{tool}`, y la consulta no se hizo. …». La tool cortada **no se ejecuta**.
  - por límite de tiempo: «… El turno llegó a su límite de tiempo antes de terminar. …»
  - El lector de pantalla anuncia «Respuesta incompleta. {agente} no terminó de responder.» Si la persona no está mirando, sale el toast «Respuesta incompleta», no «Respuesta completa».
  - En una respuesta incompleta **se oculta «Reintentar»**, porque repetir la pregunta se cortaría igual y cobraría otra vez.
  - Demo: «Chat · progreso del turno» › Cortada por su tope · Tope corta una tool · Límite de tiempo.
- **Bedrock sin cuota:** el error del turno lleva título y texto propios: «**El modelo está ocupado.** Bedrock no aceptó más pedidos por ahora. Espera un momento y vuelve a intentarlo. Este intento no se cobró.» Lleva «Reintentar», que reenvía la misma pregunta. *Producto:* distinguir `ThrottlingException` y `ServiceQuotaExceeded` del fallo genérico. Demo: «Bedrock sin cuota».
- **Sesión que no se renueva dentro del chat:** el mensaje no se envía y se queda en el cuadro de texto. En la conversación sale un aviso ámbar (`role="alert"`): «**Tu sesión terminó. Vuelve a entrar para seguir.** Tu mensaje no se envió y sigue en el cuadro de texto.», con el botón «Entrar», que lleva al inicio de sesión con el mismo aviso. Es el mismo texto de fin de sesión de la ronda 28. *Producto:* guardar el borrador por agente en `sessionStorage` y devolverlo al volver a entrar. Demo: «Sesión no se renueva».
- **Subir a leer mientras responde:** la conversación baja sola solo si la persona ya estaba al final (a menos de 80 px). Si subió, se queda donde está y aparece una píldora centrada sobre el compositor:
  - «Respuesta nueva» mientras llega texto;
  - «Ir al final» cuando no llega nada.
  - Al terminar, como la persona no está al final, sale el toast «Respuesta completa». Así se resuelve la diferencia 2 de `sync-2026-10-05b.md`.
- **«+» con el primer mensaje sin guardar:** el «+» de la barra se desactiva mientras corre el primer turno de una conversación nueva, con el tooltip «Podrás empezar otra cuando termine la primera respuesta». No hay estado intermedio que dibujar. El toast «Nueva conversación iniciada.» solo sale cuando la pantalla de verdad quedó vacía.
- **Corte con dos «Reintentar»: queda uno.**
  - El turno fallido lleva el único botón: «No se pudo enviar tu mensaje: Mango no responde. Inténtalo de nuevo en unos minutos.» · Reintentar.
  - El historial muestra solo el texto, sin botón: «No se pudo cargar el historial. Se vuelve a cargar cuando reintentes tu mensaje.»
  - El botón del turno reintenta las dos cosas.
  - Demo: «Chat · historial y conversación» › Corte · turno e historial fallan.

### Límites por red (429)
- **Estado propio dentro de la aplicación** (componente `RateWait` en `chat.jsx`, exportado como `window.RateWait`):
  - Título «Demasiadas solicitudes» y el texto de lo que pasó, más «Puedes volver a intentarlo en {N minutos | unos segundos}.», con la espera que trae la respuesta (`Retry-After`).
  - «Reintentar» queda desactivado con la cuenta atrás, «Reintentar en 2:58», y se activa solo al llegar a cero. Así no vuelve a contar.
  - El mismo patrón va en el chat, el historial, la conversación, el Marketplace y el arranque: en cada uno, su texto de error más la línea de espera y el botón con cuenta atrás.
  - *Producto:* se retira «Espera un minuto».
  - Demo: «429 · demasiadas solicitudes».
- **Página «Demasiadas solicitudes» del borde:** `Demasiadas solicitudes.html`.
  - Es HTML fijo, sin JS ni archivos externos, con claro y oscuro por `prefers-color-scheme`.
  - Lleva la marca de Mango, el título «Demasiadas solicitudes», el texto «Mango recibió muchas solicitudes desde tu red en poco tiempo. Espera unos minutos y vuelve a cargar la página.», una segunda línea sobre la red compartida, el botón «Volver a cargar» y «Código 429».
  - No da una cifra de espera: la página no la conoce.
- **Esperas en administración:** el texto sale del tiempo que falta según la respuesta, con la regla «Llegaste al límite de {acción} {por hora | por día}. Puedes volver a intentarlo {…}.»:
  - menos de 1 min: «en unos segundos»;
  - menos de 60 min: «en N minutos»;
  - hoy: «a las HH:MM»;
  - otro día: «mañana a las HH:MM».
  - El botón se desactiva igual que en `RateWait`. *Producto.*

### Ingreso y registro
- **Envío de correos rechazado:** el error va siempre en un aviso del formulario (`login-err-box`, `role="alert"`), justo sobre el botón y nunca bajo el campo del correo. El correo no queda marcado como inválido. Textos (`MAIL_ERR` en `login.jsx`):
  - «Recupera tu contraseña»: «No pudimos enviar el correo. Inténtalo de nuevo en unos minutos.»
  - «Reenviar código» en «Crea una contraseña nueva» y «Verifica tu correo»: «No se pudo reenviar el código. Inténtalo de nuevo en unos minutos.» Reemplaza el «Si corresponde, te enviamos un código nuevo.».
  - «Crea tu cuenta»: «No pudimos enviar el código de verificación. Inténtalo de nuevo en unos minutos.»
  - Demasiados intentos: «Demasiados intentos. Espera unos minutos antes de pedir otro código.»; en «Crea tu cuenta», «Demasiados intentos con este correo. Espera unos minutos y vuelve a intentarlo.»
  - Demo: «Login · envío de correos».
- **Líder de área sin área o con dos (`area_required`):** el diseño ya lo tenía completo. Todo es *Producto*:
  - pantalla al entrar (`AreaRequired` en `login.jsx`, con «Volver a comprobar»);
  - textos del rechazo en Ajustes › Personas (`areaMsg` e `inviteAreaErr` en `people.jsx`);
  - «Cambiar de área…» en un solo paso;
  - aviso al eliminar el grupo que es la única área de un líder (`groups-admin.jsx`).
  - Demo: «Estado de la cuenta al entrar» › Líder de área…

### Administración
- **«Otro cambio se está aplicando…»** *Producto*:
  - no se muestra si la espera dura menos de 600 ms; si se muestra, se queda al menos 1 s;
  - va en línea, bajo la fila de acciones, y no flota sobre los mensajes;
  - a 420 px, «Aprobar» no cambia su texto: el spinner va dentro del botón, el ancho es fijo y la fila no se parte (`flex-wrap: nowrap`, `flex-shrink: 0`);
  - en oscuro, «Aprobar» desactivado va con `opacity: .45` y `cursor: not-allowed`, igual que el resto de botones desactivados.
- **Búsqueda sin resultados:** en lugar de «… · 0 resultados», «Sin resultados para «{texto}»», que es el patrón del historial y de la paleta. Con filtro y sin texto: «Ninguna persona en «{filtro}»». *Producto.*

### Agent Builder
- **Tokens por llamada:** nueva opción «Sin fijar», que es la que sale cuando la versión no lo fija; ya no se muestra 4.096.
  - Sin fijar: «Sin fijar: cada llamada puede usar hasta el tope por respuesta.»
  - Mayor que el tope: «Es mayor que el tope por respuesta: cada llamada usa como mucho {tope}.» Se puede guardar; manda el menor.
  - Si no: «Por cada llamada al modelo · nunca pasa del tope por respuesta».

### Knowledge Bases
- **«Sin bucket» tras una propuesta que no se envió:** el diseño ya dice «La propuesta del bucket no llegó a enviarse: no se lee nada.» (`noSource: 'notsent'`). *Producto:* el resumen debe usar ese texto, no «se retiró la propuesta».
- **Fuente aprobada que no se pudo leer:** tiene texto propio (`kbErrText(k)`): «Mango no pudo leer {s3://…}. El bucket está aprobado, pero el rol de Mango ya no puede leerlo o el prefijo cambió. Revisa la política del bucket con su dueño y vuelve a sincronizar.»

### Menú
- **«Próximamente» se queda.** Lo eligió el dueño. No se ocultan las vistas sin fecha.


## Ronda 35 (2026-11-03) · «Buscar conversaciones» en la web
Respuesta al contexto de «Buscar conversaciones». Archivos: `search.jsx`, `chat.jsx`, `app.jsx`, `store.js`, `audit-budgets.jsx`, `styles.css`. `search` entra en `AVAILABLE`: la entrada deja de ser «Próximamente». Se acepta lo construido del §1.

**Diferencias del §2, decididas**
- **Búsquedas recientes:** solo en memoria de la pestaña (variable del módulo; se conservan al ir y volver dentro de Mango, se pierden al recargar). Sin texto que lo explique: basta con que no estén. Se quitó `mango-search-recent` del diseño.
- **Línea del tope** (`.sr-cap`): gris, 12,5 px, con el icono de información, justo bajo el contador y antes de las tarjetas. Con «Sin resultados», debajo del bloque y centrada. Textos definitivos, los de la web:
  - lectura: «Buscamos en tus {N} conversaciones más recientes; las más antiguas no se revisaron.» ({N} = las que se leyeron de verdad; también si cortó por mensajes o por MiB);
  - respuesta: «Se muestran las 100 conversaciones con más coincidencias; afina la búsqueda para ver otras.» (no va con «Sin resultados»).
  - Si se cumplen los dos, dos líneas, en ese orden.
- **«Prueba con»:** se quita del diseño. No se propone otra fuente: el filtro de agente ya cubre «los agentes que uso».
- **Conversaciones recientes:** sin `t.last`; debajo del título solo el agente, como el historial del chat.
- **Herramientas:** se busca solo el nombre de la tool (ya no los parámetros).

**Errores y espera**
- **Error:** en lugar de los resultados, bloque `role="alert"`: icono ámbar, «No se pudo buscar en tus conversaciones.» y «Reintentar». El buscador y los filtros siguen activos.
- **429:** mismo bloque con el patrón de la ronda 34: «Demasiadas solicitudes» · «Hiciste muchas búsquedas seguidas. Puedes volver a intentarlo en {N minutos | unos segundos}.» y «Reintentar en m:ss» (`RateWait`). Mientras cuenta, cambiar la consulta no envía nada; al llegar a cero, «Reintentar» busca lo que haya en el buscador.
- **Espera:** se conserva la lista anterior (`aria-busy` en la lista). Solo si tarda más de 400 ms aparece, junto al contador, mango-spinner pequeño + «Buscando…». En la primera búsqueda (sin lista anterior) esa misma línea va sola. El `role="status"` oculto anuncia «Buscando…» y luego «{N} coincidencias en {M} conversaciones», «Sin resultados» o el error.

**Abrir en el mensaje de la coincidencia** (*cambio para el producto*)
- Cada fila de coincidencia abre la conversación en su mensaje; «Abrir» de la tarjeta y Enter, en la primera coincidencia que no sea de título. Las de título abren como siempre.
- El chat desplaza el mensaje a 96 px del borde superior, lo enfoca (`tabindex="-1"`, sin anillo) y lo resalta con `--accent-soft` (fondo + halo de 10 px) que se apaga en 0,9 s tras 2 s. Con movimiento reducido, sin transición.
- El índice viaja con `openChat(agente, conversación, índice)`; si es una llamada agrupada, se usa el grupo que la contiene.
- **Ya no está** (conversación más corta o mensaje borrado): se abre como siempre y aviso «Ese mensaje ya no está en la conversación.».
- Pista de teclado: «Enter abre en la coincidencia».

**Auditoría**
- `conversation.search` → «Búsqueda en conversaciones». Detalle: «Buscó en sus conversaciones · {N} resultados» (`1 resultado`), con {N} = conversaciones con coincidencias. Panel › «Búsqueda»: «Resultados · {N} conversaciones» y «Se registra quién buscó y en cuántas conversaciones hubo coincidencias. Nunca lo que se buscó.».

**Abierto de la ronda 34**
- **Opacidad de desactivados:** `.45` en todos. `styles.css` pasa `.btn:disabled` y `.ab-seg button:disabled` de .5 a .45.
- **«Tokens por llamada» mayor que el tope por respuesta:** se acepta lo del producto (D74), sin aviso.
- **Esperas en administración:** no se nombra el límite; basta la cuenta atrás.
- Sin cambios: sesión que no se renueva dentro del chat, Bedrock sin cuota y respuesta cortada (prueba pendiente), «Sin bucket» no enviado (el diseño no lo reproduce) y ronda 26.

Demo: panel › «Buscar conversaciones · respuesta del servidor» (normal, lenta, error, 429, tope de lectura, más de 100) y «Buscar · mensaje de la coincidencia» (sigue ahí / ya no está).


## Costos, Observabilidad, Evals y Tickets (2026-11-05) · D105–D112
Respuesta al contexto del 2026-11-05. Archivos: `costs2.jsx`, `observability2.jsx`, `evals.jsx`, `eval-create.jsx`, `agent-review.jsx`, `tickets.jsx`, `system.jsx` (comentarios), `activity.jsx`, `ui.jsx`, `schedules.jsx`, `policies.jsx`, `chat.jsx`, `approvals.jsx`, `store.js`, `app.jsx`, nuevo `ops-states.jsx`. Desde la ronda 37 las cuatro vistas están en `AVAILABLE` (ver «Ronda 37»). Lo que cambió allí manda sobre esta sección.

**Las cuatro vistas**
- **Estados** (`OpsState`): cargando (mango-spinner + «Cargando {vista}…»), error (`role="alert"`, «No se pudo cargar {vista}.» + «Reintentar»), vacío (texto propio por vista) y 403 («No tienes acceso a {vista}» + quién la ve).
- **Quién la ve** (`canView`): Costos, admin o finops-central · Observabilidad, solo admin (fuera de `OWNER_VIEWS` en la práctica) · Evals, admin, finops-central o quien puede crear agentes · Tickets, todos (ya era vista principal).

**Costos**
- Admin y finops-central ven lo mismo, incluido el presupuesto del agente en el cajón. Sin presupuesto de personas.
- «Presupuestos», «Ver presupuestos» y «Ver trazas»: solo admin. Bajo el presupuesto, para admin: «El límite de un agente todavía no se cambia desde Mango.» («Ajustar presupuesto» pasa a «Ver presupuestos»).
- Subtítulo: «… con los precios de lista de Brains. No incluye el guardrail ni los embeddings.»
- **Consultas reales:** «{n} consultas», «Costo medio por consulta». Se quitó la nota de «estimaciones con datos de ejemplo».
- **Desde cuándo cuenta:** bajo «desglose», «Cuenta desde el {fecha}» del desglose activo. «Por modelo» y «Por origen» usan la fecha de D106; «Por agente», la de su contador (D104). Lo anterior va en una fila gris «Sin desglose · Antes del {fecha}», nunca repartido. Si el mes anterior no tiene ese desglose, «vs anterior» es «—» y «Cambios frente al mes anterior» dice «El mes anterior no tiene desglose por agente: el contador empezó el {fecha}.»
- **«Sin agente»** (fila gris en «Por agente»): los títulos de conversaciones nuevas. Nota debajo: «El título de una conversación nueva cuenta en el total del mes, pero en ningún agente: por eso va en «Sin agente».» En «Por modelo» y «Por origen» van en su propia fila gris: «Sin modelo» / «Sin origen» · «Títulos de conversaciones nuevas» (ronda 37).
- **«Próximamente»:** «Por equipo» (botón desactivado con etiqueta) y «Oportunidades de ahorro» (tarjeta con etiqueta, sin cifras). Se quitaron «Asignado a equipos» del gráfico, de la proyección («Al ritmo actual») y del cierre proyectado.
- CSV: `agente, modelo, gasto_mes, mes_anterior, consultas` + filas «Sin agente» y «Sin desglose».

**Observabilidad**
- Siempre solo metadatos. Se quitó la variante `convAccess`, «Abrir conversación» y el registro de lectura. Aviso fijo: «Solo metadatos: tipo de llamada, modelo o tool, inicio, duración, tokens y estado. El texto de la pregunta, la respuesta y lo que recibió o devolvió cada tool no se guardan en la traza.»
- Filas: «Conversación de {correo}» o «Tarea de {correo}». Cajón: «Traza {id corto}» y debajo «{Conversación|Tarea} de {correo} · {agente} · {modelo} · {fecha}».
- Id aleatorio de Mango (32 hex). Se muestran 8 en mono; «Copiar ID» copia el completo.
- Llamadas al modelo: «Modelo · {modelo}», sin intención. Tool que falla: «La tool respondió con error.» Estado nuevo **«Cortado»** (gris), con «El turno se cortó antes de terminar.»
- Búsqueda: «Buscar tool, persona o ID de traza» (tool, correo, id).
- «Costo del modelo» con «· sin el guardrail».
- **Tope de la lectura:** las cifras pasan a «al menos {n}» y, bajo los KPI, la línea gris `.sr-cap`: «La lectura llegó al tope de {N} trazas: las cifras son un mínimo. Acorta el rango o elige un agente para verlo completo.»
- «Espera aprobación» y «Con aprobación» se quedan; se confirma al construir.

**Evals**
- **Quién:** admin y finops-central ven todas; un creador sin rol central, las de los agentes que edita. Crea, ajusta y ejecuta quien edita el agente (`evEdits`: admin, o `agent.edit` y dueño). Sin ningún agente editable: aviso «Solo lectura: crea, ajusta y ejecuta una suite quien edita su agente.», sin «Nueva suite», «▶», ajustes ni pie. Aprobar quitar «Obligatoria» solo lo ve un admin.
- «Agentes sin evals» (solo con rol central): «De {n} agentes». Se quitó «Se publican sin pruebas».
- Subtítulo: cada caso es un turno de prueba con la versión del agente; las tools de escritura nunca se ejecutan; solo una obligatoria que no pasa bloquea.
- **Detalle:** veredicto y motivo por caso, y «la respuesta del agente no: queda 30 días en un registro que solo lee el evaluador». Sección «Ejecución y costo»: cuándo, «Corre como {persona}» (programada o en cada envío), costo estimado y quién paga.
- **Al crear:** «Revisión humana» Próximamente; «Desde Playground» y «Generar con IA» Próximamente; «Conversaciones reales» sigue bloqueada. Queda solo «Importar CSV»: ver la pregunta abierta de abajo. «Usa la tool» lista el nombre de la tool en el Gateway (sin servidor). Juez: «Evaluador de Mango con un modelo del catálogo de Brains». Costo: «calculando…» y luego el valor del servidor (precio del modelo del agente + juez). Programada o en cada envío: «Corre a tu nombre. Si dejas de editar {agente}, la suite se pausa.»
- **Estados nuevos:**
  - en curso: en la fila «Caso {n} de {total}» con spinner; en el detalle, barra de progreso;
  - «No empezó: no alcanza tu presupuesto o el de {agente}. El puntaje sigue siendo el anterior.»;
  - «Se detuvo por presupuesto en el caso {n} de {total}. No cuenta como ejecución: …»;
  - «La ejecución falló: no respondió el harness de evals o el Gateway. No cuenta como ejecución; vuelve a intentarlo.»;
  - versión que ya no existe (insignia roja + «Usar la versión actual» *propuesta*);
  - pausada (insignia ámbar, «Pausada: corre como {persona}, que ya no edita {agente}.» + «Retomar a mi nombre» *propuesta*).
- **Revisión de agentes:** «Evals ejecutándose: {suites}. Se podrá aprobar cuando terminen y pasen.» y «Esperando evals: {suites} se ejecutan con este envío. Todavía no se puede aprobar.»; las dos bloquean («Hay evals obligatorias sin terminar.»).

**Tickets**
- **Id:** aleatorio; se muestran 8 caracteres (`tkShort`), también en la columna, la búsqueda («Buscar por título o id»), los avisos, «Copiar enlace», Actividad y la paleta.
- **Herramientas · {n}:** tool, ok/error y latencia; sin parámetros ni desplegable. Un ticket creado en la web: «Lo creó una persona: no hay llamadas de un agente.»
- **Asignar:** «Asignarme» o a quien participa (quien lo creó, el asignado y quienes comentaron), con la ayuda «A ti o a quien ya participa: …». «Nuevo ticket» y el filtro: «Sin asignar» / «A mí».
- **«Por aprobar»:** desactivado en los desplegables; la columna no acepta tarjetas ni tiene «+» (al arrastrar: «Lo marca una solicitud de Aprobaciones»). Ayuda bajo Estado: «“Por aprobar” lo marca una solicitud de Aprobaciones.» Recuadro: «Hay una solicitud abierta en la conversación donde {agente} creó este ticket.» Se puede sacar de esa columna a mano (*confirmar*).
- **Nuevo ticket:** «Un agente solo escribe en un ticket dentro de una conversación o de una tarea: elegirlo aquí no lo pone a trabajar.» Agente opcional («Sin agente»).
- **Creado:** «{antigüedad} · {persona} · vía {agente}». Actividad: «{agente} creó el ticket en una conversación de {persona}».
- **Comentarios:** Markdown con `renderMarkdown` (escapa el HTML). Pie: «Markdown · ⌘↵ para enviar · Menciones que avisan [Próximamente]».
- **Panel:** cargando, error con «Reintentar», «No puedes ver este ticket» (enlace o acceso cambiado, con quién lo ve) y agente que ya no puedes usar («Ya no puedes usar {agente}. Ves este ticket porque lo creaste / lo tienes asignado…», el agente sin enlace).
- **Chat:** la tarjeta de confirmación dice qué ticket: «Crea el ticket «{título}»», «Cambia el ticket {id} · {título}: {cambio}», «Comenta en el ticket {id} · {título}». El agente: «Para escribir en un ticket necesito tu confirmación.» Demo: escribe «abre un ticket», «comenta en el ticket» o «actualiza el ticket». En una tarea, la llamada queda como solicitud a nombre del dueño (sin cambio de pantalla).
- **Schedules › «Crear ticket»:** deja de ser Próximamente (`f.ticket`). Al activarlo: «Cada ejecución que termina bien deja su resultado en un ticket tuyo, sin asignar, con {agente} y la tarea. Título: el nombre de la tarea y la fecha. Lo ven también quienes pueden usar {agente} y los administradores. Si el resultado parece una credencial, no se crea.» Se quita «Solo tú lo ves.».
- Inicio, Bandeja, chat (enlaces) y Actividad siguen sin tickets hasta que se construyan.

**Ajustes › Aprobaciones · tools de tickets** (*bloquea la release*)
- `create_ticket`, `update_ticket` y `comment_ticket` aparecen bajo «Tickets de Mango» con `cond: 'self'`. La fila dice «La persona confirma cada llamada», con aprobadores y vencimiento «—». `polText`, `polSummary` y `approvalTier` leen `self` así, también en el resumen (no «Siempre»).
- Editor: `self` no se ofrece. Solo «Siempre» está habilitado; ayuda «Hoy: la persona del chat confirma cada llamada. Con «Siempre», cada llamada pide aprobadores.»

**Preguntas abiertas**
- Evals sin Playground ni IA: solo queda CSV. ¿Agregamos «Escribir un caso» a mano?
- «Usar la versión actual» y «Retomar a mi nombre» son propuestas: confirmar que el servidor los permite.
- Evals: si una ejecución detenida o fallida cuenta en el historial (el diseño dice que no).
- El brief llegó cortado en tres puntos (intención de la llamada al modelo, qué pasa si quien creó la eval pierde el acceso, y el final de Ajustes › Aprobaciones). Se asumió «Modelo · {modelo}» y que la suite se pausa.

Demo: panel › «Costos, Observabilidad, Evals y Tickets · respuesta del servidor», «Costos · desde cuándo cuenta el desglose», «Observabilidad · lectura del rango», «Evals · al ejecutar», «Evals · estado de la primera suite», «Revisión · evals obligatorias», «Tickets · al abrir un ticket». Cuentas: «Usuario · finops» (Costos y Evals de solo lectura, sin Observabilidad), «Creador» (Evals de sus agentes, sin Costos).


## Ronda 37 (2026-11-05) · lo que entró de D105–D112, y la ronda 36
Respuesta a los contextos de las rondas 37 y 36. Archivos: `store.js`, `ops-states.jsx`, `costs2.jsx`, `observability2.jsx`, `evals.jsx`, `eval-create.jsx`, `policies.jsx`, `tickets.jsx`, `schedules.jsx`, `search.jsx`, `app.jsx`, `styles.css`. `costs`, `observability`, `evals` y `tickets` entran en `AVAILABLE`: ya no queda ninguna vista de la navegación en «Próximamente». Se aceptan todas las diferencias del §1–§5 de la ronda 37 salvo lo que se decide abajo.

**Comunes**
- **429 en `OpsState`** (`kind: '429'`): el bloque común de la ronda 34 (icono de reloj, «Demasiadas solicitudes», la espera y «Reintentar en m:ss»). Observabilidad: «Observabilidad admite 30 lecturas por minuto: cada filtro, búsqueda o página cuenta.»; las demás, «Hiciste muchas solicitudes seguidas.». Demo: panel › «…respuesta del servidor» › «Demasiadas (429)».
- **Modelos:** el id (`us.anthropic.…`, mono) vale. No se pide el nombre corto.

**Costos**
- «Por origen» del cajón del agente **se quita** (no «Próximamente»): el producto cuenta el origen de la organización.
- Se aceptan las filas «Sin modelo» / «Sin origen» · «Títulos de conversaciones nuevas», «Playground · Pruebas antes de publicar» y «Agente que ya no está en el catálogo», todas grises y al final, como «Sin agente».
- **Selector de mes:** no en esta ronda. Solo el mes en curso; el mes cerrado se dibuja en una ronda propia.

**Observabilidad**
- En «Disponible hoy» se quitan «Con aprobación», «Espera aprobación» y «Cortado» (chip, estado, avisos). Quedan en «Diseño completo» hasta que la referencia del turno traiga una marca.
- **«Sin turno de Mango»:** en el cajón, debajo del título: «Esta traza no tiene un turno de Mango: es anterior a la vista o no la escribió Mango. No hay persona ni costo.»
- Se aceptan «Prueba en Playground de {correo}» y «{n} llamadas más no se muestran.».
- **Tope por tiempo:** como la API no dice cuál se cumplió, un solo texto: «La lectura se detuvo en {N} trazas: las cifras son un mínimo. Acorta el rango o elige un agente para verlo completo.»
- Spans que no se pudieron leer: sin aviso.

**Evals**
- Se quitan «Pausada», «Retomar a mi nombre» y «Usar la versión actual» (y su control del panel de demo). «Corre como» dice «Quien envía la versión» en las de cada envío; en las programadas, quien la creó.
- **Paso 4:** en cada envío, «Corre a nombre de quien envía cada versión de {agente} a aprobación.»; programada, «Corre a tu nombre, con la versión publicada de {agente}.».
- **Costo:** se rotula como tope: «Costo por ejecución · hasta {X}». Nota: «El tope lo calcula el servidor con la pregunta más larga y el máximo de iteraciones: el gasto real suele ser bastante menor.»
- **Motivo** (`.ev-why`): apagar «Obligatoria» y «Rechazar» abren debajo un campo (1 a 500 caracteres, contador, «Queda en Auditoría»). Botones «Enviar pedido» / «Rechazar pedido», desactivados sin texto; «Cancelar» cierra. El pedido muestra «Motivo: {texto}» al admin que decide. «Rechazar» solo lo ve un admin que no lo pidió.
- **Revisión «sin ejecutar»:** aviso propio, ámbar: «{suite} es obligatoria y no tiene una ejecución terminada con esta versión. Ejecútala desde Evals: hasta que pase, no se puede aprobar.» La fila dice «sin ejecutar». Demo: «Revisión · evals obligatorias» › «Sin ejecutar con esta versión».
- Se aceptan los textos propios de detención, de caso y del juez sin modelos.
- **Caso escrito a mano:** no en esta ronda; sigue solo CSV.

**Tickets**
- **«Por aprobar»:** bajo Estado, «Mientras la solicitud siga abierta, solo se puede marcar «Resuelto».»; Abierto y En curso desactivados en el desplegable.
- **«Herramientas»:** se queda «Próximamente». Si se construye, desde las aprobaciones del ticket, no desde la traza.
- **Descripción de un resultado de tarea:** Markdown con el renderizador seguro de la web; la de un ticket creado a mano sigue en texto plano.
- **Admin que perdió el agente:** «Ya no puedes usar {agente}. Ves este ticket porque eres administrador.»
- **«Nuevo ticket»:** empieza en «Sin agente».
- Se aceptan los textos propios.

**Ajustes › Aprobaciones y Schedules**
- El id con prefijo (`mango-tickets.create_ticket`) y las descripciones del manifiesto valen.
- **Editor con `self`:** no se marca nada; aprobadores y vencimiento van a .45 y sin interacción hasta elegir «Siempre». La ayuda suma «Aprobadores y vencimiento se eligen después de marcar «Siempre».»
- **`tickets_unavailable`:** el botón se queda; al guardar, «Esta instalación no tiene Tickets: la tarea no puede crear tickets. Apaga «Crear ticket» para guardarla.»
- **Detalle de una tarea:** en «Entrega y control», fila «Ticket · También crea un ticket con cada ejecución que termina bien», y «Resultado» deja de decir «solo tú lo ves».

**Ronda 36 (Buscar conversaciones)**
- **Recargar en la coincidencia:** basta abrir desde el principio. El id no vuelve a la URL.
- **Volver a «Buscar conversaciones»:** la pantalla recuerda la última consulta y los filtros, solo en memoria, mientras la pestaña siga abierta (`srMemo` en `search.jsx`); la búsqueda se vuelve a pedir al entrar.

**Sigue abierto:** ronda 26 (cancelar en Microsoft, descripción del servicio y de permisos en el perfil); sesión que no se renueva en el chat; Bedrock sin cuota y respuesta cortada por tiempo; «Sin bucket» en Knowledge Bases.


## Turnos que siguen sin la pestaña · código, archivos, gráficas y tablas (2026-11-07, D114–D125)
Archivos: `chat-run.jsx` (nuevo: bloque «Analizando», figuras, tarjeta de archivo, gráfica, tabla, adjuntos, línea de reconexión), `chat.jsx`, `admin.jsx` (Builder), `app.jsx` (panel de demo), `styles.css` (`.cr-*`).

### 1. El turno corre en el servidor (D120, D121) · ya
- **Reconectando:** debajo del texto recibido, «Se cortó la conexión. Reconectando… · intento {n} de 12» (`role="status"`). El texto sigue en pantalla; se ocultan el cursor y la línea de fase. «Cancelar» sigue disponible.
- **Reanudado:** «Reconectado. La respuesta sigue donde iba.» en verde, 2,5 s, y el texto continúa sin repetirse.
- **No se pudo reconectar:** aviso ámbar «No se pudo reconectar. La respuesta puede seguir en Mango. «Volver a conectar» trae lo que haya, sin preguntar otra vez. También la verás al abrir de nuevo la conversación.» + «Volver a conectar». Se llama así (no «Reintentar») para no confundirlo con el «Reintentar» de un error, que vuelve a enviar.
- **Turno en curso al volver:** la conversación abre con la pregunta y la respuesta sigue en vivo (fase, pasos y texto), sin aviso extra. Si terminó, se ve como cualquier respuesta guardada.
- **Turno interrumpido:** texto parcial + aviso ámbar «Respuesta interrumpida. Mango perdió el turno a mitad. Lo de arriba es lo que alcanzó a escribir; el turno se cobra entero. Puedes volver a preguntar: el agente solo recordará lo que se ve aquí.». Sin «Reintentar» en esa respuesta.
- **Cancelar:** `stopped_note` pasa a «Respuesta detenida. El turno se cobra entero y tu próxima pregunta empieza de nuevo: el agente solo recordará lo que se ve aquí.». Sin «Reintentar» en la respuesta detenida.
- **Otra pestaña con turno en curso:** si el servidor rechaza el envío, el mensaje se queda en el cuadro de texto y se ve el turno de la otra pestaña en vivo (la pregunta lleva «Desde otra pestaña»). Aviso: «Tu mensaje no se envió: hay una respuesta en curso en esta conversación, desde otra pestaña. Sigue en el cuadro de texto; envíalo cuando termine.».
- **Sesión que termina mientras se reconecta:** `session_end` con otro final: «Tu sesión terminó. Vuelve a entrar para seguir. La respuesta sigue en Mango y la verás al volver a entrar.». El texto parcial queda con «La respuesta sigue en Mango. La verás completa al volver a entrar.».
- Demo: «Chat · progreso del turno» › «Se corta · reconecta», «Se corta · no reconecta», «Sesión termina al reconectar», «Turno interrumpido», «Turno en otra pestaña». «Chat · historial y conversación» › «Turno en curso al abrir» (abre cualquier conversación del historial).

### 2. Código, archivos, gráficas y tablas (D114, D116, D118) · fase posterior
- **Builder:** sección «Ejecutar código» tras Knowledge bases, casilla «Puede ejecutar código» (`snap.code`), parte de la versión. «Próximamente» en «Disponible hoy». *Falta:* que la Revisión la liste en el diff como el resto.
- **Fase del turno:** «Ejecutando código…»; paso «Ejecutó código» / «Falló el código».
- **Bloque:** una cabecera para todas las celdas de la respuesta: «Analizando…» (spinner), «Analizado», «Error», «Pausado», con «{n} celdas · {duración}» y «Ver código». Plegado por defecto; las figuras se ven siempre. Plegado con error muestra la primera línea de la excepción; pausado, «Quedó sin terminar porque la respuesta se detuvo.». Abierto: por celda, el código, STDOUT y STDERR (rótulos en mono; la salida seguida del mismo tipo va junta), «Salida recortada: se muestran los primeros 20.000 caracteres.» (el número lo fija el servidor) y la excepción. Tope de 300 s: «La celda pasó su tope de 300 s y se detuvo.». Celda bloqueada por el guardrail: «Mango no muestra el código ni la salida de esta celda: infringían una regla de seguridad.».
- **Figuras:** miniaturas en rejilla; cargando, «No se pudo cargar la figura.» + «Reintentar», ampliar (modal) y descargar. En el prototipo la imagen es un marcador con nombre y tamaño.
- **Tarjeta de archivo:** tipo (insignia), nombre, «{tipo} · {tamaño} · de {agente} · {conversación}» y «Descargar». Estados: «Revisando el archivo…», listo, «El escaneo de malware bloqueó este archivo. No se puede descargar.», «No se pudo preparar la descarga. Inténtalo de nuevo.» (el botón pasa a «Reintentar»), «Llegaste al máximo de 60 descargas por hora. Podrás descargar de nuevo en {m} minutos.», «Ya no está disponible. Los archivos se guardan 90 días y se borran con la conversación.». El enlace de 5 minutos no se nombra: se pide al pulsar y baja como archivo.
- **Gráfica:** barras, líneas, tarta y dispersión con título, subtítulo, leyenda (con más de una serie) y el valor bajo el puntero. «Copiar datos» copia una tabla separada por tabulaciones; aviso «Datos copiados. Pégalos en Excel o en una hoja de cálculo.». Números con `Intl` del navegador (formato regional). Estados: «Cargando la gráfica…» y «No se pudo dibujar esta gráfica. Los datos que mandó el agente no tienen el formato que espera Mango. Pídele que la vuelva a generar o que te los dé en una tabla.».
- **Tabla:** nombre, «{n} filas · {n} columnas», cabecera fija y scroll (máx. 300 px), tope visible de 200 filas: «Se muestran 200 de {n} filas. Descarga el CSV para verlas todas.» y la tarjeta del CSV al pie (mismos estados).
- Orden en la respuesta: bloque → texto → gráfica → tabla → archivos. La tarjeta de «artifact» (Canvas, D124) no cambia.
- Demo: «Chat · progreso del turno» › «Ejecuta código» y envía cualquier mensaje. Variantes: «Chat · bloque «Analizando»», «Chat · figuras», «Chat · archivo generado», «Chat · gráfica». «Cancelar» mientras corre deja el bloque en «Pausado».

### 3. Compositor con adjuntos (D116) · fase posterior
- 20 archivos de hasta 100 MB. Texto al arrastrar: «Hasta 20 archivos · 100 MB c/u · PDF, CSV, TXT, JSON, Excel, Word, PowerPoint, PNG, JPG» (la lista la fija el servidor; el prototipo usa esa).
- Estados de cada adjunto: «Subiendo · {n} %», «Revisando el archivo…», listo (tamaño), «Bloqueado por el escaneo», «Tipo no permitido», «El contenido no es del tipo que dice» (lo comprueba el servidor), «Supera 100 MB», «No se pudo subir» + «Reintentar». Con más de 20: «Puedes adjuntar hasta 20 archivos por mensaje. {n} se quedaron fuera.».
- En el historial, un adjunto de más de 90 días sale tachado con «Ya no disponible» (`gone` en el adjunto).
- Demo: «Chat · adjuntos» y «Chat · adjuntar ejemplo» (en «Diseño completo»).

### 4. Decisiones de diseño (por confirmar con el producto)
- **Enviar espera a que todos los adjuntos estén listos.** Mientras alguno sube o se revisa, «Enviar» queda desactivado con «Enviar se activa cuando terminen de subirse y revisarse los archivos.». Con alguno con problemas: «Quita los archivos con problemas para enviar el mensaje.». Motivo: si el mensaje sale antes, el agente puede responder sin el archivo y el turno se cobra igual.
- **«Adjuntar» en un agente sin «Ejecutar código»: deshabilitado con su motivo**, no oculto, para que se sepa que existe. Al pulsarlo: «{agente} no puede leer archivos: su versión no tiene «Ejecutar código». Quien lo administra puede activarlo en el Builder.». Al arrastrar: «{agente} no puede leer archivos». En el prototipo tienen la capacidad FinOps, Data y Ops (`CR_CODE_AGENTS`, o `agent.code`).
