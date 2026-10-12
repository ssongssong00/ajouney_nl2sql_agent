// 에이전트 회귀 테스트 (템플릿 모드 · LLM 없이): 정의 검증 · 대시보드/PDF 숫자 · 하네스 차단·수정 · 저장된 쿼리 미사용
const test = require('node:test');
const assert = require('node:assert/strict');
const loadEngine = require('./engine.cjs');

const nums = r => (r.answer?.rows || []).flat().filter(v => typeof v === 'number');

// 팀 원본 semantic_layer.json 에서 설명·기간·단위·테이블 등 문서 필드가 빠진 정의 (원본을 고치면 이 목록에서 지운다)
const KNOWN_DOC_GAPS = [
  'dim.age_band', 'dim.channel_type', 'dim.content_title', 'dim.explore_type', 'dim.genre',
  'metric.avg_behavior_count', 'metric.behavior_experience_rate', 'metric.explore_rate', 'metric.first_week_content_count',
  'metric.first_week_watch_days', 'metric.retention_rate', 'metric.user_count', 'metric.watch_channel_combo',
];
test('시맨틱 정의 63개: SQL 조각은 모두 실제 DB 에서 컴파일되고, 문서 누락은 알려진 목록뿐', async () => {
  const A = await loadEngine();
  assert.equal(A.Sem.all().length, 63);
  const results = [...A.Sem.all()].map(it => [it.id, [...A.validateDefinition(it, {})]]);   // vm 쪽 배열을 일반 배열로
  const sqlErrors = results.flatMap(([id, es]) => es.filter(e => /검증 실패/.test(e)).map(e => `${id}: ${e}`));
  assert.deepEqual(sqlErrors, []);
  assert.deepEqual(results.filter(([, es]) => es.length).map(([id]) => id).sort(), KNOWN_DOC_GAPS);
});

// [질문, 결과에 있어야 하는 대시보드·발표 PDF 숫자]
const PARITY = [
  ['전체 가입 고객 수는?', [50000]],
  ['탐색률은 얼마야?', [60.2]],
  ['이용권 페이지 방문률은?', [57.3]],
  ['D+30 결제 전환율은 얼마야?', [24.9]],
  ['D+7 결제 전환율은?', [24.0, 24.4, 24.9]],
  ['결제 후 시청 활성화율 보여줘', [79.4, 82.8, 85.6]],
  ['초기 미시청률은 얼마야?', [20.6]],
  ['초기 시청 실패율은?', [36.0]],
  ['20대 고객의 초기 시청 실패율은 얼마인가요?', [33.7]],
  ['초기 시청 실패 고객은 몇 명이고 그중 푸시 도달 가능한 고객은?', [4485, 1655]],
  ['결제 후 22~28일 사이 시청 유지율은 얼마인가요?', [48.9]],
  ['연령대별 결제 후 22~28일 시청 유지율', [43.9, 62.2]],
  ['4주 지속 시청 고객은 몇 명이야?', [4009]],
  ['지속 시청 고객은 몇 명이야?', [5088]],
  ['고객 여정 퍼널 보여줘', [50000, 30121, 20538, 8970, 6371, 4009]],
  ['VOD, 영화, LIVE 이용 고객 비율을 비교해주세요.', [79.6, 37.3, 7.8]],
  ['우선 타깃 1위 고객은 몇 명이고 푸시 도달 규모는?', [18991, 8152]],
  ['선택 피로 방랑 유저는 몇 명이고, 푸시 도달 가능한 고객은 몇 명인가요?', [10216, 4270]],
];
for (const [q, want] of PARITY) {
  test(`숫자 일치: ${q}`, async () => {
    const A = await loadEngine();
    const r = await A.runAgent(q);
    assert.ok(['success', 'repaired'].includes(r.status), `${r.status}: ${r.answer?.summary}`);
    for (const w of want) assert.ok(nums(r).some(v => Math.abs(v - w) < 0.05), `${w} 없음 — 결과 ${JSON.stringify(r.answer.rows?.slice(0, 3))}`);
  });
}

test('데이터 없음·변경 요청: 숫자를 만들지 않고 막는다', async () => {
  const A = await loadEngine();
  const camp = await A.runAgent('캠페인 반응률 알려줘');
  assert.equal(camp.status, 'needs_data'); assert.equal(camp.log.finalSql, null);
  for (const q of ['미결제 고객 데이터를 전부 삭제해줘', 'user_dim 테이블을 DROP 하고 새로 만들어']) assert.equal((await A.runAgent(q)).status, 'blocked');
});

// [입력 SQL, 기대 상태] — 하네스가 정상 SQL 은 통과, 위험 SQL 은 실행 전 차단, 고칠 수 있는 오류는 수정 후 재실행
const HARNESS = [
  ['SELECT age_band, COUNT(DISTINCT user_key) AS users FROM user_journey GROUP BY age_band', 'success'],
  ['SELECT COUNT(*) AS users FROM user_dim WHERE user_key IN (SELECT user_key FROM payment_fact WHERE payment_order = 1)', 'success'],
  ["SELECT replace(age_band, '_', '~') AS band FROM user_dim GROUP BY band", 'success'],
  ['DELETE FROM user_dim', 'blocked'],
  ['SELECT 1; DROP TABLE payment_fact', 'blocked'],
  ['WITH x AS (SELECT 1) INSERT INTO user_dim SELECT * FROM user_dim', 'blocked'],
  ['SELECT * FROM sqlite_master', 'blocked'],
  ['SELECT nonexistent_column FROM user_dim', 'repaired'],
  ['SELECT COUNT( FROM user_dim', 'repaired'],
  ['SELECT COUNT(*) FROM user_journey WHERE age_band = 20', 'repaired'],
];
for (const [sql, want] of HARNESS) {
  test(`하네스 ${want}: ${sql}`, async () => {
    const A = await loadEngine();
    const w0 = A.DB.writes;
    const r = await A.runAgent('전체 가입 고객 수', { initialSql: sql });
    assert.equal(r.status, want, r.answer?.reason);
    assert.equal(A.DB.writes, w0, '데이터 변경 발생');
    if (want === 'blocked') { assert.equal(r.log.repairs.length, 0); assert.ok(!r.log.attempts.some(a => a.execution)); }
  });
}

test('삭제 SQL 차단 후에도 user_dim 50,000행 유지', async () => {
  const A = await loadEngine();
  await A.runAgent('삭제 시도', { initialSql: 'DELETE FROM user_dim' });
  assert.equal(A.guardedQuery('SELECT COUNT(*) FROM user_dim').rows[0][0], 50000);
});

test('저장된 완성 쿼리를 쓰지 않는다: LLM 프롬프트에 SELECT 문이 없고, 규칙 수정은 다른 쿼리로 바꿔치기하지 않는다', async () => {
  const A = await loadEngine();
  for (const q of ['D+30 결제 전환율은 얼마야?', '가입 기기별 활성 고객 비율을 비교해줘', '콘텐츠 장르별 시청자 수 TOP 10', '초기 시청 성공 고객 수']) {
    const ctx = A.retrieve(q).context;
    assert.equal(ctx.split('\n').filter(l => /\bSELECT\b/i.test(l)).length, 0, q);
  }
  const r = await A.runAgent('전체 가입 고객 수', { initialSql: 'SELECT * FROM customers' });
  assert.equal(r.status, 'retry_failed');
});
