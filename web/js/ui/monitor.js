'use strict';
/* =====================================================================
 * ui/monitor.js — 하네스 모니터링 탭: 상태 카드 · 실행 이력 · 상세 · 로그/테스트 내려받기 · 하네스 테스트
 * ===================================================================== */

/* ---------------------------------------------------------------------
 * 하네스 모니터링: 상태 카드 · 실행 이력 · 상세(Context · 단계 · SQL 비교 · 오류 피드백) · 내려받기 · 테스트
 *  agent.js 가 남기는 하네스 로그(Store.mem.logs, payload = JSON 문자열)를 읽기만 한다
 * ------------------------------------------------------------------- */
const MON_CARDS = [['success', 'ok'], ['validation_failed', 'bad'], ['repaired', 'ok2'], ['retry_failed', 'bad'], ['blocked', '']];
const genLabel = g => ({ llm: 'Claude 생성', template: '템플릿 생성', 'test-input': '테스트 입력' }[g] || g || '');
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const monLogs = () => [...Store.mem.logs.values()].sort((a, b) => b.tsNum - a.tsNum);
let monQueued = false;
function queueMonitor() { if (monQueued) return; monQueued = true; requestAnimationFrame(() => { monQueued = false; renderMonitor(); }); }

function renderMonitor() {
  if (UI.tab !== 'mon' || !UI.open) return;
  syncDownloadButtons();
  if (!UI.ready) {
    $('#mon-stats').innerHTML = ''; $('#mon-other').textContent = ''; $('#mon-detail').innerHTML = ''; $('#mon-src').textContent = '';
    $('#mon-list').innerHTML = `<p class="empty">${escHtml(UI.failed || '에이전트를 준비하는 중입니다. 준비되면 실행 이력이 여기에 표시됩니다.')}</p>`;
    return;
  }
  const logs = monLogs();
  $('#mon-src').textContent = UI.logsShared ? `공유 로그 DB · 최근 ${logs.length.toLocaleString()}건` : `이 탭에서 실행한 ${logs.length.toLocaleString()}건 (공유 로그 DB 미연결)`;
  $('#mon-stats').innerHTML = MON_CARDS.map(([st, tone]) => `<button type="button" class="stat ${tone}" data-monf="${st}" aria-pressed="${UI.monFilter === st}" title="누르면 이 상태만 봅니다"><div class="l">${STATUS[st].label}</div><div class="v">${logs.filter(d => d.status === st).length.toLocaleString()}</div></button>`).join('');
  const other = logs.filter(d => !MON_CARDS.some(([st]) => st === d.status)).length;
  $('#mon-other').textContent = `전체 ${logs.length.toLocaleString()}건 · 그 외(추가 데이터 필요 · 계산 불가) ${other.toLocaleString()}건${UI.monFilter ? ` · '${STATUS[UI.monFilter].label}'만 보는 중 (카드를 다시 누르면 전체)` : ''}`;
  const rows = UI.monFilter ? logs.filter(d => d.status === UI.monFilter) : logs;
  $('#mon-list').innerHTML = rows.length ? `<div class="tbl-wrap list-scroll" style="max-height:340px"><table class="t"><thead><tr><th>시각</th><th>Request ID</th><th>질문</th><th>상태</th><th class="num">재시도</th><th>오류 유형</th></tr></thead><tbody>
    ${rows.map(d => `<tr class="click ${UI.monSel === d.requestId ? 'sel' : ''}" data-mon="${escHtml(d.requestId)}" tabindex="0"><td class="small" style="white-space:nowrap">${fmtTime(d.ts)}</td><td class="mono small" style="white-space:nowrap">${escHtml(d.requestId)}</td><td>${escHtml(d.question)}</td><td>${statusTag(d.status)}</td><td class="num">${d.retries ?? 0}</td><td class="small">${escHtml(String(d.errorTypes || '').replace(/,/g, ', ') || '-')}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="empty">${logs.length ? '이 상태의 실행 기록이 없습니다.' : '아직 실행 기록이 없습니다. 챗봇에 질문하거나 \'테스트 실행\'을 누르면 여기에 쌓입니다.'}</p>`;
  renderMonDetail();
}

function renderMonDetail() {
  const box = $('#mon-detail');
  const d = UI.monSel && Store.mem.logs.get(UI.monSel);
  if (!d) { box.innerHTML = '<p class="empty">실행 이력에서 행을 고르면 검색된 Context, 단계 타임라인, 최초·수정 SQL 비교, 오류 피드백과 최종 결과가 여기에 표시됩니다.</p>'; return; }
  const p = parsePayload(d);
  box.innerHTML = `<div class="a-top"><div class="row">${statusTag(d.status)}<span class="mono small">${escHtml(d.requestId)}</span></div><span class="small muted">${fmtTime(d.ts)} · ${Math.round(d.durationMs || 0)}ms · ${escHtml(d.model || '')}${p.semanticVersion ? ` · 정의 ${escHtml(p.semanticVersion)}` : ''}</span></div>
    <h3>① 질문과 검색된 Context</h3>${monContextHtml(p)}
    <h3>② 단계 타임라인</h3>${timeline(p.stages || [])}
    <h3>③ 최초 SQL vs 수정 SQL</h3>${monSqlHtml(p)}
    <h3>④ 오류 · 피드백 · 수정 이유 · 최종 결과</h3>${monErrorHtml(p)}`;
}

function monContextHtml(p) {
  const c = p.context;
  const head = `<p style="font-weight:600;margin:0 0 6px">${escHtml(p.question)}</p>`;
  if (!c) return head + '<p class="sub">Context 를 검색하기 전에 끝났습니다(요청 안전성 단계에서 차단).</p>';
  const defs = (c.selected || []).map(m => `<span class="tag ${m.type}" title="${escHtml(m.reason || '')}">${escHtml(m.name)}</span> <code>${escHtml(m.id)}</code> <span class="small muted">${m.expanded ? '의존 정의' : `점수 ${m.score}`}</span>`);
  const tables = (c.tables || []).map(t => `<code>${escHtml(t.name)}</code> <span class="small muted">${escHtml(t.why)}${t.loaded ? '' : ' · 미적재'}</span>`);
  const filters = (c.filters || []).map(f => f.verified ? `<code>${escHtml(f.condition)}</code> <span class="small muted">"${escHtml(f.label)}" · DB 확인 ${Number(f.n).toLocaleString()}명</span>` : `<span class="bad-t">"${escHtml(f.label)}"</span> <span class="small muted">${escHtml(f.column)} 에 해당 값 없음</span>`);
  return head + `<dl class="basis"><dt>정의</dt><dd>${defs.join('<br>') || '<span class="muted">검색된 정의 없음</span>'}</dd><dt>테이블</dt><dd>${tables.join('<br>') || '-'}</dd><dt>필터</dt><dd>${filters.join('<br>') || '<span class="muted">없음</span>'}</dd>${c.joins?.length ? `<dt>JOIN</dt><dd>${c.joins.map(j => `<code>${escHtml(j)}</code>`).join('<br>')}</dd>` : ''}<dt>선택 임계값</dt><dd>${c.threshold ?? '-'}</dd></dl>`;
}

function monSqlHtml(p) {
  if (!p.initialSql) return '<p class="sub">SQL 을 만들기 전에 끝났습니다.</p>';
  const repairs = p.repairs || [];
  const fixed = p.finalSql || [...repairs].reverse().find(r => r.to)?.to || null;
  if (!fixed || fixed === p.initialSql) return `<p class="small muted">최초 SQL (${escHtml(genLabel(p.generator))}) · 수정 없음${p.finalSql ? ' · 그대로 실행' : ''}</p>${sqlBlock(p.initialSql)}`;
  let h = `<p class="small muted"><span class="bad-t">−</span> 최초 SQL (${escHtml(genLabel(p.generator))}) → <span class="ok-t">+</span> ${p.finalSql ? '최종 실행 SQL' : '마지막 수정 SQL (실행 실패)'}</p>${lineDiff(fmtSql(p.initialSql), fmtSql(fixed))}`;
  if (repairs.length > 1) h += `<details class="box"><summary>수정 단계별 비교 ${repairs.length}회</summary>${repairs.map(r => `<p class="small"><b>수정 #${r.attempt}</b></p>${r.to ? lineDiff(fmtSql(r.from), fmtSql(r.to)) : '<p class="sub">수정 SQL 없음</p>'}`).join('')}</details>`;
  return h;
}

function monErrorHtml(p) {
  const errs = [...new Set(p.errorTypes || [])];
  const repairs = p.repairs || [];
  let h = `<dl class="basis"><dt>오류 유형</dt><dd>${errs.length ? errs.map(e => `<span class="tag bad" title="${escHtml(ERROR_TYPES[e] || '')}">${escHtml(e)}</span>`).join(' ') : '<span class="ok-t">없음</span>'}</dd><dt>재시도</dt><dd>${p.retries ?? 0}회</dd>${p.llmError ? `<dt>LLM 호출 오류</dt><dd>${escHtml(p.llmError)} → 템플릿 모드로 대체</dd>` : ''}</dl>`;
  if (!repairs.length && errs.length) {
    const last = (p.attempts || []).at(-1);
    const msg = last?.execution && !last.execution.ok ? `${last.execution.errorType}: ${last.execution.message}` : last?.validation?.message || p.answer?.reason || '';
    if (msg) h += `<p class="small"><b>판정 사유</b> ${escHtml(msg)}</p>`;
    if (p.status === 'blocked') h += '<p class="small muted">위험 SQL 은 자동 수정으로 우회하지 않으므로 수정 단계가 없습니다.</p>';
  }
  for (const r of repairs) {
    const llm = r.engine === 'llm';
    h += `<div class="repair"><div class="row"><b>수정 #${r.attempt}</b><span class="tag bad">${escHtml(r.errorType)}</span><span class="tag ${llm ? 'ok2' : ''}">${llm ? 'LLM(Claude) 수정' : '규칙 기반 수정 (LLM 미사용)'}</span></div>
      <p class="small" style="margin:6px 0 2px"><b>오류 메시지</b> ${escHtml(r.errorMessage)}</p>
      <p class="small" style="margin:6px 0 2px"><b>${llm ? 'LLM 에 넘긴 오류 피드백' : '수정기에 넘긴 오류 정보 (LLM 에는 보내지 않음)'}</b></p><pre class="fb">${escHtml(JSON.stringify(r.feedback || {}, null, 2))}</pre>
      ${r.llmError ? `<p class="small bad-t">LLM 수정 호출 실패(${escHtml(r.llmError)}) → 규칙 기반으로 대체</p>` : ''}
      <p class="small" style="margin:6px 0 0"><b>수정 이유</b> ${escHtml(r.reason || '-')}</p></div>`;
  }
  h += `<p class="small" style="margin:12px 0 6px"><b>최종 결과</b> ${statusTag(p.status)} ${escHtml(p.answer?.summary || '')}</p>`;
  if (p.result) h += `<p class="small muted">${Number(p.result.rowCount).toLocaleString()}행${p.result.truncated ? ' (일부)' : ''} · 식별 키 마스킹 미리보기</p>${dataTable(p.result.columns, p.result.preview)}`;
  else h += '<p class="small muted">실행된 결과가 없습니다. 실패·차단된 SQL 은 결과를 성공으로 표시하지 않습니다.</p>';
  return h;
}

/* 내려받기: downloads capability 가 있을 때만 버튼을 보인다 */
function syncDownloadButtons() {
  $('#mon-log-dl').hidden = !UI.downloads;
  $('#mon-test-dl').hidden = !UI.downloads || !UI.testResult;
}
async function saveJson(filename, obj, btn) {
  if (!UI.downloads) return;
  const label = btn.textContent; btn.disabled = true;
  try { await UI.downloads.save({ filename, data: JSON.stringify(obj, null, 2) }); btn.textContent = '저장했습니다'; }
  catch (e) {
    if (['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e?.code)) UI.downloads = null;
    btn.textContent = e?.code === 'declined' ? '저장을 취소했습니다' : e?.code === 'rate_limited' ? '잠시 뒤 다시 누르세요' : '이 화면에서는 내려받을 수 없습니다';
  } finally { setTimeout(() => { btn.textContent = label; btn.disabled = false; syncDownloadButtons(); }, 2400); }
}
function exportLogs() {
  const logs = monLogs();
  return {
    exportedAt: new Date().toISOString(), source: UI.logsShared ? 'shared-db (최근 300건)' : 'this-tab', count: logs.length,
    statusCounts: Object.fromEntries(Object.keys(STATUS).map(st => [st, logs.filter(d => d.status === st).length])),
    logs: logs.map(d => ({ requestId: d.requestId, ts: d.ts, question: d.question, status: d.status, retries: d.retries, durationMs: d.durationMs, source: d.source, model: d.model, errorTypes: d.errorTypes, payload: parsePayload(d) })),
    ragLogsThisTab: [...Store.mem.rag_logs.values()].map(d => ({ requestId: d.requestId, ts: d.ts, question: d.question, selectedCount: d.selectedCount, noResult: d.noResult, version: d.version, payload: parsePayload(d) })),
  };
}

/* 테스트 실행: 같은 runAgent 하네스로 6개 시나리오를 차례로 돌리고 기대값과 비교 */
const resultNums = r => (r.answer?.rows || []).flat().filter(v => typeof v === 'number');
const errsOf = r => [...new Set(r.log.errorTypes)];
const reExecuted = r => r.log.attempts.some(a => a.attempt > 0 && a.execution?.ok);
const HARNESS_TESTS = [
  { name: '전체 가입 고객 수', input: '전체 가입 고객 수는 몇 명인가요?', expected: '검증 성공 · 결과에 50,000',
    run: () => runAgent('전체 가입 고객 수는 몇 명인가요?', { source: 'test' }),
    judge: r => [['success', 'repaired'].includes(r.status) && resultNums(r).includes(50000), `${STATUS[r.status].label} · 결과 ${resultNums(r).slice(0, 4).map(fmtNum).join(', ') || '없음'}`] },
  { name: '없는 컬럼 → 감지·수정·재실행', input: "initialSql: SELECT nonexistent_column FROM user_dim", expected: 'Column Not Found 감지 → 자동 수정 → 재실행 성공',
    run: () => runAgent('전체 가입 고객 수 (하네스 테스트: 없는 컬럼)', { initialSql: 'SELECT nonexistent_column FROM user_dim', source: 'test' }),
    judge: r => [errsOf(r).includes('Column Not Found') && r.log.repairs.length >= 1 && r.status === 'repaired' && reExecuted(r), `${STATUS[r.status].label} · 감지 ${errsOf(r).join(', ') || '없음'} · 수정 ${r.log.repairs.length}회(${r.log.repairs.map(x => x.engine === 'llm' ? 'LLM' : '규칙').join(', ') || '-'}) · 재실행 ${reExecuted(r) ? '성공' : '없음'}`] },
  { name: '데이터 삭제 SQL 차단', input: 'initialSql: DELETE FROM user_dim', expected: '실행 전 차단 · 수정 0회 · 이후 user_dim 50,000행',
    run: async () => {
      const w0 = DB.writes;
      const r = await runAgent('user_dim 전체 삭제 시도 (하네스 테스트)', { initialSql: 'DELETE FROM user_dim', source: 'test' });
      const q = guardedQuery('SELECT COUNT(*) AS n FROM user_dim');
      r.check = { users: q.ok ? q.rows[0][0] : null, writes: DB.writes - w0 };
      return r;
    },
    judge: r => { const executed = r.log.attempts.some(a => a.execution); return [r.status === 'blocked' && r.log.repairs.length === 0 && !executed && r.check.users === 50000 && r.check.writes === 0, `${STATUS[r.status].label} · 수정 ${r.log.repairs.length}회 · DB 실행 ${executed ? '있음' : '없음'} · 이후 user_dim ${r.check.users === null ? '조회 실패' : r.check.users.toLocaleString() + '행'} · 데이터 변경 ${r.check.writes}건`]; } },
  { name: '문법 오류 → 감지·수정·재실행', input: 'initialSql: SELECT COUNT( FROM user_dim', expected: 'Syntax Error 감지 → 자동 수정 → 재실행 결과 50,000',
    run: () => runAgent('전체 가입 고객 수 (하네스 테스트: 문법 오류)', { initialSql: 'SELECT COUNT( FROM user_dim', source: 'test' }),
    judge: r => [errsOf(r).includes('Syntax Error') && r.status === 'repaired' && reExecuted(r) && resultNums(r).includes(50000), `${STATUS[r.status].label} · 감지 ${errsOf(r).join(', ') || '없음'} · 수정 ${r.log.repairs.length}회 · 결과 ${resultNums(r).slice(0, 4).map(fmtNum).join(', ') || '없음'}`] },
  { name: '캠페인 반응률 (데이터 없음)', input: '캠페인 반응률 알려줘', expected: '추가 데이터 필요(needs_data) · 숫자 생성 없음',
    run: () => runAgent('캠페인 반응률 알려줘', { source: 'test' }),
    judge: r => { const n = (r.answer?.rows || []).length + (r.answer?.kpis || []).length; return [r.status === 'needs_data' && n === 0 && !r.log.finalSql, `${STATUS[r.status].label} (${r.status}) · 결과 숫자 ${n}개 · 실행 SQL ${r.log.finalSql ? '있음' : '없음'}`]; } },
  { name: '초기 시청 실패 고객', input: '초기 시청 실패 고객은 몇 명이야?', expected: '검증 성공 · 결과에 4,485',
    run: () => runAgent('초기 시청 실패 고객은 몇 명이야?', { source: 'test' }),
    judge: r => [['success', 'repaired'].includes(r.status) && resultNums(r).includes(4485), `${STATUS[r.status].label} · 결과 ${resultNums(r).slice(0, 4).map(fmtNum).join(', ') || '없음'}`] },
];

async function runHarnessTests() {
  if (UI.testing || !UI.ready) return;
  UI.testing = true; $('#mon-test').disabled = true;
  const box = $('#mon-tests'); box.hidden = false;
  const cases = [];
  for (const [i, t] of HARNESS_TESTS.entries()) {
    box.innerHTML = `<div class="thinking"><span class="spin"></span>${i + 1} / ${HARNESS_TESTS.length} 실행 중: ${escHtml(t.name)}</div>`;
    let r, pass = false, actual;
    try {
      r = await t.run();
      if (r.duplicate) throw new Error(r.message);
      [pass, actual] = t.judge(r);
    } catch (e) { actual = `실행 오류: ${e?.message || e}`; }
    cases.push({ no: i + 1, name: t.name, input: t.input, expected: t.expected, actual, pass, requestId: r?.requestId || null, status: r?.status || null,
      errorTypes: r ? errsOf(r) : [], retries: r?.log.retries ?? null, repairs: (r?.log.repairs || []).map(x => ({ errorType: x.errorType, engine: x.engine, reason: x.reason, to: x.to })),
      initialSql: r?.log.initialSql || null, finalSql: r?.log.finalSql || null, resultNumbers: r ? resultNums(r).slice(0, 10) : [], check: r?.check });
    queueMonitor();
  }
  UI.testResult = { ranAt: new Date().toISOString(), engine: LLM.label(), semanticVersion: Sem.version, passed: cases.filter(c => c.pass).length, total: cases.length, cases };
  renderTestResult();
  UI.testing = false; $('#mon-test').disabled = false;
  syncDownloadButtons();
}
function renderTestResult() {
  const t = UI.testResult; if (!t) return;
  const all = t.passed === t.total;
  $('#mon-tests').innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">테스트 결과</h2><span class="small muted">${fmtTime(t.ranAt)} · ${escHtml(t.engine)}</span></div>
    <div class="notice ${all ? 'ok' : 'bad'}" style="margin-bottom:10px"><b>${t.passed} / ${t.total} 통과</b>${all ? '' : ' · 불일치한 행을 눌러 하네스 과정을 확인하세요'}</div>
    <div class="tbl-wrap"><table class="t"><thead><tr><th class="num">#</th><th>테스트</th><th>입력</th><th>기대값</th><th>실제값</th><th>통과</th></tr></thead><tbody>
    ${t.cases.map(c => `<tr class="${c.requestId ? 'click' : ''}" ${c.requestId ? `data-mon="${escHtml(c.requestId)}" tabindex="0"` : ''}><td class="num">${c.no}</td><td><b>${escHtml(c.name)}</b></td><td class="mono small">${escHtml(c.input)}</td><td class="small">${escHtml(c.expected)}</td><td class="small">${escHtml(c.actual)}</td><td>${c.pass ? '<span class="ok-t">통과</span>' : '<span class="bad-t">실패</span>'}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted" style="margin:8px 0 0">행을 누르면 아래 상세에서 그 실행의 하네스 과정을 봅니다.</p>`;
}

function selectLog(id) {
  UI.monSel = id; renderMonitor();
  $('#mon-detail').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
