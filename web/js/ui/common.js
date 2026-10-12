'use strict';
/* =====================================================================
 * ui/common.js — 화면 공통: DOM·문자열 도구 · 화면 상태(UI) · 결과 렌더 조각(SQL 강조 · 표 · 타임라인 · diff · 차트)
 * ===================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const html = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prefs = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } } };

const UI = {
  open: false, busy: false, ready: false, failed: null, readyWaiters: [], runs: new Map(), progress: '대시보드를 먼저 띄우는 중',
  tab: 'chat', widePref: false, downloads: null, logsShared: false,
  sample: null, llmLast: null, checking: false,   // llmLast: 마지막 Claude 호출 결과 {ok, code}
  monFilter: null, monSel: null, testing: false, testResult: null,
};
const whenReady = () => UI.ready ? Promise.resolve() : new Promise((ok, fail) => UI.readyWaiters.push([ok, fail]));

/* ---------------------------------------------------------------------
 * 렌더 조각: SQL 강조 · 표 · 하네스 타임라인 · diff · 차트
 * ------------------------------------------------------------------- */
const KW = /^(SELECT|FROM|WHERE|AND|OR|NOT|GROUP|ORDER|BY|HAVING|LIMIT|JOIN|LEFT|INNER|CROSS|ON|AS|WITH|CASE|WHEN|THEN|ELSE|END|IN|IS|NULL|DISTINCT|UNION|ALL|DESC|ASC|BETWEEN|LIKE|USING|OVER|PARTITION|EXISTS|DELETE|INSERT|INTO|UPDATE|DROP|CREATE|TABLE|VALUES|SET)$/i;
function hl(sql) {
  return String(sql || '').split(/('(?:[^']|'')*'|\b\d+(?:\.\d+)?\b|[A-Za-z_]+)/).map((p, i) => i % 2 === 0 ? escHtml(p)
    : p[0] === "'" ? `<span class="str">${escHtml(p)}</span>` : /^\d/.test(p) ? `<span class="nm">${p}</span>` : KW.test(p) ? `<span class="kw">${p}</span>` : escHtml(p)).join('');
}
const fmtSql = s => String(s || '').replace(/\s+/g, ' ').replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|LEFT JOIN|INNER JOIN|CROSS JOIN|JOIN|UNION ALL|UNION)\b/gi, '\n$1').replace(/\s+(AND)\s+/g, '\n  $1 ').trim();
const sqlBlock = s => `<pre class="sql">${hl(fmtSql(s))}</pre>`;
const statusTag = st => `<span class="tag ${STATUS[st]?.tone || ''}">${escHtml(STATUS[st]?.label || st)}</span>`;
const fmtCell = (c, v) => v === null || v === undefined ? '<span class="muted">NULL</span>' : SENSITIVE_COLS.test(c) ? '***' : typeof v === 'number' ? fmtNum(v) + (/_pct$/.test(c) ? '%' : '') : escHtml(v);
const fmtTime = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };

function dataTable(columns, rows, { max = 200 } = {}) {
  if (!rows?.length) return '<p class="empty">결과 행이 없습니다.</p>';
  const num = columns.map((_, i) => rows.every(r => r[i] === null || typeof r[i] === 'number'));
  return `<div class="tbl-wrap"><table class="t"><thead><tr>${columns.map((c, i) => `<th class="${num[i] ? 'num' : ''}">${escHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.slice(0, max).map(r => `<tr>${r.map((v, i) => `<td class="${num[i] ? 'num' : ''}">${fmtCell(columns[i], v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function timeline(stages) {
  return `<ol class="timeline">${stages.map(s => `<li class="${s.ok ? '' : 'fail'}"><span class="b">${s.ok ? '✓' : '!'}</span><div class="s">${escHtml(s.name)}<span class="tm">${s.t}ms</span></div><div class="d">${escHtml(s.detail)}</div></li>`).join('')}</ol>`;
}
function checkList(checks) {
  return `<div class="checks">${(checks || []).map(c => `<div class="check ${c.ok ? 'ok' : 'no'}"><span class="i">${c.ok ? '✓' : '✗'}</span><span class="nm2">${escHtml(c.name)}</span><span class="dt">${escHtml(c.detail)}</span></div>`).join('')}</div>`;
}
// 줄 단위 LCS diff (자동 수정 전후 SQL, 같은 질문의 이전 실행 SQL 비교)
function lineDiff(a, b) {
  const A = String(a || '').split('\n'), B = String(b || '').split('\n');
  const n = A.length, m = B.length, d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) d[i][j] = A[i] === B[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push(['same', A[i]]); i++; j++; } else if (d[i + 1][j] >= d[i][j + 1]) out.push(['del', A[i++]]); else out.push(['add', B[j++]]); }
  while (i < n) out.push(['del', A[i++]]); while (j < m) out.push(['add', B[j++]]);
  return `<div class="diff">${out.map(([k, l]) => `<div class="${k}">${escHtml(l)}</div>`).join('')}</div>`;
}

// 차트: 비교 = 가로 막대, 추이 = 선 (결과 표와 같은 값, 하나의 축척)
function pickChart(ans) {
  const { columns: cols, rows } = ans;
  if (!rows || rows.length < 2) return null;
  const numIdx = cols.map((_, i) => i).filter(i => rows.every(r => r[i] === null || typeof r[i] === 'number'));
  let x = cols.indexOf(ans.chart?.x);
  if (x < 0 || numIdx.includes(x)) x = cols.findIndex((_, i) => !numIdx.includes(i));
  if (x < 0) return null;
  let y = (ans.chart?.y || []).map(c => cols.indexOf(c)).find(i => i >= 0 && numIdx.includes(i));
  if (y === undefined) y = numIdx.find(i => /_pct$|rate/.test(cols[i])) ?? numIdx.filter(i => i !== x).pop();
  if (y === undefined) return null;
  return { x, y, line: ans.chart?.type === 'line' || (/date|month/.test(cols[x]) && rows.length > 8) };
}
function chartHtml(ans) {
  const c = pickChart(ans); if (!c) return '';
  const rows = ans.rows.filter(r => r[c.y] !== null).slice(0, 60);
  const yName = ans.columns[c.y], pct = /_pct$/.test(yName);
  const max = Math.max(...rows.map(r => r[c.y]), 0) || 1;
  const legend = `<div class="legend"><span>${escHtml(ans.columns[c.x])}별 ${escHtml(yName)}</span></div>`;
  if (!c.line) {
    return legend + rows.slice(0, 30).map(r => `<div class="bar-row"><span title="${escHtml(r[c.x])}">${escHtml(r[c.x] ?? 'NULL')}</span><span class="track"><span class="fill" style="width:${(100 * Math.max(r[c.y], 0) / max).toFixed(1)}%;display:block"></span></span><span class="val">${fmtNum(r[c.y])}${pct ? '%' : ''}</span></div>`).join('');
  }
  const W = 640, H = 220, L = 48, R = 12, T = 12, B = 30, last = rows.length - 1;
  const xs = i => L + (W - L - R) * (rows.length === 1 ? 0.5 : i / last);
  const ys = v => T + (H - T - B) * (1 - v / max);
  const pts = rows.map((r, i) => `${xs(i).toFixed(1)},${ys(r[c.y]).toFixed(1)}`).join(' ');
  return legend + `<svg class="svgchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escHtml(yName)} 추이" style="width:100%;height:auto">
    ${[0, 0.25, 0.5, 0.75, 1].map(f => max * f).map(v => `<line class="gl" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"></line><text x="${L - 6}" y="${ys(v) + 4}" text-anchor="end">${fmtNum(+v.toFixed(1))}</text>`).join('')}
    <polygon points="${L},${ys(0)} ${pts} ${xs(last)},${ys(0)}" style="fill:var(--blue);opacity:.1"></polygon>
    <polyline points="${pts}" style="fill:none;stroke:var(--blue);stroke-width:2"></polyline>
    <circle cx="${xs(last)}" cy="${ys(rows[last][c.y])}" r="3.5" style="fill:var(--blue)"></circle>
    ${[...new Set([0, Math.floor(last / 2), last])].map(i => `<text x="${xs(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === last ? 'end' : 'middle'}">${escHtml(rows[i][c.x])}</text>`).join('')}
  </svg>`;
}
