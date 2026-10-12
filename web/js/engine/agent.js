'use strict';
/* =====================================================================
 * agent.js — 문제 2-4 NL2SQL Agent + 문제 2-5 Harness Orchestrator · LLM SQL Repair · 로그
 * ===================================================================== */

/* ---------------------------------------------------------------------
 * LLM: claude.ai 의 Claude(sample capability). 없거나 거절되면 템플릿 모드로 대체
 * ------------------------------------------------------------------- */
const LLM = {
  fn: null, denied: false, lastError: null,
  available() { return !!this.fn && !this.denied; },
  label() { return this.available() ? 'Claude (claude.ai)' : '템플릿 (LLM 미사용)'; },
  async json(prompt, tier = 'default') {
    try { return await this.fn.json(prompt, { modelTier: tier }); }
    catch (e) {
      this.lastError = e?.code || String(e);
      if (['not_granted', 'sampling_disabled', 'capability_disabled', 'capability_removed', 'not_declared'].includes(e?.code)) this.denied = true;
      throw e;
    }
  },
};

const SQL_RULES = `# 규칙
1. [검색된 Context] 의 시맨틱 정의(계산식·분자·분모·기간·필터)를 그대로 따른다. 비즈니스 정의를 바꾸거나 새 계산식을 지어내지 않는다.
2. SQLite 3 문법의 SELECT 문(또는 WITH ... SELECT) 하나만 쓴다. 세미콜론·주석·바인딩 파라미터 금지.
3. Context 에 나온 테이블·컬럼만 사용한다. '이 웹 DB 적재: 아니오' 테이블은 사용할 수 없다. 컬럼을 지어내지 않는다.
4. 고객 수는 COUNT(DISTINCT user_key) 또는 user_journey 의 COUNT(*) 로 센다.
5. 비율은 ROUND(100.0 * 분자 / NULLIF(분모, 0), 1) AS <지표>_pct 로, 분자·분모 값도 함께 SELECT 한다.
6. 세그먼트 필터는 '세그먼트 필터 (DB 에서 실제 값 확인)' 의 값만 쓴다. 확인되지 않은 코드는 쓰지 않는다.
7. 그룹 비교는 GROUP BY 로 하고 결과는 50행 이하로 한다.
8. 정의가 없거나, 필요한 데이터가 없거나(예: 캠페인 발송 로그), 데이터 변경 요청이면 cannot_answer=true 로 하고 reason 에 이유와 필요한 데이터를 쓴다. 이때 sql 은 "".`;

function sqlPrompt(question, rag) {
  return `너는 OTT 서비스 'AJOU사' 고객 여정 데이터의 NL2SQL 에이전트다. 질문을 SQLite SQL 로 바꾼다.
${SQL_RULES}

# 출력 — JSON 객체 하나만
{"cannot_answer": false, "reason": "", "question_type": "kpi|comparison|trend|list", "sql": "SELECT ...",
 "analysis_basis": {"definitions_used": ["metric.xxx"], "metric": "지표명", "formula": "", "numerator": "", "denominator": "", "filters": [""], "period": "", "grain": "고객", "unit": "%|명", "assumptions": [""]},
 "chart": {"type": "kpi|bar|line|table", "x": "그룹 컬럼", "y": ["값 컬럼"], "title": ""}}

# 검색된 Context
${rag.context}

# 질문
${question}`;
}

