'use strict';
/* =====================================================================
 * rag.js — 문제 2-2 · 2-3: 로그 저장소 · Semantic Layer · 정의 검증 · RAG 검색
 * ===================================================================== */

/* ---------------------------------------------------------------------
 * 로그 저장소: claude.ai 아티팩트 공유 DB → 없으면 이 탭 메모리
 * ------------------------------------------------------------------- */
const Store = {
  db: null, lastError: null,
  mem: { logs: new Map(), rag_logs: new Map() },
  listeners: new Set(),
  docId: id => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180),
  emit(col) { for (const fn of this.listeners) try { fn(col); } catch (e) { console.error(e); } },
  async put(col, id, data) {
    this.mem[col].set(id, data); this.emit(col);
    if (!this.db) return { saved: 'memory' };
    try { await this.db.collection(col).doc(this.docId(id)).set(data); return { saved: 'db' }; }
    catch (e) { this.lastError = `${col}: ${e.code || e.message}`; this.emit('error'); return { saved: 'memory', error: e.code || e.message }; }
  },
  // 공유 DB 의 최근 문서를 구독해 메모리에 반영 (하네스 모니터링이 읽음)
  subscribe(col, order = 'tsNum', limit = 300) {
    this.db.collection(col).orderBy(order, 'desc').limit(limit).onSnapshot(snap => {
      for (const ch of snap.docChanges()) {
        const d = ch.doc.data(); if (!d) continue;
        const key = d.requestId || d.id || ch.doc.id;
        if (ch.type === 'removed') this.mem[col].delete(key); else this.mem[col].set(key, d);
      }
      this.emit(col);
    }, err => { this.lastError = `${col}: ${err?.code || err}`; this.emit('error'); });
  },
};

/* ---------------------------------------------------------------------
 * Semantic Layer: 빌드 때 만든 정의 목록(window.SEM.items)을 읽어 검색 인덱스를 만든다
 *  정의 원본은 data/semantic_layer.json · semantic_supplement.json · semantic_overrides.json
 * ------------------------------------------------------------------- */
const TYPE_BY_PREFIX = { metric: 'metric', dim: 'dimension', term: 'business_term' };
const TYPE_LABEL = { metric: 'Metric', dimension: 'Dimension', business_term: 'Business Term' };
// 지표가 의존하는 업무 용어를 함께 가져오기 위한 연결 (검색 시 의존 정의 확장)
const SEED_RELATED = {
  'metric.initial_no_watch_rate': ['term.step_initial_watch_fail', 'term.step_paid_d30'],
  'metric.activation_fail_rate': ['term.step_initial_watch_fail', 'term.step_paid_d30'],
  'metric.activation_rate': ['term.step_initial_watch', 'term.step_paid_d30'],
  'metric.pay_rate_d30': ['term.step_paid_d30'],
  'metric.retention_rate_dashboard': ['term.step_retained_d22_28'],
  'metric.campaign_response_rate': ['term.push_reachable'],
};

const Sem = {
  items: new Map(), version: '', retriever: null,
  init(seedItems) {
    for (const it of seedItems) { const x = clone(it); if (SEED_RELATED[x.id]) x.related = SEED_RELATED[x.id]; this.items.set(x.id, x); }
    this.version = shortHash(JSON.stringify([...this.items.values()]));
    this.retriever = createRetriever([...this.items.values()]);
  },
  all() { return [...this.items.values()]; },
  get(id) { return this.items.get(id); },
};

