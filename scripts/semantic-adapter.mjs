// 시맨틱 레이어 파일 → 에이전트 정의 목록(items) 변환기
// - semantic_layer.json 이 `items` 배열 형식이면 그대로 사용
// - 팀 2-2 형식(funnel_steps · metrics · dimensions · segments · behavior_groups · conventions)이면 items 로 변환
// - semantic_supplement.json(팀 파일에 없는 개념)을 합침
// 파일 내용이 바뀌면 hash 가 바뀌고, store.syncSemanticFile() 이 자동으로 다시 불러온다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

export const SEMANTIC_FILE = process.env.AGENT_SEMANTIC_FILE || path.join(DATA_DIR, 'semantic_layer.json');
export const SUPPLEMENT_FILE = path.join(DATA_DIR, 'semantic_supplement.json');

// 퍼널 단계 → user_journey 조건 (user_journey 는 원천 테이블에서 같은 정의로 만든 고객 단위 파생 테이블)
const STEP_UJ = {
  signup: '1 = 1',
  explored: 'explored_d30 = 1',
  voucher_viewed: 'voucher_viewed_d30 = 1',
  paid_d30: 'paid_d30 = 1',
  initial_watch: 'initial_watch_success = 1',
  initial_watch_fail: 'paid_d30 = 1 AND initial_watch_days < 2',
  retained_after_activation: 'initial_watch_success = 1 AND sustained_watch = 1',
  retained_d22_28: 'sustained_watch = 1',
  not_retained: 'initial_watch_success = 1 AND retained_d22_28 = 0',
};
// 차원 → user_journey 컬럼 (없으면 원천 테이블 조인이 필요한 차원: LLM 모드에서 처리)
const DIM_UJ = { device: 'signup_device_type', age_band: 'age_band', push: 'push_opt_in', product_family: 'first_product_family', auto_payment: 'first_is_auto_payment' };
// 팀 파일에 동의어가 없는 항목의 검색용 별칭 보강
const ALIAS_HINT = {
  'metric.user_count': ['가입 고객 수', '전체 가입 고객', '가입자 수', '전체 고객 수'],
  'metric.pay_rate_d30': ['30일 이내 첫 결제 전환율', '첫 결제 전환율', 'D+30 결제 전환율'],
  'metric.activation_rate': ['초기 시청 활성화율', '초기 시청률', '초기 활성화율', '초기 시청 성공 비율'],
  'metric.activation_fail_rate': ['초기 시청 실패 비율', '첫 주 시청 실패율'],
  'metric.retention_rate': ['지속 시청률', '초기 시청 후 지속률'],
  'metric.retention_rate_dashboard': ['시청 유지율', '22~28일 시청 유지율', 'D22~D28 유지율', '결제 후 22~28일 유지율', '4주차 시청 유지율'],
  'metric.explore_rate': ['탐색 비율', '서비스 탐색 비율'],
  'metric.voucher_view_rate': ['이용권 페이지 방문률', '이용권 관심 비율'],
  'dim.device': ['기기', '기기별', '디바이스'],
  'dim.age_band': ['연령', '나이', '연령별'],
  'dim.product_family': ['요금제', '상품', '이용권 상품', '상품별'],
  'dim.push': ['푸시 수신 여부', '푸시 동의'],
  'dim.auto_payment': ['자동결제', '자동 결제'],
};

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const readIf = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const ageLabel = v => (/^(\d)0_\d9$/.test(v) ? `${v[0]}0대` : null);

export function sourceHash() {
  return hash((readIf(SEMANTIC_FILE) || '') + '|' + (readIf(SUPPLEMENT_FILE) || ''));
}

export function loadSemanticSource() {
  const raw = readIf(SEMANTIC_FILE);
  if (!raw) throw new Error(`시맨틱 레이어 파일이 없습니다: ${SEMANTIC_FILE}`);
  const src = JSON.parse(raw);
  const items = Array.isArray(src.items) ? src.items : adaptTeamFormat(src);
  const sup = readIf(SUPPLEMENT_FILE);
  const ids = new Set(items.map(i => i.id));
  if (sup) for (const it of JSON.parse(sup).items || []) if (!ids.has(it.id)) items.push({ ...it, source: 'supplement' });
  return { items, conventions: conventionsOf(src), hash: sourceHash(), format: Array.isArray(src.items) ? 'items' : 'team-2-2' };
}