function repairPrompt({ question, rag, sql, err, checks, basis, history }) {
  const avail = [...DB.loaded].map(t => `- ${t}(${META_TABLES.get(t).columns.map(c => `${c.name} ${c.type}`).join(', ')})`).join('\n');
  return `너는 SQL 오류 수정기다. 아래 SQL 이 하네스 검증 또는 DB 실행에서 실패했다. 비즈니스 지표 정의는 바꾸지 말고 SQL 오류만 고쳐라.
- 사용 가능한 실제 테이블·컬럼(아래 목록) 밖의 이름을 만들지 않는다.
- 데이터 변경·삭제 등 위험 SQL 로 바꾸지 않는다. SELECT 하나만.
- 고칠 수 없으면 {"sql": "", "reason": "고칠 수 없는 이유"} 로 답한다.

# 원래 질문
${question}

# 오류
- 유형: ${err.errorType}
- 메시지: ${err.message}
${(checks || []).filter(c => !c.ok).map(c => `- 실패한 검증: ${c.name} — ${c.detail}`).join('\n')}

# 실패한 SQL
${sql}
${history.length > 1 ? `\n# 이전에 시도했다가 실패한 SQL (반복 금지)\n${history.slice(0, -1).map(h => '- ' + h).join('\n')}\n` : ''}
# 변경하면 안 되는 비즈니스 기준
${basis ? JSON.stringify({ metric: basis.metric, formula: basis.formula, numerator: basis.numerator, denominator: basis.denominator, filters: basis.filters, period: basis.period }) : '(질문에 대응하는 지표 정의 없음 — 질문 의도를 유지하는 가장 단순한 조회로 수정)'}

# 사용 가능한 실제 테이블 · 컬럼 (SQLite)
${avail}

# 검색된 Context (요약)
${rag.context.slice(0, 6000)}

# 출력 — JSON 객체 하나만
{"sql": "수정한 SELECT 문", "reason": "무엇이 왜 틀렸고 어떻게 고쳤는지 한두 문장", "changes": ["바꾼 점"]}`;
}

function explainPrompt(question, basis, result) {
  const head = result.rows.slice(0, 30).map(r => Object.fromEntries(result.columns.map((c, i) => [c, r[i]])));
  return `OTT 'AJOU사' 마케팅 담당자에게 SQL 결과를 한국어로 설명한다. 결과 표에 없는 숫자는 만들지 않는다. 비율은 % 로, 고객 수는 '명' 으로.
# 질문
${question}
# 적용 기준
${JSON.stringify(basis)}
# 결과 (${result.rowCount}행${result.truncated ? ', 일부' : ''})
${JSON.stringify(head)}
# 출력 — JSON 객체 하나만
{"summary": "핵심 답 1~2문장(숫자 포함)", "insights": ["해석 최대 3개"], "cautions": ["해석 시 주의 최대 2개"], "next_actions": ["다음 행동 최대 2개"]}`;
}

/* ---------------------------------------------------------------------
 * 템플릿 모드: LLM 없이 검색된 시맨틱 정의의 SQL 조각을 규칙으로 조합 (오프라인 예비 경로)
 * ------------------------------------------------------------------- */
const DESTRUCTIVE = /(삭제|지워|지우|제거해|없애|drop\b|delete\b|truncate|update\b|insert\b|변경해|바꿔줘|덮어써|초기화해)/i;
const ident = s => /^[a-z_][a-z0-9_]*$/.test(s || '');
const basisOf = (it, extra = {}) => ({
  definitions_used: [it.id], metric: it.name, formula: it.formula || '', numerator: it.numerator || '', denominator: it.denominator || '',
  dimensions: [], filters: [...(it.filters || [])], period: it.period || '', grain: it.grain || '고객', unit: it.unit || '',
  cautions: [...(it.cautions || [])].slice(0, 3), assumptions: [], ...extra,
});

const Template = {
  generate(question, rag) {
    const q = nq(question);
    const UJ = new Set(META_TABLES.get('user_journey').columns.map(c => c.name));
    const semantic = rag.semantic.filter(s => !rag.semanticMeta.find(m => m.id === s.id)?.expanded);
    const measures = semantic.filter(s => s.type !== 'dimension');
    const dims = semantic.filter(s => s.type === 'dimension');
    if (!measures.length && !dims.length) return { cannot_answer: true, reason: '질문에 해당하는 지표·용어 정의가 Semantic Layer 에 없습니다.' };
    const m = measures[0];
    const where = rag.filters.filter(f => f.verified).map(f => f.condition);
    const groups = [];
    for (const d of dims) {
      const g = d.sql?.group_by;
      if (!ident(g) || !UJ.has(g) || rag.filters.some(f => f.dimension === d.id)) continue;
      if ([d.name, ...(d.aliases || [])].some(a => q.includes(nq(a) + '별')) || (/(별|비교|나눠|분포)/.test(question) && [d.name, ...(d.aliases || [])].some(a => q.includes(nq(a))))) groups.push({ col: g, d });
    }
    const group = groups[0];
    // 미리 저장된 완성 쿼리(example_sql)는 쓰지 않는다 — 정의의 계산식·조건·그룹 조각만으로 SELECT 를 조립
    let sql = null, basis = null, chart = { type: 'kpi', x: '', y: [], title: '' };
    const usable = m && (m.tables || []).includes('user_journey');
    if (usable) {
      const conds = []; let select;
      // 계산식 조각: expression(값 1개) 또는 expressions({출력 이름: 계산식}, 값 여러 개)
      const pct = m.unit === '%';
      const exprs = m.sql?.expressions && typeof m.sql.expressions === 'object' ? Object.entries(m.sql.expressions)
        : m.sql?.expression ? [[`${m.id.split('.')[1]}${pct ? '_pct' : ''}`, m.sql.expression]] : [];
      if (m.type === 'metric' && exprs.length && exprs.every(([k, e]) => ident(k) && !/\bFROM\b/i.test(e))) {
        if (m.sql.where) conds.push(m.sql.where);
        select = `COUNT(*) AS customers, ${exprs.map(([k, e]) => `ROUND(${pct ? '100.0 * ' : ''}${e}, 1) AS ${k}`).join(', ')}`;
      } else if (m.type === 'business_term' && m.sql?.condition) { select = 'COUNT(*) AS customers, SUM(push_opt_in_current) AS push_reachable'; conds.push(m.sql.condition); }
      if (select) {
        conds.push(...where);
        sql = `SELECT ${group ? group.col + ', ' : ''}${select} FROM user_journey${conds.length ? ' WHERE ' + conds.map(c => `(${c})`).join(' AND ') : ''}${group ? ` GROUP BY ${group.col} ORDER BY ${group.col}` : ''}`;
        basis = basisOf(m, { dimensions: group ? [group.d.name] : [], filters: [...(m.filters || []), ...where] });
        if (group) chart = { type: group.col === 'signup_date' ? 'line' : 'bar', x: group.col, y: [select.split(', ')[1]?.split(' AS ').pop()], title: `${group.d.name}별 ${m.name}` };
      }
    }
    // 지표 없이 차원만 물은 경우(예: 연령대별 고객 수, 가입일별 가입자 추이): 그룹별 고객 수
    if (!sql && !usable) {
      const d = group?.d || dims.find(x => ident(x.sql?.group_by) && UJ.has(x.sql.group_by));
      if (d && !m) {
        const g = d.sql.group_by;
        sql = `SELECT ${g}, COUNT(*) AS customers FROM user_journey${where.length ? ' WHERE ' + where.map(c => `(${c})`).join(' AND ') : ''} GROUP BY ${g} ORDER BY ${g}`;
        basis = basisOf(d, { dimensions: [d.name], filters: where });
        chart = { type: g === 'signup_date' ? 'line' : 'bar', x: g, y: ['customers'], title: `${d.name}별 고객 수` };
      }
    }
    if (!sql) {
      const it = m || dims[0];
      return { cannot_answer: true, reason: `템플릿 모드는 시맨틱 정의의 계산식·조건 조각만 조합해 SQL 을 만듭니다. '${it.name}' 질문은 조각만으로 조합하지 못해 Claude 가 SQL 을 생성해야 합니다(현재 Claude 호출 불가 — 연결 확인 후 다시 시도).` };
    }
    basis.assumptions.push('템플릿 모드: 시맨틱 정의의 SQL 조각을 규칙으로 조합(LLM 미사용)');
    return { cannot_answer: false, question_type: chart.type === 'kpi' ? 'kpi' : chart.type === 'line' ? 'trend' : 'comparison', sql, analysis_basis: basis, chart };
  },

  // 규칙 기반 수정 — LLM 을 쓸 수 없을 때만 사용 (수정 엔진을 로그에 구분 기록)
  repair({ sql, err, basis, rag }) {
    let s = sql, why = '';
    if (err.errorType === 'Syntax Error') {
      if (/COUNT\(\s*(?=FROM\b)/i.test(s)) { s = s.replace(/COUNT\(\s*(?=FROM\b)/i, 'COUNT(*) '); why = 'COUNT( 의 인자와 닫는 괄호가 빠져 COUNT(*) 로 보완'; }
      else {
        const open = (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length;
        if (open > 0) { s = s + ')'.repeat(open); why = `닫히지 않은 괄호 ${open}개 보완`; }
        else if (/,\s*FROM\b/i.test(s)) { s = s.replace(/,\s*FROM\b/i, ' FROM'); why = 'FROM 앞의 불필요한 쉼표 제거'; }
      }
    } else if (err.errorType === 'Column Not Found') {
      const bad = (/no such column: ([\w.]+)/i.exec(err.message)?.[1] || /컬럼: ([\w.]+)/.exec(err.message)?.[1] || '').split('.').pop();
      const tables = (/\bFROM\s+(\w+)/i.exec(s)?.[1] ? [/\bFROM\s+(\w+)/i.exec(s)[1]] : []).filter(t => META_TABLES.has(t));
      const cands = tables.flatMap(t => META_TABLES.get(t).columns.map(c => c.name));
      const best = cands.map(c => [c, editDistance(c, bad)]).sort((a, b) => a[1] - b[1])[0];
      if (bad && best && best[1] <= Math.max(2, Math.floor(bad.length / 4))) { s = s.replace(new RegExp(`\\b${bad}\\b`, 'g'), best[0]); why = `없는 컬럼 ${bad} 를 가장 가까운 실제 컬럼 ${best[0]} 로 교체`; }
      else if (bad) {
        const m = /^\s*SELECT\s+([\s\S]+?)\s+FROM\b/i.exec(s);
        const items = m ? m[1].split(',').map(x => x.trim()).filter(x => !new RegExp(`\\b${bad}\\b`).test(x)) : [];
        s = s.replace(/^\s*SELECT\s+[\s\S]+?\s+FROM\b/i, `SELECT ${items.length ? items.join(', ') : 'COUNT(*) AS row_count'} FROM`);
        why = `${tables[0] || '테이블'} 에 '${bad}' 와 비슷한 컬럼이 없어(사용 가능: ${cands.slice(0, 8).join(', ')}…) 해당 항목을 빼고 ${items.length ? '나머지 컬럼만' : '행 수(COUNT(*))만'} 조회`;
      }
    } else if (err.errorType === 'Type Mismatch') {
      s = s.replace(/\b(age_band|signup_device_type|first_product_family|channel_type|signup_date)\s*(=|<>|!=)\s*(\d+)\b/g, "$1 $2 '$3'"); why = 'TEXT 코드 컬럼과 비교하는 숫자를 문자열로 변경';
    }
    // 없는 테이블 · JOIN · 시간 초과 · 함수 오류는 SQL 을 다시 써야 하므로 규칙으로 고치지 않음(저장된 쿼리로 바꿔치기하지 않음)
    if (s === sql || !why) return { sql: '', reason: `규칙 기반 수정기로 고칠 수 없는 오류(${err.errorType})입니다. SQL 을 다시 쓰려면 Claude 수정이 필요합니다.` };
    return { sql: s, reason: why, changes: [why] };
  },

  explain(question, basis, result, rag) {
    const it = rag.semantic.find(s => s.id === basis?.definitions_used?.[0]);
    const first = result.rows[0];
    const parts = first ? result.columns.map((c, i) => `${c} ${first[i] === null ? '계산 불가' : fmtNum(first[i])}`) : [];
    return {
      summary: result.rowCount ? (result.rowCount === 1 ? `${basis?.metric || '결과'}: ${parts.join(' · ')}` : `${basis?.metric || '결과'} 기준 ${result.rowCount}개 그룹을 비교했습니다.`) : '조건에 맞는 고객이 없습니다.',
      insights: [], cautions: [...(it?.cautions || []).slice(0, 2)], next_actions: (it?.actions || []).slice(0, 2),
    };
  },
};

function editDistance(a, b) {
  a = String(a); b = String(b); const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/* ---------------------------------------------------------------------
 * LLM SQL Repair 모듈
 * ------------------------------------------------------------------- */
async function repairSql(ctx) {
  if (LLM.available()) {
    const prompt = repairPrompt(ctx);
    try {
      const out = await LLM.json(prompt, 'default');
      return { sql: String(out?.sql || '').trim().replace(/;\s*$/, ''), reason: out?.reason || '', changes: out?.changes || [], engine: 'llm', promptChars: prompt.length, feedback: { errorType: ctx.err.errorType, message: ctx.err.message, metadataTables: [...DB.loaded] } };
    } catch (e) {
      const r = Template.repair(ctx);
      return { ...r, engine: 'rule', llmError: e?.code || String(e), feedback: { errorType: ctx.err.errorType, message: ctx.err.message } };
    }
  }
  return { ...Template.repair(ctx), engine: 'rule', feedback: { errorType: ctx.err.errorType, message: ctx.err.message } };
}

/* ---------------------------------------------------------------------
 * Harness Orchestrator
 *  질문 → RAG → SQL 생성 → 안전성·메타데이터 검증 → 읽기 전용 실행 → 오류 시 수정(최대 2회) → 재검증·재실행 → 로그
 * ------------------------------------------------------------------- */
const STATUS = {
  success: { label: '검증 성공', tone: 'ok' },
  repaired: { label: '자동 수정 성공', tone: 'ok2' },
  retry_failed: { label: '재시도 실패', tone: 'bad' },
  validation_failed: { label: '검증 실패', tone: 'bad' },
  blocked: { label: '위험 SQL 차단', tone: 'block' },
  needs_data: { label: '추가 데이터 필요', tone: 'warn' },
  cannot_answer: { label: '계산 불가', tone: 'warn' },
};
const inflight = new Set();
const SENSITIVE_COLS = /^(user_key|payment_key)$/;

async function runAgent(question, opts = {}) {
  const key = nq(question) + '|' + (opts.initialSql || '');
  if (inflight.has(key)) return { duplicate: true, message: '같은 질문이 이미 실행 중입니다. 끝난 뒤 다시 시도하세요.' };
  inflight.add(key);
  try { return await runAgentInner(question, opts); } finally { inflight.delete(key); }
}

async function runAgentInner(question, opts) {
  const T0 = performance.now(); const requestId = newRequestId();
  const log = { requestId, ts: new Date().toISOString(), tsNum: Date.now(), question, source: opts.source || 'chat', model: LLM.label(), semanticVersion: Sem.version, stages: [], attempts: [], status: null, errorTypes: [], retries: 0, initialSql: null, finalSql: null, repairs: [] };
  const stage = (name, ok, detail = '', extra = {}) => log.stages.push({ name, ok, detail, t: +(performance.now() - T0).toFixed(1), ...extra });
  const finish = async (status, answer) => {
    log.status = status; log.durationMs = +(performance.now() - T0).toFixed(1); log.answer = answer;
    stage('결과', ['success', 'repaired'].includes(status), STATUS[status].label);
    await saveLogs(log, rag);
    return { requestId, status, log, rag, answer };
  };
  stage('질문 접수', true, question.slice(0, 120));

  // 데이터 변경 요청은 LLM 호출 없이 즉시 차단
  let rag = null;
  if (!opts.initialSql && DESTRUCTIVE.test(question)) {
    stage('요청 안전성', false, '데이터 변경·삭제 요청');
    log.errorTypes.push('Permission Error');
    return finish('blocked', { summary: '데이터를 변경·삭제하는 요청은 처리하지 않습니다. 이 에이전트는 읽기 전용 조회만 합니다.', reason: '데이터 변경 요청 차단' });
  }

  // ① RAG Context 검색
  rag = retrieve(question);
  log.context = { selected: rag.semanticMeta, tables: rag.tables, joins: rag.joins.map(j => j.join), filters: rag.filters, threshold: rag.threshold, top: rag.ranking.slice(0, 10).map(r => ({ rank: r.rank, id: r.id, score: r.score, selected: r.selected })) };
  stage('Context 검색', rag.semantic.length > 0, rag.semantic.length ? `정의 ${rag.semantic.length}개 · 테이블 ${rag.tables.map(t => t.name).join(', ')}${rag.filters.length ? ` · 필터 ${rag.filters.map(f => f.condition || f.label + '(값 없음)').join(', ')}` : ''}` : rag.noResultReason, { ms: rag.ms });
  if (rag.filters.length) stage('필터 값 DB 확인', rag.filters.every(f => f.verified), rag.filters.map(f => `${f.label} → ${f.verified ? `${f.column}='${f.value}' (${f.n.toLocaleString()}명)` : '없음'}`).join(', '));

  if (!opts.initialSql && !rag.semantic.length) {
    return finish('cannot_answer', { summary: '이 질문에 필요한 지표·용어 정의를 Semantic Layer 에서 찾지 못해 임의 계산식을 만들지 않았습니다.', reason: rag.noResultReason, needs: ['Semantic Layer 에 해당 지표(계산식·분자·분모·기간)를 추가하면 답할 수 있습니다.'] });
  }
  // 데이터 가용성 확인: 정식 계산에 필요한 원천이 없는 지표(예: 캠페인 반응률)
  const topMetric = rag.semantic[0];
  if (!opts.initialSql && topMetric?.sql?.status && ['proxy_only', 'unavailable'].includes(topMetric.sql.status) && !/대리|proxy/i.test(question)) {
    stage('데이터 가용성 확인', false, `${topMetric.name}: ${topMetric.sql.official || '정식 계산 원천 없음'}`);
    return finish('needs_data', {
      summary: `'${topMetric.name}' 은(는) 제공 데이터로 계산할 수 없어 숫자를 만들지 않았습니다.`,
      reason: topMetric.sql.official || topMetric.description, needs: topMetric.actions || [], definition: topMetric.id,
      proxy: topMetric.sql?.proxy_expression ? `대리 지표가 정의되어 있습니다: ${topMetric.formula}. "대리 지표로 ${topMetric.name} 보여줘" 라고 물으면 대리 지표임을 표시해 계산합니다.` : '',
    });
  }

  // ② SQL 생성
  let gen;
  if (opts.initialSql) { gen = { sql: opts.initialSql, analysis_basis: null, chart: { type: 'table' }, engine: 'test-input' }; stage('최초 SQL', true, '테스트 입력 SQL 사용(생성 생략)'); }
  else if (LLM.available()) {
    const prompt = sqlPrompt(question, rag);
    try { gen = await LLM.json(prompt, 'default'); gen.engine = 'llm'; log.promptChars = prompt.length; stage('최초 SQL 생성', true, `Claude 생성 (프롬프트 ${prompt.length.toLocaleString()}자 · 검색 Context 포함)`); }
    catch (e) { gen = Template.generate(question, rag); gen.engine = 'template'; log.llmError = e?.code || String(e); stage('최초 SQL 생성', true, `LLM 호출 실패(${log.llmError}) → 템플릿 모드`); }
  } else { gen = Template.generate(question, rag); gen.engine = 'template'; stage('최초 SQL 생성', true, '템플릿 모드(검색된 정의의 SQL 조각 조합)'); }
  log.generator = gen.engine;
  if (gen.cannot_answer || !String(gen.sql || '').trim()) {
    stage('SQL 생성', false, gen.reason || 'SQL 없음');
    return finish(/데이터|로그|미제공|없/.test(gen.reason || '') ? 'needs_data' : 'cannot_answer', { summary: gen.reason || '이 질문은 현재 정의·데이터로 답할 수 없습니다.', reason: gen.reason });
  }
  let sql = String(gen.sql).trim().replace(/;\s*$/, '');
  log.initialSql = sql;
  const basis = gen.analysis_basis || null;
  const tried = [];

  // ③ 검증 → 실행 → 수정 루프 (초기 1회 + 수정 최대 2회)
  for (let attempt = 0; attempt <= POLICY.maxRepairs; attempt++) {
    tried.push(sql);
    const v = validateSql(sql);
    const a = { attempt, sql, validation: { verdict: v.verdict, errorType: v.errorType, message: v.message, checks: v.checks, tablesUsed: v.tablesUsed, columnsUsed: v.columnsUsed, ms: v.ms } };
    log.attempts.push(a);
    stage(attempt ? `재검증 #${attempt}` : 'SQL 검증', v.ok, v.ok ? `통과 (${v.checks.length}개 항목 · ${v.tablesUsed.join(', ')})` : `${v.errorType}: ${v.message}`);
    let err = null;
    if (v.verdict === 'blocked') {
      log.errorTypes.push(v.errorType);
      return finish('blocked', { summary: '위험 SQL 로 판정되어 DB 에 실행하지 않고 차단했습니다. 자동 수정으로 우회하지 않습니다.', reason: v.message, blockedSql: sql });
    }
    if (v.ok) {
      const r = executeSql(v.sql);
      a.execution = r.ok ? { ok: true, rowCount: r.rowCount, truncated: r.truncated, ms: r.ms, readOnly: true } : { ok: false, errorType: r.errorType, message: r.message, ms: r.ms };
      stage(attempt ? `재실행 #${attempt}` : 'DB 실행', r.ok, r.ok ? `${r.rowCount.toLocaleString()}행 · ${r.ms}ms · 읽기 전용${r.truncated ? ` · ${POLICY.maxRows}행에서 절단` : ''}` : `${r.errorType}: ${r.message}`);
      if (r.ok) {
        log.finalSql = v.sql; log.retries = attempt;
        log.result = { columns: r.columns, rowCount: r.rowCount, truncated: r.truncated, preview: r.rows.slice(0, 20).map(row => row.map((x, i) => SENSITIVE_COLS.test(r.columns[i]) ? '***' : x)) };
        const answer = await buildAnswer(question, rag, gen, basis, r, log);
        return finish(attempt ? 'repaired' : 'success', answer);
      }
      err = { errorType: r.errorType, message: r.message, stage: 'execution' };
      if (r.errorType === 'Permission Error') { log.errorTypes.push(err.errorType); return finish('blocked', { summary: '읽기 전용 정책 위반이 감지되어 중단했습니다.', reason: r.message }); }
    } else err = { errorType: v.errorType, message: v.message, stage: 'validation' };
    log.errorTypes.push(err.errorType);
    stage('오류 감지', false, `[${err.errorType}] ${ERROR_TYPES[err.errorType] || ''} — ${err.message}`);
    if (attempt === POLICY.maxRepairs) break;
    // ④ 자동 수정
    const fix = await repairSql({ question, rag, sql, err, checks: v.checks, basis, history: tried });
    log.repairs.push({ attempt: attempt + 1, from: sql, to: fix.sql, reason: fix.reason, engine: fix.engine, llmError: fix.llmError, errorType: err.errorType, errorMessage: err.message, feedback: fix.feedback });
    if (!fix.sql) { stage(`수정 SQL #${attempt + 1}`, false, `수정 실패 (${fix.engine === 'llm' ? 'LLM' : '규칙'}): ${fix.reason}`); break; }
    if (tried.includes(fix.sql.replace(/;\s*$/, ''))) { stage(`수정 SQL #${attempt + 1}`, false, '이전에 실패한 SQL 과 같아 중복 실행하지 않음'); break; }
    stage(`수정 SQL #${attempt + 1}`, true, `${fix.engine === 'llm' ? 'LLM(Claude)' : '규칙 기반'} 수정: ${fix.reason}`);
    sql = fix.sql.replace(/;\s*$/, '');
  }
  log.retries = log.repairs.length; log.finalSql = null;
  const last = log.attempts[log.attempts.length - 1];
  return finish(log.repairs.length ? 'retry_failed' : 'validation_failed', { summary: `SQL 이 ${log.attempts.length}번 시도 모두 검증·실행에 실패해 중단했습니다. 결과를 성공으로 표시하지 않습니다.`, reason: `${last.execution?.errorType || last.validation.errorType}: ${last.execution?.message || last.validation.message}` });
}

