// ott.db → 브라우저용 데이터 파일 (dist/data/data.js · data-watch.js · data-content.js)
//  - 팀 메타데이터(data/metadata.json) 스키마로 테이블을 뽑고, 2-4 질문용 보충 컬럼을 더한다
//  - 시맨틱 정의 = 팀 semantic_layer.json + supplement → 팀 컬럼명으로 변환 → semantic_overrides.json 보정
// 사용: node scripts/export-data.mjs [ott.db 경로] [출력 폴더]   (기본: .build/ott.db → dist/data)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSemanticSource } from './semantic-adapter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const DB_FILE = path.resolve(process.argv[2] || path.join(ROOT, '.build', 'ott.db'));
const OUT_DIR = path.resolve(process.argv[3] || path.join(ROOT, 'dist', 'data'));
if (!fs.existsSync(DB_FILE)) { console.error(`DB 가 없습니다: ${DB_FILE}\n먼저 npm run build:db -- "<CSV 폴더>" 를 실행하세요.`); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, 'data.js');
const db = new DatabaseSync(DB_FILE, { readOnly: true });
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'metadata.json'), 'utf8'));

// 1) 팀 user_journey 스키마 + 에이전트 보충 컬럼
const EXT = [
  ['active_d7_after_pay', 'INTEGER', '[보충] 첫 결제일~+7일 시청 기록 존재 (PDF 결제 후 D+7 활성). D+30 첫 결제 고객만, 그 외 NULL', 'active_d7_after_pay'],
  ['active_d14_after_pay', 'INTEGER', '[보충] 첫 결제일~+14일 시청 기록 존재', 'active_d14_after_pay'],
  ['active_d28_after_pay', 'INTEGER', '[보충] 첫 결제일~+28일 시청 기록 존재', 'active_d28_after_pay'],
  ['used_vod_28d', 'INTEGER', '[보충] 결제 후 D+0~28 VOD(V) 시청', 'used_vod_28d'],
  ['used_movie_28d', 'INTEGER', '[보충] 결제 후 D+0~28 영화(M) 시청', 'used_movie_28d'],
  ['used_live_28d', 'INTEGER', '[보충] 결제 후 D+0~28 LIVE(L) 시청', 'used_live_28d'],
  ['watched_d0_30', 'INTEGER', '[보충] 가입 후 D0~D30 시청 기록 존재', 'watched_d0_30'],
  ['has_behavior_d30', 'INTEGER', '[보충] D0~D30 behavior_fact 기록 1건 이상', 'has_behavior_d30'],
  ['home_visited_d30', 'INTEGER', '[보충] D0~D30 HOME_VISIT 1회 이상', 'home_visited_d30'],
  ['recommend_clicked_d30', 'INTEGER', '[보충] D0~D30 RECOMMEND_CONTENT_CLICK 1회 이상', 'recommend_clicked_d30'],
  ['watch_time_total', 'INTEGER', '[보충] D0~D60 watch_time_raw 합 (단위 미확정 원천값)', 'watch_time_total'],
  ['ever_auto_payment', 'INTEGER', '[보충] D0~D90 자동결제 이력 존재', 'ever_auto_payment'],
  ['first_product_name', 'TEXT', '[보충] 첫 결제 상품명', 'first_product_name'],
  ['signup_month', 'TEXT', "[보충] 가입 월 'YYYY-MM'", 'signup_month'],
  // 저장소 user_journey.retained_d22_28 은 '4주차 시청만' — 팀 메타데이터의 같은 이름(4주차 + D+0~21)과 달라 별도 컬럼으로 노출
  ['watched_d22_28_after_pay', 'INTEGER', "[보충] 결제 후 D+22~28(4주차) 시청 기록 존재. D+0~21 조건 없음 — 대시보드 KPI 'D+22~28 시청 유지율' 분자. D+30 첫 결제 고객만, 그 외 NULL", 'CASE WHEN user_journey.paid_d30 = 1 THEN COALESCE(user_journey.retained_d22_28, 0) END'],
];
const TEAM_MAP = { explored: 'explored_d30', voucher_viewed: 'voucher_viewed_d30', is_auto_payment: 'first_is_auto_payment', watch_days_d7_after_pay: 'COALESCE(initial_watch_days, 0)',
  initial_watch: 'COALESCE(initial_watch_success, 0)', retained_d22_28: 'COALESCE(sustained_watch, 0)', search_cnt: 'search_cnt_d30', play_click_cnt: 'play_click_cnt_d30',
  zzim_cnt: 'zzim_cnt_d30', voucher_view_cnt: 'voucher_view_cnt_d30', watch_days_d0_60: 'watch_days_total', push_opt_in_current: 'push_opt_in' };
