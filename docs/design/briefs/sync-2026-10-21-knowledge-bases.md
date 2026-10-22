# Contexto para Claude Design: «Knowledge Bases», primera versión solo con S3 (oct 2026)

El producto todavía no implementa «Knowledge Bases»: hoy la entrada del menú existe y la pantalla no tiene backend. Este es el contexto del hito que la va a construir (D88, aceptada por el dueño el 2026-10-21) para que el diseño lo resuelva antes. Es contexto, no una especificación de pantalla: actualiza el diseño y HANDOFF.md con lo que corresponda. Lo que no tenga backend en esta versión se muestra como «Próximamente», sin datos de ejemplo (D24).

## 1. Lo que el diseño ya tiene (`knowledge.jsx`) y se mantiene

- La lista con sus cuatro indicadores (knowledge bases, documentos indexados, necesitan atención, consultas de 30 días), la búsqueda, los filtros «Todas», «Necesitan atención» y «Sin sincronizar», el filtro por fuente y las columnas (knowledge base, fuente, estado, tamaño, acceso, agentes).
- El detalle en un panel lateral con «Resumen», «Documentos», «Probar búsqueda» y «Acceso y sync».
- Los estados «Sincronizada», «Con avisos», «Error», «Sincronizando» y «Sin sincronizar», y la lista de documentos no indexados con su motivo («OCR sin texto legible», «Formato no soportado», «PDF protegido con contraseña»…).
- Los grupos que pueden consultarla, la frecuencia (Manual, Cada 6 h, Diaria, Semanal), «Sincronizar ahora» y la insignia de exposición.
- Crean y editan los administradores y los creadores de agentes (`agent.create` en el diseño): coincide con lo que decidió el dueño.

## 2. Lo que cambia o falta (hace falta diseño)

### 2.1 Fuentes de la primera versión

Solo S3. «Confluence», «Google Drive» y «GitHub» se quedan en el selector como «Próximamente». La fuente S3 tiene dos maneras de traer documentos, y una misma knowledge base podría tener una, la otra o las dos (a decidir en el diseño si se permite mezclar):

- **Subir archivos** desde el navegador.
- **Un bucket que ya existe** en la cuenta de AWS de la instalación: `s3://bucket/prefijo/`. Es lo único que hoy dibuja el diseño (el campo «Bucket»).

Las URLs web (rastrear un sitio o un sitemap) quedan fuera de esta versión, para evaluar más adelante.

### 2.2 Subir archivos (el diseño no lo tiene)

- Se eligen o se arrastran archivos; cada uno sube directo a S3 y después se «guarda» en la knowledge base. Al guardar empieza la indexación sola.
- Tipos admitidos: PDF, DOCX, TXT, MD, CSV y XLSX. Hasta 50 MB por archivo, 20 archivos por vez, 1.000 documentos y 5 GB por knowledge base (propuestos).
- Cada archivo pasa por: subiendo (con progreso), subido, rechazado (con motivo: tipo no admitido, demasiado grande, el contenido no es del tipo que dice), indexando, indexado, no indexado (con el motivo de hoy).
- Un archivo subido que no se guarda se pierde al día siguiente.
- Quitar un documento lo saca de las respuestas de los agentes; mientras se borra, el documento está «Borrando».
- En esta versión no se descarga el documento original desde Mango: ni en el detalle ni en las citas.

### 2.3 Un bucket que ya existe

- Solo buckets de la cuenta de la instalación; los de Mango y los de otras cuentas se rechazan, con un mensaje que lo diga.
- Lo propone un creador y lo aprueba o rechaza un administrador distinto de quien lo propuso (también cuando lo propone otro administrador). Mientras tanto la fuente está «Pendiente de aprobación» y no se lee nada; un rechazo lleva su estado. La solicitud aparece en Aprobaciones y en la Bandeja de los administradores que pueden firmarla: hace falta su tarjeta. Cambiar el bucket o el prefijo de una fuente aprobada es una propuesta nueva.
- Un bucket cifrado con una llave propia del cliente no se puede leer en esta versión: hace falta su mensaje.
- Lo que hay en el bucket se copia a Mango en cada sincronización; un archivo borrado en el bucket sale de la knowledge base en la siguiente.
- La frecuencia de sincronización solo aplica a los buckets; los archivos subidos se indexan al guardarlos.

