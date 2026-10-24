// Knowledge Bases · primera versión (D88): solo S3, por archivos subidos o un bucket que ya existe.
// Datos, permisos y acciones que comparten la pantalla, Aprobaciones, Bandeja, Agent Builder, Revisión y chat.
const KB_LIMITS = { fileMB: 50, batch: 20, docs: 1000, bytes: 5e9, perAgent: 5 };
const KB_TYPES = ['pdf', 'docx', 'txt', 'md', 'csv', 'xlsx'];
const KB_FREQS = [['manual', 'Manual'], ['6h', 'Cada 6 h'], ['24h', 'Diaria'], ['7d', 'Semanal']];
const KB_ORIGIN = { upload: 'Archivos subidos', bucket: 'Bucket de S3' };
// [bucket, archivos subidos, insignia, con spinner]. Los archivos subidos se indexan al guardarlos: no se «sincronizan».
const KB_ST = {
  ok: ['Sincronizada', 'Indexada', 'badge-green'], warn: ['Con avisos', '', 'badge-amber'], error: ['Error', '', 'badge-red'],
  syncing: ['Sincronizando', 'Indexando', 'badge-blue', 1], pending: ['Sin sincronizar', 'Sin documentos', 'badge'],
  approval: ['Pendiente de aprobación', '', 'badge-amber'], rejected: ['Bucket rechazado', '', 'badge-red'], nosource: ['Sin bucket', '', 'badge'],
  blocked: ['No empezó', '', 'badge-amber'], deleting: ['Borrando', '', 'badge', 1],
};
const KB_REQ_ST = { pending: ['Pendiente', 'badge-amber'], approved: ['Aprobado', 'badge-green'], rejected: ['Rechazado', 'badge-red'], withdrawn: ['Retirado', 'badge'] };
const KB_NAMES = {
  'kb-01': ['rollback-ecs.md', 'rollback-lambda.md', 'dr-cambio-de-region.md', 'rds-conexiones-agotadas.md', 'rotacion-de-certificados.md', 'eks-escalado-de-nodos.md', 'nat-gateway-saturado.md', 'restaurar-snapshot-rds.md', 'cloudfront-errores-5xx.md', 'sqs-cola-atascada.md'],
  'kb-02': ['Handbook-2026.pdf', 'Politica-de-vacaciones-2026.pdf', 'Beneficios-2026.pdf', 'Onboarding-primer-dia.docx', 'Trabajo-remoto.md', 'Licencias-y-permisos.pdf', 'Codigo-de-conducta.pdf', 'Viaticos-2026.xlsx'],
  'kb-03': ['Savings-Plans-cobertura.md', 'RI-o-Savings-Plans.pdf', 'Rightsizing-EC2.md', 'Asignacion-de-costos.pdf', 'Etiquetas-obligatorias.csv', 'Cierre-mensual.md', 'Anomalias-de-costo.md', 'Presupuestos-por-area.xlsx'],
  'kb-04': ['estandares/soc2-controles.md', 'iam/minimo-privilegio.md', 'respuesta/credenciales-expuestas.md', 'respuesta/ransomware.md', 'estandares/cifrado-en-reposo.md'],
  'kb-05': ['compras/Proceso-de-compras.pdf', 'compras/Three-way-match.md', 'proveedores/Proveedores-aprobados.xlsx', 'compras/Flujo-de-aprobacion.pdf', 'proveedores/Alta-de-proveedor.docx'],
  'kb-06': ['tablas/ventas_diarias.md', 'tablas/clientes.md', 'metricas/ingreso-neto.md', 'metricas/margen-bruto.md', 'contratos/pedidos-v3.md'],
  'kb-07': ['2026/release-0.9.md', '2026/release-0.8.md', 'rfc/rfc-041-colas.md', 'rfc/rfc-040-cache.md', '2025/release-0.7.md'],
  'kb-10': ['Bienvenida-2025.pdf', 'Primer-dia-2025.docx', 'Herramientas-2025.md'],
};
const KB_FILL = { 'kb-01': 'procedimientos/proc-{n}.md', 'kb-02': 'Politica-{n}.pdf', 'kb-03': 'Playbook-{n}.md', 'kb-04': 'politicas/pol-{n}.md', 'kb-05': 'compras/Procedimiento-{n}.pdf', 'kb-06': 'tablas/tabla-{n}.md', 'kb-07': 'changelog/{n}.md', 'kb-10': 'Guia-{n}.pdf' };
// Fragmentos de ejemplo para «Probar búsqueda» y las citas del chat. Texto plano, como llega de la búsqueda.
const KB_SNIPS = {
  'kb-01': [['rollback-ecs.md', null, 'Para volver a la versión anterior de un servicio de ECS, actualiza el servicio con la definición de tarea previa y espera a que el despliegue llegue a COMPLETED. Si el health check falla dos veces seguidas, detén el despliegue y avisa en el canal de incidentes.'], ['dr-cambio-de-region.md', null, 'El cambio de región lo decide el líder de guardia. Primero se promueve la réplica de RDS en us-west-2 y después se cambia el registro de Route 53, con TTL de 60 segundos.'], ['rds-conexiones-agotadas.md', null, 'Si las conexiones de RDS superan el 90 % del máximo, revisa primero los pools de los servicios con más réplicas. Reiniciar la instancia es el último recurso.'], ['restaurar-snapshot-rds.md', null, 'Restaura el snapshot en una instancia nueva, nunca sobre la existente. Verifica el conteo de filas de las tablas críticas antes de cambiar la cadena de conexión.']],
  'kb-02': [['Politica-de-vacaciones-2026.pdf', 3, 'A partir del 1 de enero de 2026, los días de vacaciones se acumulan desde el primer mes de trabajo. Los días no tomados al cierre del año se pagan al 150 % del salario diario.'], ['Beneficios-2026.pdf', 7, 'Cada persona dispone de 2 días de bienestar por año calendario. No se acumulan y se piden como cualquier día de vacaciones.'], ['Handbook-2026.pdf', 22, 'Las vacaciones se piden en el portal de personas con al menos 15 días de anticipación, salvo acuerdo con el líder del equipo.'], ['Trabajo-remoto.md', null, 'Se puede trabajar en remoto hasta tres días por semana, acordándolo con el líder del equipo. Los días presenciales los fija cada equipo.']],
  'kb-03': [['Savings-Plans-cobertura.md', null, 'Antes de comprar un Savings Plan, la cobertura objetivo es el 70 % del uso estable de los últimos 30 días. Por encima del 85 % crece el riesgo de pagar compromiso sin uso.'], ['RI-o-Savings-Plans.pdf', 4, 'Las Reserved Instances solo convienen para RDS y ElastiCache, donde los Savings Plans no aplican. Para EC2, Fargate y Lambda se usan Compute Savings Plans.'], ['Rightsizing-EC2.md', null, 'Una instancia es candidata a bajar de tamaño si su CPU máxima no pasa del 40 % en 14 días y la memoria no pasa del 60 %.'], ['Anomalias-de-costo.md', null, 'Toda anomalía de más de USD 500 se investiga el mismo día. Se documenta la causa y, si fue un error, quién lo corrige y cuándo.']],
  'kb-05': [['compras/Three-way-match.md', null, 'El three-way match compara la orden de compra, la entrada de mercancía y la factura. Una diferencia de precio de más del 2 % bloquea el pago hasta que Compras la apruebe.'], ['compras/Flujo-de-aprobacion.pdf', 2, 'Las compras de más de USD 10.000 las aprueban el director del área y Finanzas, en ese orden.'], ['proveedores/Proveedores-aprobados.xlsx', null, 'Proveedor 1 · Hardware · aprobado hasta el 31-12-2026 · pago a 45 días.'], ['compras/Proceso-de-compras.pdf', 5, 'Toda solicitud de compra lleva centro de costo y la cotización de al menos dos proveedores aprobados.']],
  'kb-07': [['2026/release-0.9.md', null, 'La versión 0.9 cambia el formato de los eventos de auditoría: el campo outcome pasa a ser obligatorio.'], ['rfc/rfc-041-colas.md', null, 'Propuesta: pasar la cola de ingestión de SQS estándar a FIFO para garantizar el orden por cuenta.'], ['2026/release-0.8.md', null, 'La versión 0.8 agrega reintentos con espera exponencial en las llamadas a Cost Explorer.']],
};
const KB_SAMPLE_Q = { 'kb-01': 'rollback de un servicio de ECS', 'kb-02': 'días de vacaciones el primer año', 'kb-03': 'cobertura objetivo de Savings Plans', 'kb-05': 'aprobación de compras grandes', 'kb-07': 'cambios de la versión 0.9' };
const KB_DEMO_FILES = [['Politica-de-gastos-2026.pdf', 2.4e6], ['Formulario-escaneado.pdf', 5.1e6], ['Preguntas-frecuentes.md', 4.2e4], ['Organigrama.png', 8e5], ['Manual-de-marca.pdf', 7.2e7]];
const KB_REJECT = ['No es la carpeta correcta', 'Tiene datos que no deben copiarse a Mango', 'Ya hay otra knowledge base con esos documentos'];

const kbHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const kbIso = (min) => new Date(Date.now() - min * 6e4).toISOString();
const kbN = (n) => Number(n || 0).toLocaleString('es-ES', { useGrouping: 'always' });
const kbTok = (n) => n >= 1e6 ? (n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n || 0);
const kbBytes = (b) => !b ? '0 MB' : b >= 1e9 ? (b / 1e9).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const kbUsd = (n) => 'USD ' + n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kbAgo = (iso) => iso && window.fmtAgo ? window.fmtAgo(iso) : '—';
const kbFreqLabel = (f) => (KB_FREQS.find(x => x[0] === f) || [null, '—'])[1];
const kbStatus = (k) => { const s = KB_ST[k.status] || KB_ST.pending; return { label: (k.origin === 'upload' && s[1]) || s[0], cls: s[2], spin: !!s[3] }; };
const kbCounts = (k) => { let indexed = 0, failed = 0, busy = 0, bytes = 0; (k.docs || []).forEach(d => { if (d.status === 'indexed') indexed++; else if (d.status === 'failed') failed++; else busy++; bytes += d.bytes || 0; }); return { indexed, failed, busy, bytes, total: (k.docs || []).length }; };
// Tokens, fragmentos, páginas de un documento y consultas de 30 días: el servidor aún no los da. Sin ellos no se muestran (panel de demo: «con los datos»).
const kbMetrics = () => !!window.MangoStore.get().simKbMetrics;
// Cuenta todos los documentos; el tamaño va en bytes (en tokens solo si el servidor los da).
const kbSize = (k) => { const c = kbCounts(k); if (!c.total) return '—'; return kbN(c.total) + ' docs · ' + (kbMetrics() && k.tokens ? kbTok(k.tokens) + ' tokens' : kbBytes(c.bytes)); };
// El presupuesto que frena: «Sincronizar ahora», el de quien la pide; la programada, el de quien creó la knowledge base. Se nombra.
const kbWho = (by, named) => !by ? 'el presupuesto' : !named && by === window.MangoStore.actor() ? 'tu presupuesto' : 'el presupuesto de ' + by;
const kbBlockText = (k, named) => { const b = k.block; if (!b) return ''; return (b.auto ? 'La sincronización programada no empezó' : 'No empezó') + ' por presupuesto: ' + (b.est != null ? 'los embeddings costarían unos ' + kbUsd(b.est) + ' y ' + kbWho(b.by, named) + ' no alcanza.' : kbWho(b.by, named) + ' no alcanza para los embeddings.'); };
const kbBlockHint = ' Vuelve a sincronizar cuando haya presupuesto: «Sincronizar ahora» usa el de quien la pide; la programada, el de quien la creó.';
// Más de 1.000 documentos o 5 GB: se copia hasta el tope y la knowledge base se usa («Con avisos»).
const kbCapText = 'Se copió hasta el tope: el bucket tiene más de ' + kbN(KB_LIMITS.docs) + ' documentos o 5 GB.';
const kbCapHint = ' Acota el prefijo o reparte los documentos en varias knowledge bases.';
// Fuente aprobada que no se pudo leer. La llave propia (KMS) nunca llega aquí: se rechaza al proponer el bucket.
const kbErrText = () => 'No se pudo sincronizar: Mango no pudo leer el bucket.';
const kbStatusSub = (k) => k.status === 'warn' && k.capped ? 'supera el tope' : ['ok', 'warn'].includes(k.status) ? kbAgo(k.lastSync) : k.status === 'blocked' ? 'por presupuesto' : k.status === 'error' ? 'no se pudo leer' : k.status === 'approval' ? 'espera a un administrador' : k.status === 'syncing' && k.prepUntil > Date.now() ? 'preparando el acceso' : '';
const kbRefErr = (ref) => { const v = (ref || '').trim(); if (!v) return 'Escribe el bucket y el prefijo'; if (!/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](\/\S*)?$/.test(v)) return 'Usa el formato s3://bucket/prefijo/'; return null; };
// Lo comprueba el servidor al enviar (alta y «Acceso y sync»). Prototipo: «mango-…» es de Mango; «otra-cuenta» o «externo», de otra cuenta;
// «no-existe» no existe; «kms» o «cifrado», con llave propia. Panel de demo: «Knowledge Bases · respuesta del servidor».
const kbCheckRef = (id, ref) => {
  const S = window.MangoStore; const sim = S.get().simKbSrv; const k = id && kbGet(id);
  if (sim === 'check') return 'No se pudo comprobar el bucket. Inténtalo de nuevo.';
  if (k && (sim === 'pending' || (S.get().kbReqs || []).some(r => r.kb === id && r.status === 'pending'))) return 'Ya hay una propuesta pendiente para esta knowledge base.';
  if (k && k.bucketOk && k.ref === ref) return 'Esta knowledge base ya lee ese bucket y prefijo.';
  const b = ref.replace(/^s3:\/\//, '').split('/')[0];
  if (/^mango-/.test(b)) return 'Ese bucket es de Mango y no se puede usar como fuente.';
  if (/otra-cuenta|externo/.test(b)) return 'Ese bucket no está en la cuenta de AWS de la instalación. Solo se aceptan buckets de esa cuenta.';
  if (/no-existe/.test(b)) return 'Ese bucket no existe en la cuenta de AWS de la instalación.';
  if (/kms|cifrado/.test(b)) return 'Ese bucket está cifrado con una llave propia del cliente (KMS) y esta versión no puede leerlo. Usa otro bucket o una knowledge base de archivos subidos.';
  return null;
};
// Grupos de una persona del directorio (para la regla de Revisión «quien la editó no está en sus grupos»).
const kbGroupsOf = (name) => { const n = (String(name || '').match(/\d+/) || [])[0]; const p = n && (window.MangoStore.get().people || []).find(x => x.email === 'usuario' + n + '@empresa.com'); return p ? p.groups : null; };

const kbMe = () => { const S = window.MangoStore; const R = S.ROLES[S.get().role] || {}; return { me: S.actor(), admin: !!R.admin, creator: !!R.creator, groups: R.groups || [] }; };
// Documentos: dueño, admins y creadores que están en sus grupos. Probar búsqueda: además, estar en sus grupos (la búsqueda va con la identidad de quien pregunta).
const kbAccess = (k) => { const m = kbMe(); const owner = k.owner === m.me; const inGroups = (k.groups || []).some(g => m.groups.includes(g)); const seeDocs = owner || m.admin || (m.creator && inGroups); return { ...m, owner, inGroups, seeDocs, canTest: seeDocs && inGroups, canEdit: owner || m.admin }; };
const kbIdsOf = (a) => a.kbs || (window.MangoData.knowledgeBases || []).filter(k => (k.usedBy || []).includes(a.id)).map(k => k.id);
const kbAgentsOf = (k, agents) => (agents || []).filter(a => kbIdsOf(a).includes(k.id));
const kbAgentGroups = (a) => { try { return window.Lifecycle.snapOf(a).groups || []; } catch (e) { return a.groups || []; } };
// D26 · acceso parcial: grupos que usan un agente que la consulta y no están en la knowledge base. A ellos el agente les responde sin su contenido.
const kbPartial = (k, agents) => kbAgentsOf(k, agents).map(a => ({ a, groups: kbAgentGroups(a).filter(g => !(k.groups || []).includes(g)) })).filter(x => x.groups.length);

function kbSeedDocs(k) {
  const names = KB_NAMES[k.id] || []; const n = k.docCount || 0; const avg = (k.bytes || n * 1.1e6) / Math.max(1, n); const out = [];
  for (let i = 0; i < n; i++) {
    const name = names[i] || (KB_FILL[k.id] || 'documento-{n}.pdf').replace('{n}', String(i + 1).padStart(3, '0'));
    const h = kbHash(k.id + name);
    out.push({ id: k.id + '-' + i, name, bytes: Math.round(avg * (0.6 + (h % 80) / 100)), pages: /\.pdf$/.test(name) ? 2 + h % 38 : null, at: kbIso((k.lastSyncMin || 60) + (h % 30000)), status: 'indexed' });
  }
  (k.failed || []).forEach(([name, reason], i) => out.push({ id: k.id + '-f' + i, name, bytes: Math.round(avg), pages: null, at: kbIso(k.lastSyncMin || 60), status: 'failed', reason }));
  return out;
}

function kbInit() {
  const S = window.MangoStore; if (S.get().kbs) return;
  const kbs = (window.MangoData.knowledgeBases || []).map(k => ({ ...k, docs: kbSeedDocs(k), lastSync: k.lastSyncMin != null ? kbIso(k.lastSyncMin) : null, lastTry: k.lastTryMin != null ? kbIso(k.lastTryMin) : null, tokens: k.tokens || null, chunks: k.chunks || 0, bucketOk: k.origin === 'bucket' && !['approval', 'rejected', 'nosource'].includes(k.status) }));
  // Etiquetado de costos: la programada no empezó por el presupuesto de quien la creó.
  kbs.forEach(k => { if (k.block) k.block = { ...k.block, by: k.owner, auto: true }; });
  const ref = (id) => kbs.find(x => x.id === id).ref;
  const R = (id, kb, by, min, status, x = {}) => ({ id, kb, ref: ref(kb), by, at: kbIso(min), status, ...x });
  const kbReqs = [
    R('KBS-8', 'kb-01', 'Usuario 6', 40, 'pending', { ref: 's3://empresa-runbooks/ops-2026/', prev: ref('kb-01') }),
    R('KBS-7', 'kb-04', 'Usuario 3', 150, 'pending'),
    R('KBS-6', 'kb-08', 'Usuario 2', 4320, 'rejected', { decidedBy: 'Usuario 1', decidedAt: kbIso(4200), note: 'Es la documentación del sitio público: los agentes no necesitan una copia.' }),
    R('KBS-5', 'kb-09', 'Usuario 2', 7200, 'approved', { decidedBy: 'Usuario 1', decidedAt: kbIso(7100) }),
    R('KBS-4', 'kb-07', 'Usuario 6', 43200, 'approved', { decidedBy: 'Usuario 1', decidedAt: kbIso(43000) }),
    R('KBS-3', 'kb-06', 'Usuario 1', 28800, 'approved', { decidedBy: 'Usuario 6', decidedAt: kbIso(28600) }),
    R('KBS-2', 'kb-05', 'Usuario 6', 86400, 'approved', { decidedBy: 'Usuario 1', decidedAt: kbIso(86000) }),
    R('KBS-1', 'kb-01', 'Usuario 6', 129600, 'approved', { decidedBy: 'Usuario 1', decidedAt: kbIso(129000) }),
  ];
  S.set({ kbs, kbReqs });
}

const kbGet = (id) => (window.MangoStore.get().kbs || []).find(k => k.id === id);
const kbPut = (id, patch) => { const S = window.MangoStore; S.set({ kbs: (S.get().kbs || []).map(k => k.id === id ? { ...k, ...(typeof patch === 'function' ? patch(k) : patch) } : k) }); };
const kbReqPut = (id, patch) => { const S = window.MangoStore; S.set({ kbReqs: (S.get().kbReqs || []).map(r => r.id === id ? { ...r, ...patch } : r) }); };
const kbIsAdmin = () => kbMe().admin;
const kbNeedsMe = (r) => r.status === 'pending' && kbIsAdmin() && r.by !== window.MangoStore.actor();
const kbReqTitle = (r) => { const k = kbGet(r.kb); const n = k ? k.name : r.kb; return r.prev ? 'Cambiar el bucket de ' + n : 'Leer un bucket en ' + n; };

function kbFinishSync(id, log) {
  const S = window.MangoStore; const k = kbGet(id); if (!k || k.status !== 'syncing') return;
  const meta = { kb: k.name, bucket: k.ref };
  if (k.readFail) { kbPut(id, { status: 'error', lastTry: new Date().toISOString(), syncStarted: null, prepUntil: null }); if (log) S.log('kb.sync', id, 'No se pudo sincronizar ' + k.name + ': no se pudo leer ' + k.ref, { ...meta, outcome: 'rejected', error: 'sync_failed' }); return; }
  const docs = (k.docs || []).length ? k.docs : kbSeedDocs({ ...k, docCount: k.id === 'kb-04' ? 87 : 18 + kbHash(k.id) % 30, bytes: (k.id === 'kb-04' ? 87 : 30) * 1.1e6, lastSyncMin: 0 });
  const c = kbCounts({ docs });
  kbPut(id, { docs, status: c.failed || k.capped ? 'warn' : 'ok', lastSync: new Date().toISOString(), lastTry: null, syncStarted: null, prepUntil: null, tokens: k.tokens || Math.round(c.bytes / 110), chunks: k.chunks || c.indexed * 22 });
  if (log) S.log('kb.sync', id, 'Sincronizó ' + k.name + ': ' + c.indexed + ' documentos indexados' + (c.failed ? ', ' + c.failed + ' sin indexar' : '') + (k.capped ? ' · se copió hasta el tope' : ''), { ...meta, outcome: 'applied' });
}

const KB = {
  LIMITS: KB_LIMITS, TYPES: KB_TYPES, FREQS: KB_FREQS, ORIGIN: KB_ORIGIN, REQ_ST: KB_REQ_ST, DEMO_FILES: KB_DEMO_FILES, REJECT: KB_REJECT, SAMPLE_Q: KB_SAMPLE_Q,
  ATTN: ['warn', 'error', 'rejected', 'blocked', 'nosource'], UNSYNCED: ['pending', 'approval'],
  n: kbN, tok: kbTok, bytes: kbBytes, usd: kbUsd, ago: kbAgo, freqLabel: kbFreqLabel, status: kbStatus, counts: kbCounts, size: kbSize, blockText: kbBlockText, blockHint: kbBlockHint, capText: kbCapText, capHint: kbCapHint, errText: kbErrText, statusSub: kbStatusSub, metrics: kbMetrics,
  refErr: kbRefErr, checkRef: kbCheckRef, groupsOf: kbGroupsOf, me: kbMe, access: kbAccess, idsOf: kbIdsOf, agentsOf: kbAgentsOf, partial: kbPartial, get: kbGet, isAdmin: kbIsAdmin, needsMe: kbNeedsMe, reqTitle: kbReqTitle,
  partialTip: 'Algún agente que la consulta lo usan grupos que no están en esta knowledge base: a esas personas les responde sin su contenido.',
  // Sincronizar un bucket. Devuelve 'busy' si ya había una en curso, 'failed' si no se pudo empezar, 'blocked' si no arrancó por presupuesto, 'started' si arrancó.
  // Tras aprobar un bucket (first), el servidor espera hasta unos 2 min a que el acceso nuevo quede listo; mientras tanto, «Sincronizando».
  sync(id, auto, opts = {}) {
    const S = window.MangoStore; const k = kbGet(id); if (!k || k.origin !== 'bucket') return null;
    const now = new Date().toISOString(); const meta = { kb: k.name, bucket: k.ref };
    if (!auto && S.get().simKbSync === 'busy') { S.log('kb.sync', id, 'Pidió sincronizar ' + k.name + ': ya había una sincronización en curso', { ...meta, outcome: 'rejected', error: 'in_progress' }); kbPut(id, { status: 'syncing', syncStarted: Date.now() }); setTimeout(() => kbFinishSync(id), 3200); return 'busy'; }
    if (!auto && S.get().simKbSrv === 'syncfail') return 'failed';
    S.log('kb.sync', id, 'Sincronización de ' + k.name, { ...meta, outcome: 'requested' });
    if (k.block) { const block = { ...k.block, by: auto ? k.owner : S.actor(), auto: !!auto }; kbPut(id, { status: 'blocked', lastTry: now, block }); S.log('kb.sync', id, kbBlockText({ ...k, block }, true), { ...meta, outcome: 'rejected', error: 'budget' }); return 'blocked'; }
    const prep = opts.first ? 2600 : 0;
    kbPut(id, { status: 'syncing', syncStarted: Date.now() + prep, prepUntil: prep ? Date.now() + prep : null }); setTimeout(() => kbFinishSync(id, true), 3200 + prep); return 'started';
  },
  // Devuelve { id, notSent }: si la propuesta del bucket no llega a enviarse, la knowledge base queda creada «Sin bucket».
  create(f) {
    const S = window.MangoStore; const id = 'kb-' + Date.now().toString(36).slice(-5); const bucket = f.origin === 'bucket';
    const notSent = bucket && S.get().simKbSrv === 'notsent';
    const k = { id, name: f.name.trim(), desc: f.desc.trim() || 'Sin descripción', owner: S.actor(), icon: 'BookOpen', origin: f.origin, ref: bucket ? f.ref.trim() : null, freq: bucket ? f.freq : null, groups: f.groups, status: bucket ? (notSent ? 'nosource' : 'approval') : 'pending', noSource: notSent ? 'notsent' : null, docs: [], chunks: 0, tokens: null, bucketOk: false, usedBy: [] };
    S.set({ kbs: [...(S.get().kbs || []), k] });
    S.log('kb.create', id, 'Creó la knowledge base ' + k.name + ' (' + (bucket ? 'bucket de S3' : 'archivos subidos') + ')', { kb: k.name, outcome: 'applied' });
    if (bucket && !notSent) KB.propose(id, k.ref);
    return { id, notSent };
  },
  propose(id, ref) {
    const S = window.MangoStore; const k = kbGet(id); const reqs = S.get().kbReqs || [];
    const n = Math.max(0, ...reqs.map(r => parseInt(r.id.slice(4), 10) || 0)) + 1; const change = !!k.bucketOk;
    const r = { id: 'KBS-' + n, kb: id, ref, prev: change ? k.ref : null, by: S.actor(), at: new Date().toISOString(), status: 'pending' };
    S.set({ kbReqs: [r, ...reqs] });
    kbPut(id, change ? {} : { ref, status: 'approval', noSource: null });
    S.log('kb.source_propose', id, change ? 'Propuso cambiar el bucket de ' + k.name + ' a ' + ref : 'Propuso leer ' + ref + ' en ' + k.name, { kb: k.name, bucket: ref, outcome: 'requested' });
    return r;
  },
  decide(reqId, decision, note) {
    const S = window.MangoStore; const r = (S.get().kbReqs || []).find(x => x.id === reqId); if (!r || !kbNeedsMe(r)) return;
    const k = kbGet(r.kb); const now = new Date().toISOString();
    kbReqPut(reqId, { status: decision, decidedBy: S.actor(), decidedAt: now, note });
    if (decision === 'approved') {
      kbPut(r.kb, x => ({ ref: r.ref, bucketOk: true, status: r.prev ? x.status : 'pending', readFail: false, block: r.prev ? null : x.block }));
      S.log('kb.source_approve', r.kb, 'Aprobó ' + reqId + ': ' + (r.prev ? 'leer ' + k.name + ' desde ' + r.ref : 'leer ' + r.ref + ' en ' + k.name) + ' (propuso ' + r.by + ')', { kb: k.name, bucket: r.ref, outcome: 'applied' });
      KB.sync(r.kb, true, { first: true });
    } else {
      if (!r.prev) kbPut(r.kb, { status: 'rejected' });
      S.log('kb.source_reject', r.kb, 'Rechazó ' + reqId + ' — "' + note + '"', { kb: k.name, bucket: r.ref, outcome: 'applied' });
    }
  },
  withdraw(reqId) {
    const S = window.MangoStore; const r = (S.get().kbReqs || []).find(x => x.id === reqId); if (!r || r.status !== 'pending' || r.by !== S.actor()) return;
    kbReqPut(reqId, { status: 'withdrawn', decidedAt: new Date().toISOString() });
    if (!r.prev) kbPut(r.kb, { status: 'nosource', noSource: 'withdrawn' });
    S.log('kb.source_withdraw', r.kb, 'Retiró la propuesta ' + reqId, { kb: kbGet(r.kb)?.name, bucket: r.ref });
  },
  updateCfg(id, patch) {
    const S = window.MangoStore; const k = kbGet(id); kbPut(id, patch);
    const parts = [patch.groups && 'grupos: ' + patch.groups.join(', '), patch.freq && patch.freq !== k.freq && 'frecuencia: ' + kbFreqLabel(patch.freq).toLowerCase()].filter(Boolean);
    S.log('kb.update', id, 'Editó ' + k.name + ' · ' + parts.join(' · '), { kb: k.name, before: { grupos: k.groups.join(', '), ...(k.freq ? { frecuencia: k.freq } : {}) }, after: { grupos: (patch.groups || k.groups).join(', '), ...(patch.freq ? { frecuencia: patch.freq } : {}) } });
  },
  saveUploads(id, files) {
    const S = window.MangoStore; const k = kbGet(id); if (!k || !files.length) return;
    const now = new Date().toISOString(); const st = Date.now().toString(36);
    const docs = files.map((f, i) => ({ id: id + '-u' + st + i, name: f.name, bytes: f.bytes, pages: /\.pdf$/i.test(f.name) ? 1 + kbHash(f.name) % 24 : null, at: now, status: 'indexing' }));
    kbPut(id, x => ({ docs: [...docs, ...(x.docs || [])], status: 'syncing', syncStarted: Date.now() }));
    S.log('kb.upload', id, 'Agregó ' + files.length + (files.length === 1 ? ' documento' : ' documentos') + ' a ' + k.name, { kb: k.name, docs: files.length, outcome: 'applied' });
    setTimeout(() => kbPut(id, x => {
      const all = (x.docs || []).map(d => d.status !== 'indexing' ? d : /escane|scan/i.test(d.name) ? { ...d, status: 'failed', reason: 'OCR sin texto legible' } : /protegid|contrase/i.test(d.name) ? { ...d, status: 'failed', reason: 'Protegido con contraseña' } : { ...d, status: 'indexed' });
      const c = kbCounts({ docs: all }); const add = files.reduce((s, f) => s + f.bytes, 0);
      return { docs: all, status: c.failed ? 'warn' : 'ok', lastSync: new Date().toISOString(), syncStarted: null, tokens: (x.tokens || 0) + Math.round(add / 110), chunks: (x.chunks || 0) + files.length * 18 };
    }), 2800);
  },
  removeDoc(id, docId) {
    const S = window.MangoStore; const k = kbGet(id); const d = k && (k.docs || []).find(x => x.id === docId); if (!d) return;
    kbPut(id, x => ({ docs: x.docs.map(y => y.id === docId ? { ...y, status: 'deleting' } : y) }));
    S.log('kb.doc_remove', id, 'Quitó ' + d.name + ' de ' + k.name, { kb: k.name, doc: d.name, outcome: 'requested' });
    setTimeout(() => {
      kbPut(id, x => { const docs = x.docs.filter(y => y.id !== docId); const c = kbCounts({ docs }); return { docs, status: x.status === 'syncing' ? x.status : !docs.length ? 'pending' : c.failed ? 'warn' : 'ok', tokens: !docs.length ? null : x.tokens && Math.max(0, x.tokens - Math.round(d.bytes / 110)), chunks: !docs.length ? 0 : x.chunks }; });
      S.log('kb.doc_remove', id, 'Quitó ' + d.name + ' de ' + k.name + ': ya no aparece en las respuestas', { kb: k.name, doc: d.name, outcome: 'applied' });
    }, 2200);
  },
  remove(id) {
    const S = window.MangoStore; const k = kbGet(id); if (!k) return;
    kbPut(id, { status: 'deleting' });
    S.log('kb.delete', id, 'Borró la knowledge base ' + k.name, { kb: k.name, outcome: 'requested' });
    setTimeout(() => { S.set({ kbs: (S.get().kbs || []).filter(x => x.id !== id) }); S.log('kb.delete', id, 'Borró la knowledge base ' + k.name + ': ningún agente puede recibir sus fragmentos', { kb: k.name, outcome: 'applied' }); }, 5000);
  },
  // Fragmentos en texto plano, cada uno con su documento, su página (si la hay) y su puntaje. El texto buscado no se registra.
  // Errores del servidor (panel de demo): { error: 'busy' } si la búsqueda está saturada, { error: 'fail' } si falló.
  search(id, q) {
    const S = window.MangoStore; const k = kbGet(id); const sim = S.get().simKbSrv;
    if (sim === 'searchbusy') return { error: 'busy' };
    if (sim === 'searchfail') return { error: 'fail' };
    const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let hits = (KB_SNIPS[id] || []).map(([doc, page, text], i) => ({ doc, page, text, score: 0.58 - i * 0.05 + words.filter(w => (doc + ' ' + text).toLowerCase().includes(w)).length * 0.11 }));
    if (!hits.length) hits = (k.docs || []).filter(d => d.status === 'indexed').slice(0, 3).map((d, i) => ({ doc: d.name, page: d.pages ? 1 + kbHash(d.name) % d.pages : null, text: k.desc, score: 0.52 - i * 0.07 }));
    hits = hits.sort((a, b) => b.score - a.score).slice(0, 4).map(h => ({ ...h, score: Math.min(0.94, h.score) }));
    S.log('kb.search_test', id, 'Probó una búsqueda en ' + k.name + ' · ' + hits.length + (hits.length === 1 ? ' fragmento' : ' fragmentos'), { kb: k.name, hits: hits.length });
    return { hits };
  },
};

kbInit();
Object.assign(window, { KB, kbNeedsMe, kbReqTitle });