const uj = meta.tables.find(t => t.name === 'user_journey');
for (const [n, t, d] of EXT) uj.columns.push({ name: n, type: t, description: d, nullable: true, supplement: true });
uj.description += ' (+ [보충] 컬럼: 2-4 필수 질문·PDF 지표 계산용으로 에이전트가 같은 원천에서 추가 계산)';
const ujSel = uj.columns.map(c => `${TEAM_MAP[c.name] || EXT.find(e => e[0] === c.name)?.[3] || c.name} AS ${c.name}`).join(', ');

let KEYS = null, KIDX = null, CKIDX = null;
function col(rows, cols) {
  const out = { n: rows.length, cols: [] };
  for (const c of cols) {
    const vals = rows.map(r => { const v = r[c.name]; return v === undefined || v === null ? null : typeof v === 'bigint' ? Number(v) : v; });
    if (c.name === 'user_key' && KEYS) {
      const idx = vals.map(v => KIDX.get(v));
      if (idx.some(i => i === undefined)) throw new Error('unknown user_key');
      out.cols.push(idx.every((v, i) => v === i) ? { name: c.name, type: 'TEXT', keys: 'seq' } : { name: c.name, type: 'TEXT', keys: 'idx', idx });
      continue;
    }
    if (c.name === 'content_key' && CKIDX) {
      const idx = vals.map(v => CKIDX.get(v));
      if (idx.some(i => i === undefined)) throw new Error('unknown content_key');
      out.cols.push({ name: c.name, type: 'TEXT', keys: 'cidx', idx });
      continue;
    }
    if (c.type === 'TEXT') {
      const dict = [...new Set(vals)];
      out.cols.push(dict.length < 3000 ? { name: c.name, type: 'TEXT', dict, idx: vals.map(v => dict.indexOf(v)) } : { name: c.name, type: 'TEXT', raw: vals });
    } else out.cols.push({ name: c.name, type: c.type, v: vals });
  }
  return out;
}
const T = {};
KEYS = db.prepare('SELECT user_key FROM user_dim ORDER BY user_key').all().map(r => r.user_key);
KIDX = new Map(KEYS.map((k, i) => [k, i]));
T.user_dim_first = 1;
T.user_journey = col(db.prepare(`SELECT ${ujSel} FROM user_journey ORDER BY user_key`).all(), uj.columns);
const ud = meta.tables.find(t => t.name === 'user_dim');
T.user_dim = col(db.prepare(`SELECT ${ud.columns.map(c => c.name).join(', ')} FROM user_dim ORDER BY user_key`).all(), ud.columns);
const pf = meta.tables.find(t => t.name === 'payment_fact');
// 팀 메타데이터 타입(INTEGER)으로 변환
T.payment_fact = col(db.prepare(`SELECT ${pf.columns.map(c => c.type === 'INTEGER' ? `CAST(${c.name} AS INTEGER) AS ${c.name}` : c.name).join(', ')} FROM payment_fact`).all(), pf.columns);
delete T.user_dim_first;
const wf = meta.tables.find(t => t.name === 'watch_daily_fact');
const W = { watch_daily_fact: col(db.prepare(`SELECT ${wf.columns.map(c => c.type === 'INTEGER' ? `CAST(${c.name} AS INTEGER) AS ${c.name}` : c.name).join(', ')} FROM watch_daily_fact`).all(), wf.columns) };
// 3) 콘텐츠 3종(장르·선호 콘텐츠 질문용): content_key 는 사전 인덱스로 압축
const CKEYS = db.prepare('SELECT content_key FROM content_dim ORDER BY content_key').all().map(r => r.content_key);
CKIDX = new Map(CKEYS.map((k, i) => [k, i]));
const C = {};
for (const name of ['content_dim', 'content_genre_bridge', 'user_content_summary']) {
  const m = meta.tables.find(t => t.name === name);
  C[name] = col(db.prepare(`SELECT ${m.columns.map(c => c.type === 'INTEGER' ? `CAST(${c.name} AS INTEGER) AS ${c.name}` : c.name).join(', ')} FROM ${name}`).all(), m.columns);
}
const LOADED = [...Object.keys(T), 'watch_daily_fact', ...Object.keys(C)];
for (const t of meta.tables) t.loaded = LOADED.includes(t.name);

