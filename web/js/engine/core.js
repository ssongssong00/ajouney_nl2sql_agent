'use strict';
/* =====================================================================
 * core.js — 공통 유틸 · 브라우저 SQLite(DB) · SQL Validation · SQL Execution
 * (문제 2-5 산출물 1·2: SQL Validation 모듈 / SQL Execution 모듈)
 * ===================================================================== */

const META = window.META;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = v => typeof v === 'number' ? v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : v;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nq = s => String(s || '').toLowerCase().replace(/\s+/g, '');
const clone = o => JSON.parse(JSON.stringify(o));
function shortHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); }
function newRequestId(prefix = 'REQ') {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}
const META_TABLES = new Map(META.tables.map(t => [t.name, t]));
// 컬럼 값 목록: 팀 메타데이터는 배열(['20_29', …]) 또는 코드 사전({'V': 'VOD', …}) 두 형태
const colValues = c => !c?.values ? [] : Array.isArray(c.values) ? c.values.map(String) : Object.entries(c.values).map(([k, v]) => `${k}=${v}`);

/* ---------------------------------------------------------------------
 * DB: 메타데이터 스키마대로 테이블을 만들고 데이터 적재 → 읽기 전용(query_only) 전환
 * ------------------------------------------------------------------- */
const DB = { db: null, ready: false, loaded: new Set(), loading: new Set(), root: new Map(), colsOf: new Map(), idxCols: new Map(), writes: 0, rowCount: {} };

function decodeColumn(c, n) {
  if (c.keys === 'seq') return i => window.KEYS[i];
  if (c.keys === 'idx') return i => window.KEYS[c.idx[i]];
  if (c.keys === 'cidx') return i => window.CKEYS[c.idx[i]];
  if (c.dict) return i => { const k = c.idx[i]; return k < 0 ? null : c.dict[k]; };
  if (c.raw) return i => c.raw[i];
  return i => c.v[i];
}

function loadTable(name, t) {
  const meta = META_TABLES.get(name);
  const cols = meta.columns.map(mc => ({ mc, src: t.cols.find(c => c.name === mc.name) }));
  const ddl = `CREATE TABLE ${name} (${cols.map(({ mc }) => `${mc.name} ${mc.type}`).join(', ')}${meta.primary_key?.length ? `, PRIMARY KEY (${meta.primary_key.join(', ')})` : ''})`;
  DB.db.run(ddl);
  const getters = cols.map(({ src }) => src ? decodeColumn(src, t.n) : () => null);
  const stmt = DB.db.prepare(`INSERT INTO ${name} VALUES (${cols.map(() => '?').join(',')})`);
  DB.db.run('BEGIN');
  const row = new Array(cols.length);
  for (let i = 0; i < t.n; i++) {
    for (let j = 0; j < getters.length; j++) row[j] = getters[j](i);
    stmt.run(row);
  }
  DB.db.run('COMMIT');
  stmt.free();
  DB.loaded.add(name); DB.rowCount[name] = t.n;
}

function refreshSchemaMaps() {
  DB.root.clear(); DB.colsOf.clear(); DB.idxCols.clear();
  const r = DB.db.exec("SELECT type, name, tbl_name, rootpage FROM sqlite_master WHERE rootpage > 0");
  for (const [type, name, tbl, root] of (r[0]?.values || [])) {
    DB.root.set(root, { type, name, table: tbl });
    if (type === 'table') DB.colsOf.set(name, DB.db.exec(`PRAGMA table_info(${name})`)[0].values.map(v => v[1]));
    else DB.idxCols.set(name, (DB.db.exec(`PRAGMA index_info(${name})`)[0]?.values || []).map(v => v[2]));
  }
  DB.root.set(1, { type: 'table', name: 'sqlite_master', table: 'sqlite_master' });
}

async function initDb(onProgress) {
  const SQL = await window.initSqlJs();
  DB.db = new SQL.Database();
  const order = ['user_dim', 'user_journey', 'payment_fact'];
  for (const name of order) {
    if (!window.TABLES[name]) continue;
    onProgress?.(`${name} 적재 중 (${window.TABLES[name].n.toLocaleString()}행)`);
    await sleep(15);
    loadTable(name, window.TABLES[name]);
  }
  DB.db.run('CREATE INDEX ix_payment_user ON payment_fact(user_key)');
  refreshSchemaMaps();
  // 데이터 변경 감시: 하네스 실행 중 INSERT/UPDATE/DELETE 가 한 번이라도 일어나면 잡아낸다
  DB.db.updateHook(() => { DB.writes++; });
  DB.db.run('PRAGMA query_only = ON');
  DB.ready = true;
}