### 2.4 Estados de la sincronización

Además de los que ya tiene el diseño:

- **No empezó por presupuesto:** la sincronización estima el costo de los embeddings antes de empezar y no arranca si no alcanza.
- **Supera el tope** de documentos o de tamaño de la knowledge base.
- **Ya hay una sincronización en curso** de la misma knowledge base.
- **Borrando** una knowledge base entera: no desaparece de la lista hasta que se comprueba que ningún agente puede recibir sus fragmentos.

### 2.5 Asociar knowledge bases en el Agent Builder (el diseño no lo tiene)

Hoy el Builder no tiene knowledge bases (D38). La knowledge base es una entidad propia, compartida entre agentes, y se asocia en el Builder:

- Hasta 5 por agente; el Builder solo ofrece las que su autor puede usar.
- Es parte de la versión: la Revisión debe mostrar qué knowledge bases usa el agente, como hoy muestra sus tools.
- Una knowledge base usada por un agente publicado no se puede borrar hasta quitarla de una versión nueva.
- En el chat, las respuestas pueden citar fragmentos (knowledge base, documento y página), sin enlace al original.

### 2.6 La alerta de exposición (D26) cambia de sentido

El diseño dice: «… es visible para grupos sin acceso a esta knowledge base. Esos usuarios podrían ver su contenido a través del agente». En Mango la búsqueda se hace con la identidad de quien pregunta: una persona que no está en los grupos de la knowledge base no recibe nada de ella, aunque use el agente. La alerta sigue, pero lo que avisa es que esos grupos usan el agente y **no van a recibir respuestas de esa knowledge base**. Hace falta su texto, en la lista, en el detalle y en el Builder (este cambio es de seguridad: no se puede mantener el texto actual).

### 2.7 Quién ve qué

- La lista (nombre, descripción, estado, grupos) la ven creadores y administradores.
- Los documentos de una knowledge base los ven su dueño, los administradores y los creadores que están en sus grupos.
- «Probar búsqueda» exige además estar en los grupos de la knowledge base (D88 (37), precisión de (29), elegida por el dueño el 2026-10-22). Ni el dueño ni un administrador la usan por serlo, porque la búsqueda devuelve contenido y se hace con la identidad de quien pregunta. Un administrador o un dueño que no está en sus grupos ve la pestaña «Documentos», pero no puede probar la búsqueda.
- Hace falta un estado para cada pestaña, para quien no puede usarla:
  - en «Documentos», para quien no ve los documentos de esa knowledge base;
  - en «Probar búsqueda», para quien no puede probarla: no ve los documentos, o los ve pero no está en sus grupos. En el segundo caso conviene que el texto diga por qué: quien prueba no está en los grupos de esta knowledge base.
- «Probar búsqueda» devuelve fragmentos de texto, sin formato enriquecido, cada uno con su documento, su página (si la hay) y su puntaje.

### 2.8 Datos que el diseño muestra y quizá no estén

- «Consultas · 30 días»: si la métrica no llega en esta versión, «Próximamente».
- «Embeddings: Amazon Titan Embeddings v2 · Bedrock»: correcto; es el único perfil de esta versión.
- «Tamaño en tokens»: se sabrá después de indexar; antes, el tamaño en bytes.

## 3. Auditoría

Cada acción deja un evento `kb.*`: crear, editar (grupos, frecuencia), subir y guardar documentos, quitar documentos, añadir o quitar una fuente, sincronizar, probar una búsqueda, borrar, y cada consulta de un agente. El diseño ya tiene `kb.create`, `kb.update`, `kb.sync` y `kb.query`.