// 2) 시맨틱 정의: 저장소 user_journey 컬럼명 → 팀 메타데이터 컬럼명
const RENAME = [['explored_d30', 'explored'], ['voucher_viewed_d30', 'voucher_viewed'], ['initial_watch_success', 'initial_watch'], ['initial_watch_days', 'watch_days_d7_after_pay'],
  ['sustained_watch', 'retained_d22_28'], ['search_cnt_d30', 'search_cnt'], ['play_click_cnt_d30', 'play_click_cnt'], ['zzim_cnt_d30', 'zzim_cnt'], ['voucher_view_cnt_d30', 'voucher_view_cnt'],
  ['watch_days_total', 'watch_days_d0_60'], ['push_opt_in', 'push_opt_in_current'], ['first_is_auto_payment', 'is_auto_payment']];
const sem = loadSemanticSource();
let s = JSON.stringify(sem.items);
// sustained_watch → retained_d22_28 전에, 저장소의 '4주차만' retained_d22_28 은 쓰지 않음(초기 시청 후 미유지는 initial_watch=1 이라 결과 동일)
for (const [a, b] of RENAME) s = s.replace(new RegExp(`\\b${a}\\b(?!_current)`, 'g'), b);
const items = JSON.parse(s);
// 초기 미시청률: 원천 계보(user_dim·payment_fact·watch_daily_fact)를 lineage 로 연결
for (const it of items) {
  if (it.id === 'metric.initial_no_watch_rate' || it.id === 'term.step_initial_watch_fail' || it.id === 'metric.activation_fail_rate')
    it.lineage_tables = ['user_dim', 'payment_fact', 'watch_daily_fact'];
}
// 통합웹 보정: 대시보드 v9 · 발표 PDF 숫자에 맞춘 필드 덮어쓰기와 정의 추가 (semantic_overrides.json)
const OV = JSON.parse(fs.readFileSync(path.join(DATA, 'semantic_overrides.json'), 'utf8'));
for (const [id, fields] of Object.entries(OV.patch || {})) {
  const it = items.find(x => x.id === id);
  if (!it) throw new Error(`보정 대상 정의 없음: ${id}`);
  Object.assign(it, fields);
}
for (const it of OV.add || []) {
  if (items.some(x => x.id === it.id)) throw new Error(`이미 있는 정의: ${it.id}`);
  items.push(it);
}
fs.writeFileSync(OUT.replace('data.js', 'data-watch.js'), 'window.TABLES_EXTRA=' + JSON.stringify(W) + ';');
fs.writeFileSync(OUT.replace('data.js', 'data-content.js'), 'window.CKEYS=' + JSON.stringify(CKEYS) + ';\nwindow.TABLES_EXTRA=' + JSON.stringify(C) + ';');
fs.writeFileSync(OUT, 'window.KEYS=' + JSON.stringify(KEYS) + ';\nwindow.TABLES=' + JSON.stringify(T) + ';\nwindow.META=' + JSON.stringify(meta) + ';\nwindow.SEM=' + JSON.stringify({ items, conventions: sem.conventions, hash: sem.hash }) + ';');
console.log(LOADED, (fs.statSync(OUT).size / 1e6).toFixed(1) + 'MB', (fs.statSync(OUT.replace('data.js', 'data-watch.js')).size / 1e6).toFixed(1) + 'MB', (fs.statSync(OUT.replace('data.js', 'data-content.js')).size / 1e6).toFixed(1) + 'MB', items.length);
// 검증: 팀 스키마로 Q 값
const chk = db.prepare(`SELECT SUM(${TEAM_MAP.initial_watch}) a, SUM(${TEAM_MAP.retained_d22_28}) b, SUM(CASE WHEN paid_d30 = 1 THEN retained_d22_28 END) c FROM user_journey`).get(); console.log(chk, '기대: a 7983 · b 5967 · c 6103');
