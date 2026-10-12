// 문제 2-1) CSV 원본(해커톤 데이터 7종) → SQLite DB (.build/ott.db)
// 사용: npm run build:db -- "<CSV 폴더 경로>"   (생략 시 data/csv)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = process.argv[2] || process.env.DATA_DIR || path.join(ROOT, 'data', 'csv');
const OUT = path.join(ROOT, '.build', 'ott.db');
if (!SRC || !fs.existsSync(SRC)) {
  console.error('CSV 폴더를 찾을 수 없습니다. npm run build:db -- "<경로>" 로 지정하거나 data/csv 에 넣으세요.');
  process.exit(1);
}

// 테이블 정의: 컬럼 타입은 CSV 값을 확인해 정함 (전처리 결과는 metadata.json 에 그대로 기록)
const TABLES = {
  user_dim: {
    pk: ['user_key'],
    cols: { user_key: 'TEXT NOT NULL', signup_date: 'TEXT NOT NULL', signup_device_type: 'TEXT', gender_code: 'INTEGER', age_band: 'TEXT', push_opt_in_current: 'INTEGER' },
  },
  payment_fact: {
    pk: ['payment_key'],
    fk: [['user_key', 'user_dim', 'user_key']],
    cols: {
      payment_key: 'TEXT NOT NULL', user_key: 'TEXT NOT NULL', payment_date: 'TEXT', relative_signup_day: 'INTEGER', payment_order: 'INTEGER',
      source_user_type: 'TEXT', product_code: 'TEXT', product_name: 'TEXT', transaction_amount: 'REAL', cash_paid_amount: 'REAL', coin_used_amount: 'REAL',
      bonus_used_amount: 'REAL', discount_amount: 'REAL', promotion_discount_amount: 'REAL', currency_type_id: 'INTEGER', payment_device_type: 'TEXT',
      market_type_id: 'INTEGER', partner_type_id: 'INTEGER', promotion_id: 'TEXT', package_type_id: 'TEXT', screen_quality_type_id: 'TEXT', screen_type_id: 'TEXT',
      is_auto_payment: 'INTEGER', service_start_date: 'TEXT', service_end_date: 'TEXT', service_duration_days: 'INTEGER', concurrent_watch_count: 'INTEGER',
    },
  },
  behavior_fact: {
    pk: ['user_key', 'event_date', 'behavior_type'],
    fk: [['user_key', 'user_dim', 'user_key']],
    cols: { user_key: 'TEXT NOT NULL', event_date: 'TEXT NOT NULL', relative_signup_day: 'INTEGER', behavior_type: 'TEXT NOT NULL', event_count: 'INTEGER', export_part: 'INTEGER' },
  },
  watch_daily_fact: {
    pk: ['user_key', 'watch_date', 'channel_type'],
    fk: [['user_key', 'user_dim', 'user_key']],
    cols: {
      user_key: 'TEXT NOT NULL', watch_date: 'TEXT NOT NULL', relative_signup_day: 'INTEGER', channel_type: 'TEXT NOT NULL', watch_time_raw: 'INTEGER',
      watch_log_count: 'INTEGER', distinct_content_count: 'INTEGER', active_hour_count: 'INTEGER', has_charged_watch: 'INTEGER', export_part: 'INTEGER',
    },
  },
  content_dim: {
    pk: ['content_key'],
    cols: { content_key: 'TEXT NOT NULL', channel_type: 'TEXT', content_id: 'TEXT', program_id: 'TEXT', title: 'TEXT', channel_id: 'TEXT', channel_name: 'TEXT', section: 'TEXT', target_age: 'TEXT' },
  },
  content_genre_bridge: {
    pk: ['content_key', 'genre_source', 'genre_code'],
    fk: [['content_key', 'content_dim', 'content_key']],
    cols: { content_key: 'TEXT NOT NULL', genre_code: 'TEXT NOT NULL', genre_name: 'TEXT', genre_source: 'TEXT NOT NULL' },
  },
  user_content_summary: {
    pk: ['user_key', 'content_key'],
    fk: [['user_key', 'user_dim', 'user_key'], ['content_key', 'content_dim', 'content_key']],
    cols: {
      user_key: 'TEXT NOT NULL', channel_type: 'TEXT', content_key: 'TEXT NOT NULL', total_watch_time_raw: 'INTEGER', watch_log_count: 'INTEGER',
      watch_day_count: 'INTEGER', first_watch_day: 'INTEGER', last_watch_day: 'INTEGER', has_charged_watch: 'INTEGER', export_part: 'INTEGER',
    },
  },
};