async function buildAnswer(question, rag, gen, basis, r, log) {
  let ex;
  if (LLM.available() && gen.engine === 'llm') {
    try { ex = await LLM.json(explainPrompt(question, basis, r), 'quick'); ex.engine = 'llm'; }
    catch (e) { ex = Template.explain(question, basis, r, rag); ex.engine = 'template'; }
  } else { ex = Template.explain(question, basis, r, rag); ex.engine = 'template'; }
  log.explainEngine = ex.engine;
  const kpis = r.rowCount === 1 ? r.columns.map((c, i) => ({ label: c, value: r.rows[0][i] })).filter(k => typeof k.value === 'number' || k.value === null).slice(0, 4) : [];
  return { summary: ex.summary, insights: ex.insights || [], cautions: ex.cautions || [], next_actions: ex.next_actions || [], kpis, chart: gen.chart || { type: 'table' }, basis, columns: r.columns, rows: r.rows.slice(0, 200), rowCount: r.rowCount, truncated: r.truncated };
}

/* ---------------------------------------------------------------------
 * 로그 저장: 하네스 로그(logs) + RAG 검색 로그(rag_logs), Request ID 로 연결
 *  - 개인 식별 키(user_key 등) 값은 마스킹, API Key 는 애초에 다루지 않음
 *  - 저장 실패해도 보안 정책은 그대로 (결과 상태를 바꾸지 않음)
 * ------------------------------------------------------------------- */