/* 정의 검증: 필수 필드 · 스키마 · 메타데이터 대조 · SQL 조각 컴파일 (테스트에서 모든 정의에 실행) */
function validateDefinition(it, { isNew } = {}) {
  const e = [];
  if (!it || typeof it !== 'object') return ['정의가 객체가 아닙니다.'];
  const m = /^(metric|dim|term)\.[a-z0-9_]{2,60}$/.exec(it.id || '');
  if (!m) e.push("id 는 'metric.이름' · 'dim.이름' · 'term.이름' 형식(영문 소문자·숫자·_)이어야 합니다.");
  else if (TYPE_BY_PREFIX[m[1]] !== it.type) e.push(`id 접두어(${m[1]})와 type(${it.type})이 맞지 않습니다. ${m[1]} → ${TYPE_BY_PREFIX[m[1]]}`);
  if (isNew && Sem.items.has(it.id)) e.push(`이미 있는 id 입니다: ${it.id}`);
  if (!['metric', 'dimension', 'business_term'].includes(it.type)) e.push('type 은 metric · dimension · business_term 중 하나여야 합니다.');
  if (!it.name || typeof it.name !== 'string' || it.name.trim().length < 2) e.push('name(이름)은 2자 이상 필수입니다.');
  if (!it.description || String(it.description).trim().length < 5) e.push('description(설명)은 5자 이상 필수입니다.');
  if (!Array.isArray(it.aliases) || it.aliases.some(a => typeof a !== 'string' || !a.trim())) e.push('aliases 는 비어 있지 않은 문자열 배열이어야 합니다.');
  if (!Array.isArray(it.tables) || !it.tables.length) e.push('tables(관련 테이블)를 1개 이상 지정해야 합니다.');
  else for (const t of it.tables) if (!META_TABLES.has(t)) e.push(`메타데이터에 없는 테이블: ${t}`);
  for (const c of it.columns || []) {
    const [t, col] = String(c).split('.');
    if (!META_TABLES.get(t)?.columns.some(x => x.name === col)) e.push(`메타데이터에 없는 컬럼: ${c} ('테이블.컬럼' 형식)`);
  }
  for (const r of it.related || []) if (!Sem.items.has(r) && r !== it.id) e.push(`related 에 없는 정의 id: ${r}`);
  const sql = it.sql || {};
  if (it.type === 'metric') {
    for (const f of ['formula', 'numerator', 'denominator', 'period', 'unit']) if (!it[f] || !String(it[f]).trim()) e.push(`Metric 은 ${f} 가 필수입니다.`);
    if (!sql.expression && !it.example_sql && !sql.status) e.push('Metric 은 sql.expression 또는 example_sql 이 필요합니다.');
  }
  if (it.type === 'dimension' && !sql.group_by && !it.example_sql) e.push('Dimension 은 sql.group_by(그룹 컬럼) 또는 example_sql 이 필요합니다.');
  if (it.type === 'business_term' && !sql.condition && !it.example_sql) e.push('Business Term 은 sql.condition(대상 조건) 또는 example_sql 이 필요합니다.');
  if (e.length) return e;
  // 데이터 검증: SQL 조각이 실제 DB 에서 컴파일되는지 (실행 없이 하네스 검증 모듈로)
  const base = it.tables.find(t => DB.loaded.has(t));
  const probes = [];
  if (sql.expression && base) probes.push(['sql.expression', `SELECT ${sql.expression} AS v FROM ${base}${sql.where ? ` WHERE ${sql.where}` : ''}`]);
  if (sql.condition && base) probes.push(['sql.condition', `SELECT COUNT(*) FROM ${base} WHERE ${sql.condition}`]);
  if (sql.group_by && base && /^[a-z_][a-z0-9_]*$/.test(sql.group_by)) probes.push(['sql.group_by', `SELECT ${sql.group_by}, COUNT(*) FROM ${base} GROUP BY ${sql.group_by}`]);
  if (it.example_sql) probes.push(['example_sql', it.example_sql]);
  for (const [field, q] of probes) {
    const v = validateSql(q);
    if (!v.ok) e.push(`${field} 검증 실패 [${v.errorType}] ${v.message}`);
  }
  return e;
}

/* ---------------------------------------------------------------------
 * RAG 검색: BM25(한글 2-gram + 영문 토큰) + 별칭 일치 가산점 → 순위·점수
 *  선택된 정의 → 의존 정의(related) · 테이블(+원천 계보) · JOIN · 필터 값(DB 확인)까지 확장
 * ------------------------------------------------------------------- */
function tokenize(text) {
  const out = [];
  for (const w of String(text || '').toLowerCase().split(/[^0-9a-z가-힣+]+/)) {
    if (!w) continue;
    if (/[가-힣]/.test(w)) { if (w.length === 1) out.push(w); for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2)); }
    else { out.push(w); for (const p of w.split('_')) if (p && p !== w) out.push(p); }
  }
  return out;
}

