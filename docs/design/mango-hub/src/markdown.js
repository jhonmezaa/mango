// Markdown del agente → HTML. Los estilos viven solo en styles.css (.md …).
// El contenido que genera el modelo no es confiable: se escapa todo, las imágenes se bloquean
// y los enlaces pasan por el diálogo «Abrir enlace externo» (data-ext-url, solo http/https).
(function(){
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function safeUrl(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; } }
  function link(text, url) { const u = safeUrl(url); return u ? `<a href="${esc(u)}" data-ext-url="${esc(u)}" rel="noopener noreferrer">${text}</a>` : text; }
  function renderInline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    let out = esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<span class="md-img-blocked" title="Las imágenes del agente no se cargan">[Imagen bloqueada]</span>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, u) => link(t, u.replace(/&amp;/g, '&')))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + link(u, u.replace(/&amp;/g, '&')))
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[+i]) + '</code>');
  }
  const NUM = /^[-+−]?\s*(USD|US\$|\$|€|MXN)?\s*[-+−]?[\d][\d.,\s]*\s*(%|ms|s|h|d|k|K|M|MB|GB)?$/;
  const cells = (l) => { let s = l.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map(c => c.trim()); };
  const isSep = (l) => l && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  function renderMarkdown(text) {
    if (!text) return '';
    const lines = text.split('\n');
    let out = '', i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.includes('|') && isSep(lines[i + 1])) {
        const head = cells(line); i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
        const num = head.map((_, j) => { const v = rows.map(r => r[j]).filter(Boolean); return v.length > 0 && v.every(c => NUM.test(c.replace(/\*\*/g, ''))); });
        const cls = (j) => num[j] ? ' class="num"' : '';
        out += '<div class="md-table"><table><thead><tr>' + head.map((h, j) => `<th${cls(j)}>${renderInline(h)}</th>`).join('') + '</tr></thead><tbody>'
          + rows.map(r => '<tr>' + head.map((_, j) => `<td${cls(j)}>${renderInline(r[j] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
        continue;
      }
      if (line.startsWith('```')) {
        i++; let code = '';
        while (i < lines.length && !lines[i].startsWith('```')) { code += lines[i] + '\n'; i++; }
        i++; out += `<pre><code>${esc(code)}</code></pre>`; continue;
      }
      const h = line.match(/^(#{1,4})\s+(.+)$/);
      if (h) { const lv = Math.min(3, h[1].length); out += `<h${lv}>${renderInline(h[2])}</h${lv}>`; i++; continue; }
      if (/^\s*[-*]\s+/.test(line)) {
        out += '<ul>';
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { out += `<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`; i++; }
        out += '</ul>'; continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        out += '<ol>';
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { out += `<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`; i++; }
        out += '</ol>'; continue;
      }
      if (/^>\s?/.test(line)) {
        let q = '';
        while (i < lines.length && /^>\s?/.test(lines[i])) { q += (q ? ' ' : '') + lines[i].replace(/^>\s?/, ''); i++; }
        out += `<blockquote>${renderInline(q)}</blockquote>`; continue;
      }
      if (!line.trim()) { i++; continue; }
      let p = line; i++;
      while (i < lines.length && lines[i].trim() && !/^#{1,4}\s|^```|^\s*[-*]\s|^\s*\d+\.\s|^>/.test(lines[i]) && !(lines[i].includes('|') && isSep(lines[i + 1]))) { p += ' ' + lines[i]; i++; }
      out += `<p>${renderInline(p)}</p>`;
    }
    return out;
  }
  window.renderMarkdown = renderMarkdown;
})();
