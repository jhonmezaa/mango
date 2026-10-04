# Brief para Claude Design: Presupuestos y Configuración (Admin v0)

> Pégalo en el proyecto **Mango** de Claude Design junto con las capturas de `admin-v0-capturas/`.
> Las capturas muestran lo que ya está construido: úsalas como punto de partida, no como diseño final.

## Contexto

Mango es una plataforma de agentes de IA para empresas sobre AWS. Estas pantallas son solo para **administradores** (grupo `mango-admin`) y viven en el sidebar bajo **Plataforma › Gobernanza**, junto a "Auditoría".

Hay que diseñar dos pantallas nuevas (o rediseñar lo construido) dentro del sistema visual actual del proyecto:
- sans y mono;
- light-first, con dark disponible;
- tokens `--accent` y `--accent-ink`;
- botones primarios con texto blanco en tema claro;
- cards de radio 12, tablas con encabezados en minúscula;
- sin emojis;
- en español.

**Importante para el diseño:**
- **Cero datos inventados.** Usa placeholders neutros (`usuario@empresa.com`, `ou-xxxx-xxxxxxxx`, montos de ejemplo) y marca que son de ejemplo.
- **Sin gráficos** en esta versión.
- **Todo texto que venga de datos** (emails, nombres de OU, motivos) se muestra como texto plano, nunca como HTML.
- **Solo lo que existe hoy** (ver "Qué NO incluir").
- Debe funcionar a **1440 px** y a **420 px** (móvil), con estados de carga, vacío y error.

---

## 1. Presupuestos (`/admin/budgets`)

### Qué hace

Controla cuánto puede gastar en IA cada usuario y cada agente por mes. El gasto se **reserva antes** de cada consulta al agente, y al llegar al 100 % **se bloquea** (el usuario ve "Se agotó tu presupuesto").

### Datos reales disponibles

| Dato | Detalle |
|---|---|
| Período | Mes en curso, p. ej. `2026-09` |
| Límite **por defecto por usuario** | Aplica a quien no tiene límite propio. Ej.: USD 5,00 |
| Límite del **agente FinOps** | Tope mensual de todo el agente. Ej.: USD 30,00 |
| Por cada **agente** | id, nombre, límite, gastado |
| Por cada **usuario** con gasto este mes o con límite propio | email (puede faltar: entonces se muestra el ID corto), límite efectivo, **si es límite propio o el por defecto**, gastado |
| Versión | Para detectar ediciones simultáneas |

Montos en USD con formato `USD 1.234,56`. Estado según % del límite: **OK**, **En alerta** (≥ 80 %) y **Agotado** (≥ 100 %).

### Acciones

- Editar los **valores por defecto** (por usuario y del agente). Un modal con dos montos.
- Poner o quitar el **límite propio** de un usuario. Un modal con un monto o la opción "usar el valor por defecto".
- **Tu propia fila no se puede editar**, porque otro admin debe cambiar tu presupuesto. Mostrarla en solo lectura con esa explicación.
- **Actualizar** la página.

### Reglas y errores a representar

- Montos: mayores que 0 y hasta 1.000.000, con dos decimales como máximo.
- **"Otro administrador cambió estos datos"**: al guardar, si alguien editó antes, se recarga y se avisa.
- Sin permiso: pantalla de acceso denegado.
- Error de red o servicio: estado de error con "Reintentar".
- Vacío: "Aún no hay gasto este mes".

### Qué NO incluir (no existe en el backend)

Presupuestos por **equipo**, **umbrales de alerta configurables**, **acción al 100 %** distinta de bloquear (pausar o pedir aprobación), **canales de notificación** y la tarjeta de **alertas activas**.

> Si quieres alertas (p. ej. avisar al 80 % por correo), diséñalas **como propuesta aparte**, marcada como "futuro". Requieren backend nuevo.

---

## 2. Configuración (`/admin/settings`)

Hoy tiene dos secciones.

### 2.1 Áreas y OUs