export function conventionsOf(src) {
  const c = src.conventions || {};
  const lines = [];
  if (c.day_reference) lines.push(`기간 기준: ${c.day_reference}`);
  if (c.user_count) lines.push(`고객 수: ${c.user_count}`);
  if (c.observation_window) lines.push(`관측 기간: ${Object.entries(c.observation_window).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const g of c.guardrails || []) lines.push(g);
  return lines;
}

export function loadConventions() {
  try { return conventionsOf(JSON.parse(readIf(SEMANTIC_FILE) || '{}')); } catch { return []; }
}

const ratioSql = (num, den) => ({
  expression: `1.0 * SUM(CASE WHEN ${num} THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)`,
  ...(den && den !== '1 = 1' ? { where: den } : {}),
});

function adaptTeamFormat(src) {
  const steps = src.funnel_steps || {};
  const stepName = k => steps[k]?.label || k;
  const stepCond = k => STEP_UJ[k] || null;
  const items = [];

  for (const [k, s] of Object.entries(steps)) {
    const cond = stepCond(k);
    items.push({
      id: `term.step_${k}`, type: 'business_term', name: `${s.label} 고객`, aliases: [s.label, ...(s.synonyms || [])],
      description: `퍼널 ${s.order}단계 '${s.label}'. 규칙: ${s.rule}${s.base ? ` (모수: ${stepName(s.base)})` : ''}${s.note ? `. ${s.note}` : ''}`,
      tables: cond ? ['user_journey'] : [], columns: [], join_keys: ['user_key'],
      sql: { ...(cond ? { condition: cond } : {}), ...(s.sql ? { raw_sql: s.sql } : {}) },
      formula: '-', numerator: '-', denominator: s.base ? `${stepName(s.base)} 고객` : '-', grain: '고객', period: s.window || '', filters: [], unit: '명',
      null_handling: '-', cautions: [s.reference_count != null ? `대시보드 기준 ${s.reference_count.toLocaleString('ko-KR')}명` : '', s.note || ''].filter(Boolean), actions: [],
      example_sql: cond ? `SELECT COUNT(*) AS customers, SUM(push_opt_in) AS push_reachable FROM user_journey WHERE ${cond}` : (s.sql || ''),
      source: 'semantic_layer.funnel_steps',
    });
  }

  for (const [k, m] of Object.entries(src.metrics || {})) {
    const id = `metric.${k}`;
    const num = stepCond(m.numerator), den = m.denominator === 'segment' ? null : stepCond(m.denominator);
    const isRatio = num && (den || m.denominator === 'segment');
    const sql = isRatio ? ratioSql(num, den) : m.expression ? { expression: m.expression } : {};
    const pct = m.format === 'percent';
    const where = sql.where ? ` WHERE ${sql.where}` : '';
    items.push({
      id, type: 'metric', name: m.label, aliases: [...(m.synonyms || []), ...(ALIAS_HINT[id] || [])],
      description: [m.label, m.rule, m.window_rule, m.note].filter(Boolean).join('. '),
      tables: sql.expression ? ['user_journey'] : [], columns: [], join_keys: ['user_key'], sql,
      formula: isRatio ? `${stepName(m.numerator)} 고객 수 ÷ ${m.denominator === 'segment' ? '질문한 세그먼트 고객 수(기본: 가입 고객)' : stepName(m.denominator) + ' 고객 수'}` : (m.rule || m.expression || ''),
      numerator: isRatio ? `${num} 인 고객 수` : '-', denominator: isRatio ? (den ? `${den} 인 고객 수` : '대상 세그먼트 전체 고객 수') : '-',
      grain: '고객', period: steps[m.numerator]?.window || '', filters: sql.where ? [sql.where] : [], unit: pct ? '%' : (m.format === 'number' ? '' : '명'),
      null_handling: '분모가 0이면 NULL(계산 불가)로 둔다. 0으로 바꾸지 않는다.',
      cautions: [m.reference_value != null ? `대시보드 기준 ${pct ? (m.reference_value * 100).toFixed(1) + '%' : m.reference_value}` : '', m.note || ''].filter(Boolean),
      actions: [],
      example_sql: isRatio
        ? `SELECT COUNT(*) AS denominator, SUM(CASE WHEN ${num} THEN 1 ELSE 0 END) AS numerator, ROUND(100.0 * SUM(CASE WHEN ${num} THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS ${k}_pct FROM user_journey${where}`
        : sql.expression ? `SELECT ${sql.expression} AS ${k} FROM user_journey` : '',
      source: 'semantic_layer.metrics',
    });
  }

  for (const [k, d] of Object.entries(src.dimensions || {})) {
    const id = `dim.${k}`, col = DIM_UJ[k];
    const examples = {};
    if (col && Array.isArray(d.values)) for (const v of d.values) { examples[v] = `${col} = '${v}'`; const a = ageLabel(v); if (a) examples[a] = `${col} = '${v}'`; }
    if (k === 'age_band') { examples['10대'] = "age_band IN ('UNDER_14', '14_19')"; examples['60대 이상'] = "age_band IN ('60_69', '70_PLUS')"; examples['연령 미상'] = "age_band = 'UNKNOWN'"; }
    if (col && d.values && !Array.isArray(d.values)) for (const [v, label] of Object.entries(d.values)) examples[label] = `${col} = ${/^\d+$/.test(v) ? v : `'${v}'`}`;
    if (k === 'product_family' && d.sql) for (const m of d.sql.matchAll(/THEN '([^']+)'/g)) examples[m[1]] = `${col} LIKE '${m[1].split('(')[0]}%'`;
    items.push({
      id, type: 'dimension', name: d.label, aliases: [...(d.synonyms || []), ...(ALIAS_HINT[id] || []), ...Object.keys(examples).filter(x => /[가-힣]/.test(x) || ['mobile', 'android', 'ios', 'pc'].includes(x))],
      description: [d.label, d.scope ? `범위: ${d.scope}` : '', d.note || ''].filter(Boolean).join('. '),
      tables: col ? ['user_journey'] : [String(d.column || '').split('.')[0]].filter(Boolean), columns: [d.column].filter(Boolean), join_keys: ['user_key'],
      sql: { ...(col ? { group_by: col } : { raw_column: d.column }), ...(Object.keys(examples).length ? { condition_examples: examples } : {}), ...(d.sql ? { raw_case: d.sql } : {}) },
      formula: '-', numerator: '-', denominator: '-', grain: '고객', period: '', filters: [], unit: '',
      null_handling: '-', cautions: [d.note, d.min_sample ? `표본 ${d.min_sample}명 이상만 비교` : ''].filter(Boolean), actions: [],
      example_sql: col ? `SELECT ${col}, COUNT(*) AS customers FROM user_journey GROUP BY ${col} ORDER BY ${col}` : '',
      source: 'semantic_layer.dimensions',
    });
  }

  const translate = rule => rule
    .replace(/auto_payment\s*=\s*(\d)/g, 'first_is_auto_payment = $1')
    .replace(/\b([a-z_0-9]+)\b/g, w => (STEP_UJ[w] ? `(${STEP_UJ[w]})` : w))
    .replace(/\bNOT \(/g, 'NOT (');
  for (const [k, s] of Object.entries(src.segments || {})) {
    const cond = translate(s.rule);
    items.push({
      id: `term.seg_${k}`, type: 'business_term', name: s.label, aliases: [s.label],
      description: `세그먼트: ${s.rule}`, tables: ['user_journey'], columns: [], join_keys: ['user_key'], sql: { condition: cond },
      formula: '-', numerator: '-', denominator: '-', grain: '고객', period: '', filters: [], unit: '명', null_handling: '-',
      cautions: s.reference ? Object.entries(s.reference).map(([m, v]) => `대시보드 기준 ${m} ${(v * 100).toFixed(1)}%`) : [], actions: [],
      example_sql: `SELECT COUNT(*) AS customers FROM user_journey WHERE ${cond}`, source: 'semantic_layer.segments',
    });
  }

  for (const [k, g] of Object.entries(src.behavior_groups || {})) {
    items.push({
      id: `term.bg_${k}`, type: 'business_term', name: `${g.label} 행동`, aliases: [g.label, ...(g.synonyms || [])],
      description: `행동 그룹 '${g.label}': behavior_type ${g.types.join(', ')}${g.note ? `. ${g.note}` : ''}${g.is_explore === false ? '. 탐색 행동에 포함하지 않음' : ''}`,
      tables: ['behavior_fact'], columns: ['behavior_fact.behavior_type', 'behavior_fact.event_count', 'behavior_fact.relative_signup_day'], join_keys: ['user_key'],
      sql: { condition: `behavior_type IN (${g.types.map(t => `'${t}'`).join(', ')})` },
      formula: '-', numerator: '-', denominator: '-', grain: '고객 × 행동일 × 행동 유형', period: 'D0~D30', filters: [], unit: '',
      null_handling: '-', cautions: ['고객 수는 COUNT(DISTINCT user_key)'], actions: [], example_sql: '', source: 'semantic_layer.behavior_groups',
    });
  }
  return items;
}