// 시청 원천(24만 행) · 콘텐츠 3종(23만 행)은 화면이 뜬 뒤 파일별로 한 번에(동기) 적재 — 적재 중에는 다른 SQL 이 끼어들 수 없음
const EXTRA_FILES = [
  { src: 'data/data-watch.js', tables: ['watch_daily_fact'], index: ['CREATE INDEX ix_watch_user ON watch_daily_fact(user_key, relative_signup_day)'] },
  { src: 'data/data-content.js', tables: ['content_dim', 'content_genre_bridge', 'user_content_summary'], index: ['CREATE INDEX ix_bridge_content ON content_genre_bridge(content_key)', 'CREATE INDEX ix_ucs_content ON user_content_summary(content_key)'] },
];
function loadExtraTables(onDone, onProgress) {
  for (const f of EXTRA_FILES) for (const t of f.tables) DB.loading.add(t);
  const next = k => {
    if (k >= EXTRA_FILES.length) { window.CKEYS = null; onDone?.(); return; }
    const f = EXTRA_FILES[k];
    onProgress?.(f.tables);
    const s = document.createElement('script');
    s.src = f.src;
    s.onload = () => setTimeout(() => {
      try {
        DB.db.updateHook(null);
        DB.db.run('PRAGMA query_only = OFF');
        for (const [name, t] of Object.entries(window.TABLES_EXTRA || {})) loadTable(name, t);
        for (const q of f.index) DB.db.run(q);
        refreshSchemaMaps();
      } catch (e) { console.error(e); }
      finally {
        DB.db.run('PRAGMA query_only = ON');
        DB.db.updateHook(() => { DB.writes++; });
        for (const t of f.tables) DB.loading.delete(t);
        window.TABLES_EXTRA = null;
        next(k + 1);
      }
    }, 50);
    s.onerror = () => { for (const t of f.tables) DB.loading.delete(t); next(k + 1); };
    document.head.append(s);
  };
  next(0);
}

function queryOnlyOn() { try { return DB.db.exec('PRAGMA query_only')[0].values[0][0] === 1; } catch { return false; } }

/* ---------------------------------------------------------------------
 * SQL 토크나이저 (문자열·주석·따옴표 식별자를 정확히 분리)
 * ------------------------------------------------------------------- */
function lex(sql) {
  const toks = []; let i = 0; const n = sql.length; let error = null;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); i = j < 0 ? n : j + 1; toks.push({ t: 'comment', i }); continue; }
    if (c === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); if (j < 0) { error = '닫히지 않은 주석'; break; } i = j + 2; toks.push({ t: 'comment', i }); continue; }
    if (c === "'") {
      let j = i + 1, s = '';
      for (;;) { if (j >= n) { error = '닫히지 않은 문자열'; break; } if (sql[j] === "'") { if (sql[j + 1] === "'") { s += "'"; j += 2; continue; } break; } s += sql[j++]; }
      if (error) break; toks.push({ t: 'str', v: s, i }); i = j + 1; continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c; const j = sql.indexOf(close, i + 1);
      if (j < 0) { error = '닫히지 않은 식별자 따옴표'; break; }
      const v = sql.slice(i + 1, j); toks.push({ t: 'word', v, u: v.toUpperCase(), quoted: true, i }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      const m = /^(?:0x[0-9a-f]+|\d*\.?\d+(?:e[+-]?\d+)?)/i.exec(sql.slice(i)); toks.push({ t: 'num', v: m[0], i }); i += m[0].length; continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(sql.slice(i)); toks.push({ t: 'word', v: m[0], u: m[0].toUpperCase(), i }); i += m[0].length; continue;
    }
    if ('?:@$'.includes(c) && /[A-Za-z0-9_]/.test(sql[i + 1] || '') || c === '?') { toks.push({ t: 'param', v: c, i }); i++; continue; }
    const two = sql.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '==', '||', '::', '<<', '>>', '->'].includes(two)) { toks.push({ t: 'op', v: two, i }); i += 2; continue; }
    toks.push({ t: c === ';' ? 'semi' : c === '(' ? 'lp' : c === ')' ? 'rp' : c === ',' ? 'comma' : c === '.' ? 'dot' : 'op', v: c, i }); i++;
  }
  return { toks: toks.filter(t => t.t !== 'comment'), error, hasComment: toks.some(t => t.t === 'comment') };
}