// 조회 패턴(고객 ID 조인, 상대일 범위, 행동 유형 필터)에 맞춘 인덱스
const INDEXES = [
  ['idx_user_signup', 'user_dim', 'signup_date'],
  ['idx_pay_user_order', 'payment_fact', 'user_key, payment_order'],
  ['idx_beh_user_day', 'behavior_fact', 'user_key, relative_signup_day'],
  ['idx_beh_type', 'behavior_fact', 'behavior_type, relative_signup_day'],
  ['idx_watch_user_day', 'watch_daily_fact', 'user_key, relative_signup_day'],
  ['idx_ucs_content', 'user_content_summary', 'content_key, user_key, total_watch_time_raw, watch_day_count, first_watch_day'],
  ['idx_genre_name', 'content_genre_bridge', 'genre_source, genre_name'],
  ['idx_journey_segment', 'user_journey', 'age_band, signup_device_type'],
];

function parseLine(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

const conv = (type, v) => {
  if (v === '' || v === undefined) return null;
  if (type.startsWith('INTEGER')) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; }
  if (type.startsWith('REAL')) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return v;
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
for (const f of [OUT, OUT + '-wal', OUT + '-shm']) if (fs.existsSync(f)) fs.rmSync(f);
const db = new DatabaseSync(OUT);
db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;');

const profile = {};
console.log('원본:', SRC);
for (const [name, t] of Object.entries(TABLES)) {
  const cols = Object.keys(t.cols);
  const fks = (t.fk || []).map(([c, rt, rc]) => `, FOREIGN KEY (${c}) REFERENCES ${rt}(${rc})`).join('');
  db.exec(`CREATE TABLE ${name} (${cols.map(c => `${c} ${t.cols[c]}`).join(', ')}, PRIMARY KEY (${t.pk.join(', ')})${fks}) WITHOUT ROWID`);
  const ins = db.prepare(`INSERT INTO ${name} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const started = Date.now();
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(SRC, name + '.csv'), 'utf8'), crlfDelay: Infinity });
  let head = null, n = 0, dup = 0;
  const nulls = Object.fromEntries(cols.map(c => [c, 0]));
  db.exec('BEGIN');
  for await (const line of rl) {
    if (!line) continue;
    const v = parseLine(line);
    if (!head) { head = Object.fromEntries(v.map((h, i) => [h.replace(/^﻿/, ''), i])); continue; }
    const row = cols.map(c => { const x = conv(t.cols[c], v[head[c]]); if (x === null) nulls[c]++; return x; });
    try { ins.run(...row); n++; } catch (e) { if (String(e.message).includes('UNIQUE')) dup++; else throw e; }
  }
  db.exec('COMMIT');
  profile[name] = { rows: n, duplicate_pk_rows: dup, null_counts: Object.fromEntries(Object.entries(nulls).filter(([, x]) => x)) };
  console.log(`  ${name.padEnd(22)} ${n.toLocaleString()}행  PK중복 ${dup}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

// 대시보드(src/lib/metrics.js · scripts/build-data.mjs)와 같은 정의의 고객 단위 파생 테이블
const ACTIVE = `'SEARCH_OPEN','SEARCH_SUBMIT','SEARCH_CONTENT_CLICK','SEARCH_MORE_CLICK','CATEGORY_VISIT','DETAIL_MORE','DETAIL_LIST_CLICK','DETAIL_ZZIM','RECOMMEND_CONTENT_CLICK'`;
db.exec(`
CREATE TABLE user_journey AS
WITH fp AS (
  SELECT user_key, relative_signup_day AS first_pay_day, payment_date AS first_payment_date, product_name AS first_product_name,
         is_auto_payment AS first_is_auto_payment, transaction_amount AS first_transaction_amount
  FROM payment_fact WHERE payment_order = 1
),
pay_any AS (SELECT user_key, MAX(is_auto_payment) AS ever_auto_payment, COUNT(*) AS payment_count FROM payment_fact GROUP BY user_key),
b AS (
  SELECT user_key,
    1 AS has_behavior_d30,
    MAX(behavior_type IN (${ACTIVE}, 'DETAIL_PLAY_CLICK')) AS explored_d30,
    MAX(behavior_type = 'VOUCHER_VIEW') AS voucher_viewed_d30,
    SUM(CASE WHEN behavior_type = 'VOUCHER_VIEW' THEN event_count ELSE 0 END) AS voucher_view_cnt_d30,
    SUM(CASE WHEN behavior_type LIKE 'SEARCH!_%' ESCAPE '!' THEN event_count ELSE 0 END) AS search_cnt_d30,
    SUM(CASE WHEN behavior_type = 'DETAIL_PLAY_CLICK' THEN event_count ELSE 0 END) AS play_click_cnt_d30,
    SUM(CASE WHEN behavior_type = 'DETAIL_ZZIM' THEN event_count ELSE 0 END) AS zzim_cnt_d30,
    SUM(CASE WHEN behavior_type IN (${ACTIVE}) THEN event_count ELSE 0 END) AS active_event_cnt_d30,
    MAX(behavior_type = 'RECOMMEND_CONTENT_CLICK') AS recommend_clicked_d30,
    MAX(behavior_type = 'HOME_VISIT') AS home_visited_d30
  FROM behavior_fact WHERE relative_signup_day BETWEEN 0 AND 30 GROUP BY user_key
),
wd AS (SELECT user_key, relative_signup_day AS d, channel_type FROM watch_daily_fact),
w AS (
  SELECT user_key, COUNT(DISTINCT d) AS watch_days_total, SUM(t) AS watch_time_total,
         MAX(d BETWEEN 0 AND 30) AS watched_d0_30
  FROM (SELECT user_key, relative_signup_day AS d, watch_time_raw AS t FROM watch_daily_fact) GROUP BY user_key
),
pw AS (
  SELECT fp.user_key,
    COUNT(DISTINCT CASE WHEN wd.d BETWEEN fp.first_pay_day AND fp.first_pay_day + 7 THEN wd.d END) AS initial_watch_days,
    MAX(wd.d BETWEEN fp.first_pay_day AND fp.first_pay_day + 7) AS active_d7_after_pay,
    MAX(wd.d BETWEEN fp.first_pay_day AND fp.first_pay_day + 14) AS active_d14_after_pay,
    MAX(wd.d BETWEEN fp.first_pay_day AND fp.first_pay_day + 28) AS active_d28_after_pay,
    MAX(wd.d BETWEEN fp.first_pay_day + 22 AND fp.first_pay_day + 28) AS retained_d22_28,
    MAX(wd.d BETWEEN fp.first_pay_day AND fp.first_pay_day + 21) AS watched_d0_21_after_pay,
    MAX(wd.d BETWEEN fp.first_pay_day AND fp.first_pay_day + 28 AND wd.channel_type = 'V') AS used_vod_28d,
    MAX(wd.d BETWEEN fp.first_pay_day AND fp.first_pay_day + 28 AND wd.channel_type = 'M') AS used_movie_28d,
    MAX(wd.d BETWEEN fp.first_pay_day AND fp.first_pay_day + 28 AND wd.channel_type = 'L') AS used_live_28d
  FROM fp LEFT JOIN wd ON wd.user_key = fp.user_key
  WHERE fp.first_pay_day BETWEEN 0 AND 30
  GROUP BY fp.user_key
)
SELECT
  u.user_key, u.signup_date, substr(u.signup_date, 1, 7) AS signup_month, u.signup_device_type, u.age_band, u.gender_code,
  u.push_opt_in_current AS push_opt_in,
  COALESCE(b.has_behavior_d30, 0) AS has_behavior_d30, COALESCE(b.explored_d30, 0) AS explored_d30,
  COALESCE(b.home_visited_d30, 0) AS home_visited_d30,
  COALESCE(b.voucher_viewed_d30, 0) AS voucher_viewed_d30, COALESCE(b.voucher_view_cnt_d30, 0) AS voucher_view_cnt_d30,
  COALESCE(b.search_cnt_d30, 0) AS search_cnt_d30, COALESCE(b.play_click_cnt_d30, 0) AS play_click_cnt_d30,
  COALESCE(b.zzim_cnt_d30, 0) AS zzim_cnt_d30, COALESCE(b.active_event_cnt_d30, 0) AS active_event_cnt_d30,
  COALESCE(b.recommend_clicked_d30, 0) AS recommend_clicked_d30,
  fp.first_pay_day, fp.first_payment_date, fp.first_product_name,
  CASE
    WHEN fp.first_product_name IS NULL THEN '없음'
    WHEN fp.first_product_name LIKE '%장기이용권%' THEN '장기이용권(12개월)'
    WHEN fp.first_product_name LIKE '더블%' THEN '더블(결합)'
    WHEN fp.first_product_name LIKE '%번들%' THEN '번들(디즈니+ 등)'
    WHEN fp.first_product_name LIKE '3 PACK%' THEN '3 PACK'
    WHEN fp.first_product_name LIKE '[쿠폰]%' OR fp.first_product_name LIKE '멜론%' THEN '기타(제휴·쿠폰)'
    WHEN fp.first_product_name LIKE '광고형 스탠다드%' THEN '광고형 스탠다드'
    WHEN fp.first_product_name LIKE '베이직%' THEN '베이직'
    WHEN fp.first_product_name LIKE '스탠다드%' THEN '스탠다드'
    WHEN fp.first_product_name LIKE '프리미엄%' THEN '프리미엄'
    ELSE '기타(제휴·쿠폰)'
  END AS first_product_family,
  fp.first_is_auto_payment, fp.first_transaction_amount,
  COALESCE(pa.ever_auto_payment, 0) AS ever_auto_payment, COALESCE(pa.payment_count, 0) AS payment_count,
  CASE WHEN fp.first_pay_day BETWEEN 0 AND 7 THEN 1 ELSE 0 END AS paid_d7,
  CASE WHEN fp.first_pay_day BETWEEN 0 AND 14 THEN 1 ELSE 0 END AS paid_d14,
  CASE WHEN fp.first_pay_day BETWEEN 0 AND 30 THEN 1 ELSE 0 END AS paid_d30,
  COALESCE(w.watched_d0_30, 0) AS watched_d0_30, COALESCE(w.watch_days_total, 0) AS watch_days_total, COALESCE(w.watch_time_total, 0) AS watch_time_total,
  pw.initial_watch_days,
  CASE WHEN pw.user_key IS NULL THEN NULL ELSE (pw.initial_watch_days >= 2) END AS initial_watch_success,
  COALESCE(pw.active_d7_after_pay, CASE WHEN pw.user_key IS NULL THEN NULL ELSE 0 END) AS active_d7_after_pay,
  COALESCE(pw.active_d14_after_pay, CASE WHEN pw.user_key IS NULL THEN NULL ELSE 0 END) AS active_d14_after_pay,
  COALESCE(pw.active_d28_after_pay, CASE WHEN pw.user_key IS NULL THEN NULL ELSE 0 END) AS active_d28_after_pay,
  COALESCE(pw.retained_d22_28, CASE WHEN pw.user_key IS NULL THEN NULL ELSE 0 END) AS retained_d22_28,
  COALESCE(pw.watched_d0_21_after_pay, CASE WHEN pw.user_key IS NULL THEN NULL ELSE 0 END) AS watched_d0_21_after_pay,
  CASE WHEN pw.user_key IS NULL THEN NULL ELSE (COALESCE(pw.retained_d22_28, 0) = 1 AND COALESCE(pw.watched_d0_21_after_pay, 0) = 1) END AS sustained_watch,
  COALESCE(pw.used_vod_28d, CASE WHEN pw.user_key IS NULL THEN NULL ELSE 0 END) AS used_vod_28d,
  COALESCE(pw.used_movie_28d, CASE WHEN pw.user_key IS NULL THEN NULL ELSE 0 END) AS used_movie_28d,
  COALESCE(pw.used_live_28d, CASE WHEN pw.user_key IS NULL THEN NULL ELSE 0 END) AS used_live_28d
FROM user_dim u
LEFT JOIN b ON b.user_key = u.user_key
LEFT JOIN fp ON fp.user_key = u.user_key
LEFT JOIN pay_any pa ON pa.user_key = u.user_key
LEFT JOIN w ON w.user_key = u.user_key
LEFT JOIN pw ON pw.user_key = u.user_key;
CREATE UNIQUE INDEX idx_journey_pk ON user_journey(user_key);
`);
profile.user_journey = { rows: db.prepare('SELECT COUNT(*) n FROM user_journey').get().n };
console.log(`  user_journey           ${profile.user_journey.rows.toLocaleString()}행 (대시보드 정의 파생 테이블)`);

for (const [n, t, c] of INDEXES) db.exec(`CREATE INDEX ${n} ON ${t}(${c})`);

// 참조 무결성 확인 (FK 위반 건수)
const fkCheck = {};
for (const [name, t] of Object.entries(TABLES)) for (const [c, rt, rc] of t.fk || []) {
  fkCheck[`${name}.${c} → ${rt}.${rc}`] = db.prepare(`SELECT COUNT(*) n FROM ${name} x WHERE NOT EXISTS (SELECT 1 FROM ${rt} r WHERE r.${rc} = x.${c})`).get().n;
}
console.log('FK 위반 건수:', fkCheck);
db.exec('ANALYZE');
db.close();
fs.writeFileSync(path.join(ROOT, '.build', 'build-profile.json'), JSON.stringify({ builtAt: new Date().toISOString(), source: SRC, tables: profile, fk_violations: fkCheck }, null, 2));
console.log('완료 →', OUT);