**Qué hace:** cada **área** (p. ej. `finanzas`, `seguridad`) agrupa una o más **OUs** de la organización de AWS. Un **líder de área** solo ve el gasto de las cuentas de sus OUs. Por eso cambiar este mapeo es **sensible**: decide quién ve qué datos.

**Datos reales:**
- **Mapeo vigente:** para cada área, su lista de OUs (id como `ou-a1b2-12345678` y nombre, p. ej. "Finanzas"). Tiene número de versión.
- **Árbol de la organización:** OUs con nombre, padre y ruta (p. ej. `Workloads › Finanzas`), para elegirlas al proponer.
- **Propuestas pendientes:** quién propuso (email), cuándo, cuándo vence (7 días), sobre qué versión se hizo, el mapeo propuesto y el motivo.

**Flujo con doble aprobación** (regla de seguridad, no opcional):
1. Un admin **propone** un cambio: agregar o quitar áreas, y agregar o quitar OUs de un área. El **motivo es obligatorio** (1–500 caracteres).
2. **Otro admin distinto** revisa la propuesta y la **aprueba** o la **rechaza**. Rechazar también exige motivo.
3. Al aprobar, el mapeo cambia de versión.
4. El proponente puede **retirar** su propia propuesta.

**Estados y reglas que el diseño debe mostrar claramente:**
- **Diff** de cada propuesta, por área: área nueva, área eliminada, OUs agregadas y OUs quitadas.
- **"Tu área"**, marcada en el mapeo. **No puedes proponer, aprobar ni rechazar cambios que toquen tu propia área**: el botón deshabilitado debe explicar por qué.
- **No puedes aprobar tu propia propuesta**: el botón deshabilitado debe explicar por qué.
- **Propuesta desactualizada:** si el mapeo cambió después de proponer, aprobarla falla. Avisarlo antes, con una etiqueta de advertencia.
- **Propuesta vencida** (más de 7 días).
- **Límites:**
  - máximo 20 áreas por mapeo y 15 OUs por área;
  - máximo 10 propuestas pendientes a la vez;
  - nombres de área en minúscula, `a-z`, `0-9` y `-`, de 2 a 32 caracteres.
- **Errores:**
  - "Alguna OU no existe en la organización";
  - "Hay demasiadas propuestas pendientes";
  - "Otro administrador cambió el mapeo";
  - "No se pudo registrar la auditoría; el cambio no se aplicó".
- **Si no se puede leer el árbol de la organización**, igual se muestra el mapeo, con los ids de OU sin nombre.

**Sugerencias de diseño abiertas:**
- cómo elegir OUs del árbol (buscador, árbol colapsable…);
- cómo mostrar el diff para que se lea de un vistazo;
- un historial de cambios aprobados, que hoy está en Auditoría: puedes proponer un acceso directo.

### 2.2 Conectividad

**Qué hace:** un botón **"Probar conexión"** verifica que Mango puede leer la organización y la facturación en la cuenta de administración de AWS. Es de solo lectura.

**Resultado:** fecha y hora, y una lista de chequeos, cada uno con **nombre**, **estado** (ok o error) y un **detalle corto**:
- `broker`: Mango puede asumir su rol intermedio;
- `billing_reader`: puede asumir el rol de lectura en la cuenta de administración;
- `organizations`: puede leer la organización.

**Estados:**
- ejecutando;
- todo ok;
- alguno en error, con ayuda de qué revisar;
- **demasiadas pruebas**: máximo 5 por minuto, "espera un minuto".

---

## Qué entregar

- **Diseño de ambas pantallas** en el mismo proyecto, con el mismo sistema visual:
  - Presupuestos, incluidos sus modales;
  - Configuración con Áreas y OUs: editor de propuesta, lista de pendientes con diff, y modales de aprobar y rechazar;
  - Configuración con Conectividad.
- **Versiones** a 1440 y 420 px, en claro y oscuro.
- **Estados:**
  - carga, vacío y error;
  - botones deshabilitados con su explicación;
  - propuesta desactualizada o vencida.
- **Cualquier propuesta nueva** (p. ej. alertas de presupuesto), marcada como "futuro".