async function saveLogs(log, rag) {
  const flat = { requestId: log.requestId, ts: log.ts, tsNum: log.tsNum, question: log.question.slice(0, 500), status: log.status, retries: log.retries, durationMs: log.durationMs, source: log.source, model: log.model, errorTypes: [...new Set(log.errorTypes)].join(','), payload: JSON.stringify(trimLog(log)) };
  const r1 = await Store.put('logs', log.requestId, flat);
  if (rag) await saveRagLog(log.requestId, rag);
  log.saved = r1.saved;
}
function trimLog(log) {
  const x = { ...log };
  if (x.answer?.rows) x.answer = { ...x.answer, rows: x.answer.rows.slice(0, 20).map(row => row.map((v, i) => SENSITIVE_COLS.test(x.answer.columns[i]) ? '***' : v)) };
  return x;
}
async function saveRagLog(requestId, rag) {
  const flat = { requestId, ts: rag.at, tsNum: Date.parse(rag.at), question: rag.question.slice(0, 500), selectedCount: rag.semanticMeta.length, noResult: !rag.semantic.length, version: rag.version,
    payload: JSON.stringify({ ranking: rag.ranking, semanticMeta: rag.semanticMeta, tables: rag.tables, joins: rag.joins.map(j => j.join), filters: rag.filters, threshold: rag.threshold, noResultReason: rag.noResultReason, context: rag.context.slice(0, 60000), ms: rag.ms }) };
  await Store.put('rag_logs', requestId, flat);
}
const parsePayload = d => { try { return JSON.parse(d.payload || '{}'); } catch { return {}; } };