function createRetriever(items) {
  const docs = [];
  for (const it of items) {
    const aliases = it.aliases || [];
    docs.push({ id: it.id, kind: it.type, label: it.name, item: it, aliases: [it.name, ...aliases], text: [it.name, it.name, it.name, ...aliases, ...aliases, it.description, (it.tables || []).join(' '), (it.columns || []).join(' ')].join(' ') });
  }
  for (const t of META.tables) {
    docs.push({ id: `table.${t.name}`, kind: 'table', label: t.name, table: t.name, aliases: [t.name], text: [t.name, t.name, t.description].join(' ') });
    for (const c of t.columns) docs.push({ id: `column.${t.name}.${c.name}`, kind: 'column', label: `${t.name}.${c.name}`, table: t.name, aliases: [c.name], text: [c.name, c.name, c.description, colValues(c).join(' ')].join(' ') });
  }
  META.relationships.forEach((r, i) => docs.push({ id: `join.${i}`, kind: 'join', label: r.join, rel: r, aliases: [], text: [r.from, r.to, r.join, r.note || '', '조인 관계 연결 join'].join(' ') }));
  const tf = docs.map(d => { const m = new Map(); for (const t of tokenize(d.text)) m.set(t, (m.get(t) || 0) + 1); return m; });
  const len = tf.map(m => [...m.values()].reduce((a, b) => a + b, 0));
  const avg = len.reduce((a, b) => a + b, 0) / docs.length;
  const df = new Map(); for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length, k1 = 1.2, b = 0.75;
  function search(question) {
    const q = [...new Set(tokenize(question))]; const nqs = nq(question);
    return docs.map((d, i) => {
      let bm25 = 0; const hits = [];
      for (const t of q) { const f = tf[i].get(t); if (!f) continue; const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5)); bm25 += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len[i] / avg)); hits.push(t); }
      const aliasHits = d.aliases.filter(a => a && nq(a).length >= 2 && nqs.includes(nq(a)));
      const alias = aliasHits.reduce((s, a) => s + Math.min(3 + nq(a).length * 0.5, 8), 0);
      return { doc: d, score: +(bm25 + alias).toFixed(3), bm25: +bm25.toFixed(3), alias: +alias.toFixed(2), matched: aliasHits.length ? aliasHits : hits.slice(0, 6) };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
  }
  return { search, size: docs.length, docs };
}

const THRESH = { min: 2.5, rel: 0.3, maxSemantic: 6 };