/* ---------------------------------------------------------------------
 * 오류 분류 (DB 오류 메시지 → 8가지 유형)
 * ------------------------------------------------------------------- */
const ERROR_TYPES = {
  'Syntax Error': 'SQL 문법이 맞지 않습니다.',
  'Table Not Found': '존재하지 않거나 사용할 수 없는 테이블을 참조했습니다.',
  'Column Not Found': '테이블에 없는 컬럼을 참조했습니다.',
  'Type Mismatch': '컬럼 타입과 비교 값의 타입이 맞지 않습니다.',
  'Invalid Function': 'SQLite 에 없는 함수이거나 함수 사용법이 잘못되었습니다.',
  'JOIN Error': 'JOIN 조건이 없거나 모호합니다.',
  'Query Timeout': '실행 시간 제한을 넘었습니다.',
  'Permission Error': '읽기 전용 정책 또는 접근 권한을 위반했습니다.',
};
function classifyDbError(msg) {
  const m = String(msg || '');
  if (/no such table/i.test(m)) return 'Table Not Found';
  if (/no such column/i.test(m)) return 'Column Not Found';
  if (/no such function|wrong number of arguments|misuse of (aggregate|window)|not authorized to use function|unknown function/i.test(m)) return 'Invalid Function';
  if (/ambiguous column|JOIN clause is required|cannot join using column/i.test(m)) return 'JOIN Error';
  if (/datatype mismatch|type mismatch/i.test(m)) return 'Type Mismatch';
  if (/interrupt|timeout|time limit/i.test(m)) return 'Query Timeout';
  if (/readonly|read-only|attempt to write|not authorized|access denied|query_only|permission/i.test(m)) return 'Permission Error';
  if (/syntax error|incomplete input|unrecognized token|near "|unterminated/i.test(m)) return 'Syntax Error';
  return 'Syntax Error';
}

/* ---------------------------------------------------------------------
 * SQL Validation 모듈
 *  ① 토큰 단위(파서) 정적 검사 → ② SQLite 실제 파서로 컴파일 → ③ 실행 계획(바이트코드) 검사
 *  CTE · 서브쿼리 · 함수 호출까지 실행 계획 단계에서 모두 드러남
 * ------------------------------------------------------------------- */
const POLICY = { maxRows: 5000, timeoutMs: 8000, maxRepairs: 2 };
const FORBIDDEN_KW = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'MERGE', 'UPSERT', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE', 'GRANT', 'REVOKE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'COPY', 'LOAD', 'INTO', 'OUTFILE', 'DUMPFILE', 'EXEC', 'EXECUTE', 'CALL'];
const FORBIDDEN_FN = ['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer', 'sqlite_compileoption_get', 'zipfile', 'sqlar_compress', 'sqlar_uncompress', 'shell', 'system'];
const WRITE_OPCODES = new Set(['OpenWrite', 'Insert', 'Delete', 'IdxInsert', 'IdxDelete', 'Destroy', 'Clear', 'CreateBtree', 'ParseSchema', 'DropTable', 'DropIndex', 'DropTrigger', 'VUpdate', 'VCreate', 'VDestroy', 'Vacuum', 'JournalMode', 'Expire', 'TableLock', 'SetCookie', 'IntegrityCk', 'LoadAnalysis', 'ResetSorter_x']);
// 괄호 앞에 와도 함수가 아닌 SQL 키워드 (호출 함수 목록 표시에서 제외)
const SQL_WORDS = new Set(['in', 'exists', 'over', 'as', 'where', 'and', 'or', 'not', 'on', 'from', 'join', 'select', 'when', 'then', 'else', 'case', 'values', 'using', 'having', 'by']);
const NON_SQLITE = [['ILIKE', 'ILIKE 대신 LIKE (SQLite LIKE 는 대소문자 무시)'], ['DATE_TRUNC', "date_trunc 대신 strftime('%Y-%m', 날짜)"], ['QUALIFY', 'QUALIFY 는 SQLite 미지원 — 서브쿼리로'], ['INTERVAL', "INTERVAL 대신 date(x, '+N day')"], ['TOP', 'TOP n 대신 LIMIT n'], ['NVL', 'NVL 대신 COALESCE'], ['ISNULL', 'ISNULL 대신 COALESCE'], ['GETDATE', "GETDATE 대신 date('now')"]];