function retrieve(question) {
  const t0 = performance.now();
  const ranked = Sem.retriever.search(question);
  const semRanked = ranked.filter(r => r.doc.item);
  const top = semRanked[0]?.score || 0;
  const cut = Math.max(THRESH.min, top * THRESH.rel);
  const chosen = semRanked.filter(r => r.score >= cut).slice(0, THRESH.maxSemantic);
  const chosenIds = new Set(chosen.map(r => r.doc.id));
  const reasons = new Map(chosen.map(r => [r.doc.id, `점수 ${r.score} ≥ 임계값 ${cut.toFixed(2)}`]));
  // 의존 정의 확장
  for (const r of [...chosen]) for (const rid of r.doc.item.related || []) {
    if (!chosenIds.has(rid) && Sem.items.has(rid)) { chosenIds.add(rid); reasons.set(rid, `${r.doc.item.name} 의 의존 정의`); chosen.push({ doc: { id: rid, item: Sem.items.get(rid), kind: Sem.items.get(rid).type, label: Sem.items.get(rid).name }, score: 0, bm25: 0, alias: 0, matched: [], expanded: true }); }
  }
  const semantic = chosen.map(r => r.doc.item);

  // 차원 필터 값: 질문의 세그먼트(예: 20대)를 DB 에 실제로 있는 코드로 확인
  const filters = resolveFilters(question, semantic);
  // 테이블: 정의가 쓰는 테이블 + 원천 계보 + 필터 확인 테이블 + 질문과 직접 맞는 테이블·컬럼
  const tables = new Map();
  const addT = (t, why) => { if (META_TABLES.has(t) && !tables.has(t)) tables.set(t, why); };
  for (const it of semantic) for (const t of it.tables || []) addT(t, `${it.name} 의 사용 테이블`);
  for (const it of semantic) for (const t of it.lineage_tables || []) addT(t, `${it.name} 의 원천 계보`);
  for (const f of filters) addT(f.table, `필터 값 확인 (${f.column})`);
  const colTop = ranked.filter(r => (r.doc.kind === 'column' || r.doc.kind === 'table') && r.score >= 4).slice(0, 6);
  for (const r of colTop) addT(r.doc.table, `질문과 직접 일치 (${r.doc.label})`);
  if (!tables.size && semantic.length) addT('user_journey', '기본 고객 여정 테이블');
  const T = new Set(tables.keys());
  const joins = META.relationships.filter(rel => { const a = rel.from.split('.')[0], b2 = rel.to.split('.')[0]; return T.has(a) && T.has(b2); });
  // user_dim 을 거치지 않는 원천끼리도 user_key 로 연결되도록, 고른 원천 ↔ user_dim 관계 보충
  if (T.size > 1 && !T.has('user_dim')) for (const rel of META.relationships) { const a = rel.from.split('.')[0]; if (T.has(a) && rel.to.startsWith('user_dim.') && !joins.includes(rel)) joins.push(rel); }

  const selectedDocIds = new Set([...chosenIds, ...[...T].map(t => `table.${t}`), ...colTop.map(r => r.doc.id), ...joins.map(j => `join.${META.relationships.indexOf(j)}`)]);
  const ranking = ranked.slice(0, 25).map((r, i) => ({ rank: i + 1, id: r.doc.id, kind: r.doc.kind, label: r.doc.label, score: r.score, bm25: r.bm25, alias: r.alias, matched: r.matched, selected: selectedDocIds.has(r.doc.id), reason: reasons.get(r.doc.id) || (selectedDocIds.has(r.doc.id) ? '의존 테이블·관계' : `임계값 ${cut.toFixed(2)} 미만 또는 상위 ${THRESH.maxSemantic}개 초과`) }));
  for (const r of chosen.filter(x => x.expanded)) ranking.push({ rank: null, id: r.doc.id, kind: r.doc.kind, label: r.doc.label, score: 0, bm25: 0, alias: 0, matched: [], selected: true, reason: reasons.get(r.doc.id) });

  let noResultReason = '';
  if (!semantic.length) {
    const toks = [...new Set(tokenize(question))].slice(0, 12).join(', ');
    noResultReason = top ? `가장 높은 정의 점수 ${top} 가 최소 임계값 ${THRESH.min} 미만입니다(질문 토큰: ${toks}). 해당 업무 용어가 Semantic Layer 에 정의되어 있지 않습니다.` : `질문 토큰(${toks})과 일치하는 Metric·Dimension·Business Term 이 없습니다.`;
  }
  const ctx = buildContext({ semantic, tables, joins, filters });
  return {
    question, at: new Date().toISOString(), ms: +(performance.now() - t0).toFixed(1), version: Sem.version, threshold: +cut.toFixed(2),
    semantic, semanticMeta: chosen.map(r => ({ id: r.doc.id, name: r.doc.item.name, type: r.doc.item.type, score: r.score, expanded: !!r.expanded, reason: reasons.get(r.doc.id) })),
    tables: [...tables].map(([name, why]) => ({ name, why, loaded: DB.loaded.has(name) })), joins, filters, ranking, noResultReason, context: ctx,
  };
}

// 세그먼트 값 확인: 정의의 condition_examples 와 '숫자+대' 패턴을 DB 의 실제 값과 대조 (하네스 검증·실행 모듈 사용)
function resolveFilters(question, semantic) {
  const out = []; const q = nq(question);
  for (const d of semantic.filter(s => s.type === 'dimension')) {
    const col = d.sql?.group_by; if (!col || !/^[a-z_][a-z0-9_]*$/.test(col)) continue;
    const master = META_TABLES.get('user_dim').columns.some(c => c.name === col) ? 'user_dim' : (d.tables || []).find(t => DB.loaded.has(t) && META_TABLES.get(t).columns.some(c => c.name === col));
    if (!master) continue;
    const wanted = [];
    for (const [k, cond] of Object.entries(d.sql?.condition_examples || {})) if (q.includes(nq(k))) { const m = /=\s*'([^']+)'/.exec(cond); if (m) wanted.push({ label: k, value: m[1], via: 'condition_examples' }); }
    if (col === 'age_band') for (const m of question.matchAll(/(\d)0\s*대/g)) if (!wanted.some(w => w.label.startsWith(m[1] + '0'))) wanted.push({ label: `${m[1]}0대`, prefix: `${m[1]}0_`, via: '질문 패턴(N0대)' });
    if (!wanted.length) continue;
    const r = guardedQuery(`SELECT ${col} AS value, COUNT(*) AS n FROM ${master} GROUP BY ${col} ORDER BY ${col}`);
    const values = r.ok ? r.rows.map(([v, n]) => ({ value: v, n })) : [];
    for (const w of wanted) {
      const hit = values.find(v => (w.value != null && String(v.value) === w.value) || (w.prefix && String(v.value).startsWith(w.prefix)));
      out.push({ dimension: d.id, label: w.label, table: master, column: col, value: hit ? hit.value : null, n: hit?.n ?? 0, verified: !!hit, via: w.via, all: values.map(v => v.value), condition: hit ? `${col} = '${hit.value}'` : null, query: `SELECT ${col}, COUNT(*) FROM ${master} GROUP BY ${col}` });
    }
  }
  return out;
}

function buildContext({ semantic, tables, joins, filters }) {
  const L = [];
  L.push('## 1. 시맨틱 정의 (이 질문과 관련된 것만 검색됨)');
  if (!semantic.length) L.push('(관련 정의 없음 — 임의의 계산식을 만들지 말고 cannot_answer 로 부족한 정의를 안내할 것)');
  for (const it of semantic) {
    L.push(`### [${TYPE_LABEL[it.type]}] ${it.name} (${it.id})`);
    L.push(`- 설명: ${it.description}`);
    if (it.formula && it.formula !== '-') L.push(`- 계산식: ${it.formula}`);
    if (it.numerator && it.numerator !== '-') L.push(`- 분자: ${it.numerator}`);
    if (it.denominator && it.denominator !== '-') L.push(`- 분모: ${it.denominator}`);
    if (it.period) L.push(`- 기간: ${it.period}`);
    if (it.filters?.length) L.push(`- 필터: ${it.filters.join(' AND ')}`);
    if (it.grain) L.push(`- 집계 단위: ${it.grain}${it.unit ? ` · 단위: ${it.unit}` : ''}`);
    // 계산식·조건·그룹 조각만 넘긴다. 완성된 SELECT 문(example_sql, raw_sql 등)은 넘기지 않음 — SQL 은 LLM 이 질문에 맞춰 직접 작성
    const frag = Object.fromEntries(Object.entries(it.sql || {}).filter(([, v]) => !(typeof v === 'string' && /\bSELECT\b/i.test(v))));
    if (Object.keys(frag).length) L.push(`- SQL 조각 (계산식·조건): ${JSON.stringify(frag)}`);
    if (it.null_handling && it.null_handling !== '-') L.push(`- NULL 처리: ${it.null_handling}`);
    if (it.cautions?.length) L.push(`- 주의: ${it.cautions.join(' / ')}`);
    if (it.lineage_tables?.length) L.push(`- 원천 계보 테이블: ${it.lineage_tables.join(', ')}`);
  }
  if (filters.length) {
    L.push('## 2. 세그먼트 필터 (DB 에서 실제 값 확인)');
    for (const f of filters) L.push(f.verified ? `- "${f.label}" → ${f.table}.${f.column} = '${f.value}' (DB 확인: ${f.n.toLocaleString()}명 · 실제 값 목록 ${f.all.join(', ')})` : `- "${f.label}" → ${f.table}.${f.column} 에 해당 값이 없음 (실제 값 ${f.all.join(', ')}) — 필터를 임의로 만들지 말 것`);
  }
  L.push('## 3. 테이블 · 컬럼 메타데이터 (선택된 테이블만)');
  for (const [name, why] of tables) {
    const t = META_TABLES.get(name);
    L.push(`### ${t.name} — ${t.description}`);
    L.push(`- 선택 이유: ${why} · 이 웹 DB 적재: ${DB.loaded.has(name) ? '예' : '아니오(사용 불가)'} · 행 수 ${Number(t.row_count).toLocaleString()} · PK (${(t.primary_key || []).join(', ')})${t.observation_window ? ` · 관측 기간 ${t.observation_window}` : ''}`);
    for (const c of t.columns) L.push(`  - ${c.name} ${c.type}: ${c.description}${c.values ? ` (값: ${colValues(c).join(', ')})` : ''}`);
  }
  L.push('## 4. JOIN 관계');
  if (!joins.length) L.push('- (단일 테이블 질의)');
  for (const j of joins) L.push(`- ${j.join} [${j.type}]${j.note ? ' — ' + j.note : ''}`);
  L.push('## 5. 공통 규칙');
  for (const r of META.rules || []) L.push(`- ${r}`);
  L.push(`- 날짜 규칙: ${typeof META.date_rules === 'string' ? META.date_rules : JSON.stringify(META.date_rules)}`);
  L.push('- 고객 수는 COUNT(DISTINCT user_key) 또는 고객 단위 테이블(user_journey) COUNT(*)');
  return L.join('\n');
}