function allowedTables() { return new Set([...DB.loaded].filter(t => META_TABLES.has(t))); }

function validateSql(sql) {
  const t0 = performance.now();
  const checks = [];
  let tablesUsed = [], columnsUsed = [];
  const add = (key, name, ok, detail = '') => { checks.push({ key, name, ok, detail }); return ok; };
  const done = (verdict, errorType, message, extra = {}) => ({ ok: verdict === 'pass', verdict, errorType: errorType || null, message: message || '', checks, tablesUsed, columnsUsed, ms: +(performance.now() - t0).toFixed(1), ...extra });
  const raw = String(sql || '').trim();
  if (!add('exists', 'SQL 존재', raw.length > 0, raw ? `${raw.length}자` : 'SQL 이 비어 있음')) return done('fail', 'Syntax Error', 'SQL 이 비어 있습니다.');

  // ① 토큰 단위 정적 검사
  const { toks, error: lexErr } = lex(raw);
  if (!add('lex', 'SQL 토큰 분석', !lexErr, lexErr || `${toks.length}개 토큰`)) return done('fail', 'Syntax Error', lexErr);
  const semis = toks.map((t, k) => t.t === 'semi' ? k : -1).filter(k => k >= 0);
  const multi = semis.some(k => k < toks.length - 1);
  if (!add('single', '단일 문장', !multi, multi ? '세미콜론 뒤에 다른 문장이 이어짐' : '문장 1개')) return done('blocked', 'Permission Error', '여러 SQL 문장을 한 번에 실행할 수 없습니다(다중 Statement 차단).');
  const body = toks.filter(t => t.t !== 'semi');
  const first = body[0]?.t === 'word' ? body[0].u : body[0]?.v;
  if (!add('select', '조회 전용 (SELECT/WITH)', first === 'SELECT' || first === 'WITH', `첫 키워드: ${first || '없음'}`)) return done('blocked', 'Permission Error', `조회(SELECT/WITH)만 허용됩니다. 받은 명령: ${first}`);
  const words = body.filter(t => t.t === 'word' && !t.quoted);
  const badKw = [...new Set(words.filter(t => FORBIDDEN_KW.includes(t.u)).map(t => t.u))];
  // REPLACE 는 문자열 함수로도 쓰이므로 'REPLACE INTO' · 'OR REPLACE' 만 차단
  words.forEach((t, k) => { if (t.u === 'REPLACE' && (words[k - 1]?.u === 'OR' || words[k + 1]?.u === 'INTO')) badKw.push('REPLACE'); });
  if (!add('keywords', '위험 명령 (데이터 변경·스키마·연결)', !badKw.length, badKw.length ? `발견: ${badKw.join(', ')}` : '없음')) return done('blocked', 'Permission Error', `데이터 변경·삭제·스키마 변경 등 위험 명령이 포함되어 실행 전 차단했습니다: ${badKw.join(', ')}`);
  const fnCalls = body.map((t, k) => t.t === 'word' && body[k + 1]?.t === 'lp' ? t.v.toLowerCase() : null).filter(Boolean);
  const badFn = [...new Set(fnCalls.filter(f => FORBIDDEN_FN.includes(f)))];
  if (!add('functions', '파일·확장 기능 함수', !badFn.length, badFn.length ? `발견: ${badFn.join(', ')}` : `호출 함수: ${[...new Set(fnCalls)].filter(f => !SQL_WORDS.has(f)).join(', ') || '없음'}`)) return done('blocked', 'Permission Error', `외부 파일 접근·확장 로드 함수는 허용되지 않습니다: ${badFn.join(', ')}`);
  if (body.some(t => t.t === 'param')) { add('params', '바인딩 파라미터', false, '? / :name 파라미터 사용'); return done('fail', 'Syntax Error', '값을 바인딩 파라미터(?, :name) 대신 리터럴로 작성해야 합니다.'); }
  const dialect = NON_SQLITE.filter(([kw]) => words.some(w => w.u === kw)).concat(body.some(t => t.v === '::') ? [['::', ':: 형 변환 대신 CAST(x AS 타입)']] : []);
  if (!add('dialect', 'SQLite 방언 호환', !dialect.length, dialect.length ? dialect.map(d => d[1]).join(' · ') : 'SQLite 3 문법')) return done('fail', 'Syntax Error', `현재 DB(SQLite)에서 지원하지 않는 구문: ${dialect.map(d => d[0]).join(', ')}`, { hint: dialect.map(d => d[1]) });

  // 메타데이터 기준 테이블 존재 여부 (FROM/JOIN 뒤 이름 · CTE 이름 제외)
  const cte = new Set();
  body.forEach((t, k) => { if (t.t === 'word' && body[k + 1]?.u === 'AS' && body[k + 2]?.t === 'lp' && (body[k - 1]?.u === 'WITH' || body[k - 1]?.t === 'comma' || body[k - 1]?.u === 'RECURSIVE')) cte.add(t.v.toLowerCase()); });
  const refs = [];
  body.forEach((t, k) => {
    if (t.t === 'word' && (t.u === 'FROM' || t.u === 'JOIN')) {
      let j = k + 1;
      for (;;) {
        const w = body[j]; if (!w || w.t !== 'word') break;
        let name = w.v.toLowerCase(); if (body[j + 1]?.t === 'dot' && body[j + 2]?.t === 'word') { name = name + '.' + body[j + 2].v.toLowerCase(); j += 2; }
        refs.push(name);
        // FROM a x, b y  형태 이어서 읽기
        let q = j + 1; if (body[q]?.u === 'AS') q++; if (body[q]?.t === 'word' && !['WHERE', 'JOIN', 'LEFT', 'INNER', 'CROSS', 'ON', 'GROUP', 'ORDER', 'LIMIT', 'USING', 'UNION', 'NATURAL', 'HAVING', 'WINDOW', 'FULL', 'RIGHT', 'OUTER'].includes(body[q].u)) q++;
        if (t.u === 'FROM' && body[q]?.t === 'comma') { j = q + 1; continue; }
        break;
      }
    }
  });
  const unknown = [...new Set(refs.filter(r => !cte.has(r) && !allowedTables().has(r)))];
  if (unknown.length) {
    const sys = unknown.filter(u => u.startsWith('sqlite_') || u.includes('.') || ['main', 'temp'].includes(u));
    if (sys.length) { add('tables', '허용 테이블·스키마', false, `시스템/외부 스키마 접근: ${sys.join(', ')}`); return done('blocked', 'Permission Error', `허용되지 않은 시스템 테이블·스키마 접근을 차단했습니다: ${sys.join(', ')}`); }
    const notLoaded = unknown.filter(u => META_TABLES.has(u));
    const detail = unknown.map(u => META_TABLES.has(u) ? `${u}(메타데이터에는 있으나 ${DB.loading.has(u) ? '적재 중' : '이 웹 DB에 미적재'})` : `${u}(메타데이터에 없음)`).join(', ');
    add('tables', '테이블 존재 (메타데이터)', false, detail);
    return done('fail', 'Table Not Found', `존재하지 않거나 사용할 수 없는 테이블: ${detail}. 사용 가능: ${[...allowedTables()].join(', ')}`, { notLoaded });
  }
  add('tables', '테이블 존재 (메타데이터)', true, `참조: ${[...new Set(refs.filter(r => !cte.has(r)))].join(', ') || '-'}${cte.size ? ` · CTE: ${[...cte].join(', ')}` : ''}`);

  // ② SQLite 실제 파서로 컴파일 (실행 안 함)
  let stmt;
  try { stmt = DB.db.prepare(raw.replace(/;\s*$/, '')); }
  catch (e) {
    const type = classifyDbError(e.message);
    add('compile', 'SQLite 파서 컴파일', false, e.message);
    if (type === 'Permission Error') return done('blocked', type, e.message);
    return done('fail', type, e.message, { dbError: e.message });
  }
  const outCols = stmt.getColumnNames(); stmt.free();
  add('compile', 'SQLite 파서 컴파일', true, `결과 컬럼 ${outCols.length}개: ${outCols.slice(0, 8).join(', ')}${outCols.length > 8 ? ' …' : ''}`);

  // ③ 실행 계획(바이트코드) 검사: 쓰기 opcode · 실제로 읽는 테이블/컬럼 · 호출 함수
  let plan;
  try { plan = DB.db.exec('EXPLAIN ' + raw.replace(/;\s*$/, ''))[0]; } catch (e) { add('plan', '실행 계획 검사', false, e.message); return done('fail', classifyDbError(e.message), e.message); }
  const cols = plan.columns; const rows = plan.values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
  // DISTINCT · GROUP BY · IN (서브쿼리) 는 SQLite 가 실행 중 만드는 임시 B-tree(OpenEphemeral 등)에 IdxInsert 를 쓴다 — 실제 테이블 쓰기가 아니므로 제외
  const scratch = new Set(rows.filter(r => ['OpenEphemeral', 'OpenAutoindex', 'OpenDup', 'SorterOpen', 'OpenPseudo'].includes(r.opcode)).map(r => r.p1));
  const writeOps = [...new Set(rows.filter(r => WRITE_OPCODES.has(r.opcode) && !(['Insert', 'IdxInsert', 'Delete', 'IdxDelete'].includes(r.opcode) && scratch.has(r.p1))).map(r => r.opcode))];
  const cursors = new Map(); const readTables = new Set(); const otherDb = [];
  for (const r of rows) {
    if (r.opcode === 'OpenRead' || r.opcode === 'ReopenIdx') {
      if (r.p3 !== 0) otherDb.push(r.p3);
      const o = DB.root.get(r.p2); if (o) { cursors.set(r.p1, o); readTables.add(o.table); }
    }
  }
  for (const r of rows) {
    if (r.opcode === 'Column') {
      const o = cursors.get(r.p1); if (!o) continue;
      const name = o.type === 'table' ? DB.colsOf.get(o.name)?.[r.p2] : DB.idxCols.get(o.name)?.[r.p2];
      if (name) columnsUsed.push(`${o.table}.${name}`);
    }
  }
  columnsUsed = [...new Set(columnsUsed)];
  const fnInPlan = [...new Set(rows.filter(r => /Function|AggStep|AggFinal|PureFunc/.test(r.opcode) && r.p4).map(r => String(r.p4).replace(/\(.*$/, '').toLowerCase()))];
  const badPlanFn = fnInPlan.filter(f => FORBIDDEN_FN.includes(f));
  const illegal = [...readTables].filter(t => !allowedTables().has(t));
  tablesUsed = [...readTables];
  const planOk = !writeOps.length && !otherDb.length && !illegal.length && !badPlanFn.length;
  add('plan', '실행 계획(바이트코드) 검사', planOk, planOk ? `쓰기 연산 없음 · 읽는 테이블: ${tablesUsed.join(', ') || '(상수)'}${fnInPlan.length ? ' · 함수: ' + fnInPlan.join(', ') : ''}` : `쓰기 연산: ${writeOps.join(', ') || '-'} / 비허용 테이블: ${illegal.join(', ') || '-'} / 외부 DB: ${otherDb.length} / 위험 함수: ${badPlanFn.join(', ') || '-'}`);
  if (!planOk) return done('blocked', 'Permission Error', '실행 계획에서 데이터 변경 또는 비허용 객체 접근이 확인되어 차단했습니다.');

  // 컬럼 존재 (메타데이터 대조)
  const metaMiss = columnsUsed.filter(tc => { const [t, c] = tc.split('.'); const mt = META_TABLES.get(t); return mt && !mt.columns.some(x => x.name === c); });
  if (!add('columns', '컬럼 존재 (메타데이터)', !metaMiss.length, metaMiss.length ? `메타데이터에 없는 컬럼: ${metaMiss.join(', ')}` : `사용 컬럼 ${columnsUsed.length}개: ${columnsUsed.slice(0, 10).join(', ')}${columnsUsed.length > 10 ? ' …' : ''}`)) return done('fail', 'Column Not Found', `메타데이터에 정의되지 않은 컬럼: ${metaMiss.join(', ')}`);

  // JOIN 조건: 두 개 이상 테이블을 읽으면 메타데이터 관계 키(user_key 등)로 연결되어야 함
  const baseTables = tablesUsed.filter(t => META_TABLES.has(t));
  if (baseTables.length > 1) {
    const keys = new Set(META.relationships.flatMap(r => [r.from.split('.')[1], r.to.split('.')[1]]));
    let joined = 0;
    body.forEach((t, k) => {
      if (t.u === 'USING' && body[k + 1]?.t === 'lp' && keys.has(String(body[k + 2]?.v).toLowerCase())) joined++;
      // 세미 조인: user_key IN (SELECT user_key FROM …)
      if (t.u === 'IN' && keys.has(String(body[k - 1]?.v).toLowerCase()) && body[k + 1]?.t === 'lp' && body[k + 2]?.u === 'SELECT') joined++;
      if ((t.v === '=' || t.v === '==') && keys.has(String(body[k - 1]?.v).toLowerCase()) && keys.has(String(body[k + 3]?.v || body[k + 1]?.v).toLowerCase())) joined++;
    });
    if (!add('join', 'JOIN 조건 (메타데이터 관계)', joined > 0, joined ? `관계 키 조건 ${joined}개 · 테이블 ${baseTables.join(' ⋈ ')}` : `${baseTables.join(', ')} 를 연결하는 키 조건 없음(카티전 곱 위험)`)) return done('fail', 'JOIN Error', `${baseTables.join(', ')} 를 메타데이터 관계 키(user_key 등)로 연결하는 조건이 없습니다.`);
  } else add('join', 'JOIN 조건 (메타데이터 관계)', true, '단일 테이블');

  // 타입 일치: TEXT 코드 컬럼에 숫자 비교, 숫자 컬럼에 문자 비교
  const typeOf = new Map();
  for (const t of baseTables) for (const c of META_TABLES.get(t).columns) if (!typeOf.has(c.name)) typeOf.set(c.name, c.type);
  const mism = [];
  body.forEach((t, k) => {
    if (!['=', '==', '!=', '<>'].includes(t.v)) return;
    const L = body[k - 1], R = body[k + 1];
    for (const [col, lit] of [[L, R], [R, L]]) {
      if (col?.t !== 'word' || !typeOf.has(col.v.toLowerCase()) || !lit) continue;
      const ty = typeOf.get(col.v.toLowerCase());
      if (ty === 'TEXT' && lit.t === 'num') mism.push(`${col.v}(TEXT) ${t.v} ${lit.v}`);
      if ((ty === 'INTEGER' || ty === 'REAL') && lit.t === 'str' && !/^-?\d+(\.\d+)?$/.test(lit.v)) mism.push(`${col.v}(${ty}) ${t.v} '${lit.v}'`);
    }
  });
  if (!add('types', '타입 일치', !mism.length, mism.length ? mism.join(' · ') : '비교 타입 정상')) return done('fail', 'Type Mismatch', `컬럼 타입과 맞지 않는 비교: ${mism.join(', ')}`);

  return done('pass', null, '', { outCols, sql: raw.replace(/;\s*$/, '') });
}

/* ---------------------------------------------------------------------
 * SQL Execution 모듈 — 읽기 전용 연결 · 행 수 제한 · 시간 제한 · 변경 감시
 * ------------------------------------------------------------------- */
function executeSql(sql, { maxRows = POLICY.maxRows, timeoutMs = POLICY.timeoutMs } = {}) {
  const t0 = performance.now();
  if (!queryOnlyOn()) return { ok: false, errorType: 'Permission Error', message: '읽기 전용 연결이 아니어서 실행하지 않았습니다.', ms: 0 };
  const w0 = DB.writes;
  let stmt;
  try { stmt = DB.db.prepare(sql); } catch (e) { return { ok: false, errorType: classifyDbError(e.message), message: e.message, ms: +(performance.now() - t0).toFixed(1) }; }
  const columns = stmt.getColumnNames(); const rows = []; let truncated = false;
  try {
    while (stmt.step()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(stmt.get());
      if ((rows.length & 255) === 0 && performance.now() - t0 > timeoutMs) throw new Error(`time limit ${timeoutMs}ms exceeded`);
    }
  } catch (e) { stmt.free(); return { ok: false, errorType: classifyDbError(e.message), message: e.message, ms: +(performance.now() - t0).toFixed(1) }; }
  stmt.free();
  const ms = +(performance.now() - t0).toFixed(1);
  if (DB.writes !== w0) return { ok: false, errorType: 'Permission Error', message: '실행 중 데이터 변경이 감지되었습니다.', ms };
  if (ms > timeoutMs) return { ok: false, errorType: 'Query Timeout', message: `실행 시간 ${Math.round(ms)}ms 가 제한 ${timeoutMs}ms 를 넘었습니다.`, ms };
  return { ok: true, columns, rows, rowCount: rows.length, truncated, ms, readOnly: true };
}

// 시스템 조회(예: 연령대 실제 코드 확인)도 같은 검증·실행 모듈을 거친다 — 우회 경로 없음
function guardedQuery(sql) {
  const v = validateSql(sql);
  if (!v.ok) return { ok: false, validation: v };
  const r = executeSql(v.sql);
  return { ...r, validation: v };
}
