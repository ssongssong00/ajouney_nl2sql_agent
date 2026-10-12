'use strict';
/* =====================================================================
 * ui/main.js — 패널 열기·탭·폭 · 상태 표시 · 에이전트 엔진 불러오기 · 이벤트 연결 · 시작
 *  대시보드를 먼저 띄우고, 에이전트 엔진(sql.js · 데이터 · engine/*.js)은 그 뒤에 불러온다
 * ===================================================================== */

/* ---------------------------------------------------------------------
 * 패널 열기 · 닫기 · 넓게
 * ------------------------------------------------------------------- */
function setOpen(open) {
  UI.open = open;
  $('#agent').hidden = !open;
  $('#agent-tab').hidden = open;
  $('#agent-tab').setAttribute('aria-expanded', String(open));
  prefs.set('ajouney.agentOpen', open ? '1' : '0');
  if (open) { renderPills(); if (UI.tab === 'chat') $('#chat-input').focus({ preventScroll: true }); else renderMonitor(); }
}
// 모니터링 탭은 표·SQL 비교가 들어가므로 항상 넓게, 챗봇 탭은 사용자가 고른 폭
function applyWide() {
  const wide = UI.widePref || UI.tab === 'mon';
  $('#agent').classList.toggle('wide', wide);
  $('#agent-wide').setAttribute('aria-pressed', String(wide));
  $('#agent-wide').title = wide ? '패널 좁게' : '패널 넓게';
  $('#agent-wide').hidden = UI.tab === 'mon';
}
function setWide(wide) { UI.widePref = wide; prefs.set('ajouney.agentWide', wide ? '1' : '0'); applyWide(); }
function setTab(tab) {
  UI.tab = tab === 'mon' ? 'mon' : 'chat';
  for (const [t, view] of [['chat', 'view-chat'], ['mon', 'view-mon']]) { $('#' + view).hidden = UI.tab !== t; $('#tab-' + t).setAttribute('aria-selected', String(UI.tab === t)); }
  $('#agent-reset').hidden = UI.tab !== 'chat';
  applyWide();
  if (UI.tab === 'mon') renderMonitor();
}

/* ---------------------------------------------------------------------
 * 상태 표시: 엔진 준비 · LLM · 로그 저장소
 * ------------------------------------------------------------------- */
function renderPills() {
  const box = $('#pills'); if (!box) return;
  if (UI.failed) { box.innerHTML = `<span class="pill bad"><span class="dot"></span>${escHtml(UI.failed)}</span>`; return; }
  if (!UI.ready) { box.innerHTML = `<span class="pill warn"><span class="dot"></span>에이전트 준비 중 · ${escHtml(UI.progress)}</span>`; return; }
  // 실제 호출 결과까지 반영: 사용 가능 여부만 보면 호출이 매번 실패해도 초록으로 남는다
  const [llmTone, llmText] = !LLM.fn ? ['warn', '템플릿 모드 (Claude 연결 없음)']
    : LLM.denied ? ['warn', `템플릿 모드 (Claude 사용 거절됨: ${LLM.lastError || ''})`]
    : UI.llmLast && !UI.llmLast.ok ? ['bad', `Claude 호출 실패 (${UI.llmLast.code}) → 템플릿으로 대체`]
    : UI.llmLast?.ok ? ['ok', 'Claude 로 SQL 생성'] : ['ok', 'Claude 사용 가능 · 첫 질문 때 확인'];
  box.innerHTML = `<span class="pill ${llmTone}" title="${escHtml(LLM.lastError || '')}"><span class="dot"></span>${escHtml(llmText)}</span>
    <span class="pill ${DB.loading.size ? 'warn' : 'ok'}" title="${escHtml([...DB.loaded].join(', '))}"><span class="dot"></span>DB ${DB.loaded.size}/${META.tables.length}${DB.loading.size ? ' 적재 중' : ''}</span>
    <span class="pill ${Store.lastError ? 'bad' : Store.db ? 'ok' : 'warn'}" title="${escHtml(Store.lastError || '')}"><span class="dot"></span>로그 ${Store.db ? '저장' : '이 탭에만'}</span>
    ${UI.sample ? `<button type="button" class="btn ghost sm" data-act="llm-check" ${UI.checking ? 'disabled' : ''}>Claude 연결 확인</button>` : ''}`;
}


/* ---------------------------------------------------------------------
 * 에이전트 엔진 불러오기: 대시보드가 뜬 뒤 sql.js → 데이터 → core/rag/agent.js 순서
 * ------------------------------------------------------------------- */
function loadScript(src) {
  return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error(`${src} 를 불러오지 못했습니다`)); document.body.append(s); });
}
// claude.ai 아티팩트는 외부 CDN 에서 스크립트 외 파일(.wasm)을 막으므로 sql.js 를 같이 게시한 파일에서 받고,
// wasm 을 못 쓰는 환경이면 순수 JS(asm.js) 빌드로 대체한다. core.js 는 window.initSqlJs() 를 인자 없이 호출.
function wrapSqlInit() {
  const wasmInit = window.initSqlJs;
  window.initSqlJs = () => {
    // wasm 이 막히면 sql.js 가 거절 없이 멈추는 경우가 있어 사전 검사 + 15초 제한
    const tryWasm = typeof WebAssembly === 'object' ? new Promise((ok, fail) => {
      setTimeout(() => fail(new Error('wasm 초기화 시간 초과')), 15000);
      try { wasmInit({ locateFile: f => 'vendor/' + f }).then(ok, fail); } catch (e) { fail(e); }
    }) : Promise.reject(new Error('WebAssembly 없음'));
    return tryWasm.catch(async e => {
      console.warn('sql.js wasm 실패 → asm.js 로 대체', e);
      UI.progress = '호환 모드 DB 여는 중'; renderPills();
      await loadScript('vendor/sql-asm.js');
      return window.initSqlJs();
    });
  };
}

async function connectClaude() {
  const c = window.claude;
  if (!c?.use) return;
  const [sample, db, downloads] = await Promise.all(['sample', 'db', 'downloads'].map(n => c.use(n).catch(() => null)));
  if (sample) {
    UI.sample = sample;
    // 호출마다 성공·실패를 기록해 상태 표시에 반영 (agent.js 의 LLM.json 은 fn.json 만 부른다)
    LLM.fn = {
      json: async (prompt, opts) => {
        try { const v = await sample.json(prompt, opts); UI.llmLast = { ok: true, code: null }; renderPills(); return v; }
        catch (e) { UI.llmLast = { ok: false, code: e?.code || 'error' }; renderPills(); throw e; }
      },
    };
  }
  if (db) {
    // 하네스 로그·RAG 검색 로그를 공유 DB 에 저장하고, 모니터링 탭은 공유 로그(최근 300건)를 구독
    Store.db = db;
    Store.subscribe('logs', 'tsNum', 300);
    UI.logsShared = true;
  }
  UI.downloads = downloads || null;
  renderPills(); syncDownloadButtons(); queueMonitor();
}

async function startEngine() {
  const step = m => { UI.progress = m; renderPills(); };
  try {
    step('DB 엔진 불러오는 중');
    await loadScript('vendor/sql-wasm.js'); wrapSqlInit();
    step('고객 데이터 불러오는 중');
    await loadScript('data/data.js');
    for (const f of ['core.js', 'rag.js', 'agent.js']) await loadScript('js/engine/' + f);
    await initDb(step);
    Sem.init(window.SEM.items);
    Store.listeners.add(col => { if (col === 'error') renderPills(); if (col === 'logs') queueMonitor(); });
  } catch (e) {
    console.error(e);
    UI.failed = `에이전트를 준비하지 못했습니다: ${e?.message || e}. 새로고침해 주세요.`;
    renderPills(); queueMonitor();
    for (const [, fail] of UI.readyWaiters.splice(0)) fail(new Error(UI.failed));
    return;
  }
  UI.ready = true; renderPills();
  $('#mon-test').disabled = false; queueMonitor();
  for (const [ok] of UI.readyWaiters.splice(0)) ok();
  connectClaude();
  loadExtraTables(() => renderPills(), () => renderPills());
}

/* ---------------------------------------------------------------------
 * 시작
 * ------------------------------------------------------------------- */
function bind() {
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-q],[data-tab],[data-monf],[data-mon],[data-act]'); if (!t) return;
    if (t.dataset.act === 'llm-check') checkClaude();
    else if (t.dataset.q) ask(t.dataset.q);
    else if (t.dataset.tab) setTab(t.dataset.tab);
    else if (t.dataset.monf) { UI.monFilter = UI.monFilter === t.dataset.monf ? null : t.dataset.monf; renderMonitor(); }
    else if (t.dataset.mon) selectLog(t.dataset.mon);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset?.mon) selectLog(e.target.dataset.mon); });
  $('#mon-test').addEventListener('click', runHarnessTests);
  $('#mon-log-dl').addEventListener('click', e => saveJson(`ajouney-harness-logs-${stamp()}.json`, exportLogs(), e.currentTarget));
  $('#mon-test-dl').addEventListener('click', e => saveJson(`ajouney-harness-test-${stamp()}.json`, UI.testResult, e.currentTarget));
  $('#agent-tab').addEventListener('click', () => setOpen(true));
  $('#agent-close').addEventListener('click', () => setOpen(false));
  $('#agent-wide').addEventListener('click', () => setWide(!$('#agent').classList.contains('wide')));
  $('#agent-reset').addEventListener('click', () => { if (!UI.busy) resetChat(); });
  $('#chat-form').addEventListener('submit', e => { e.preventDefault(); const q = $('#chat-input').value; $('#chat-input').value = ''; ask(q); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && UI.open && window.innerWidth < 1100) setOpen(false); });
}

(function boot() {
  bind(); resetChat();
  UI.widePref = prefs.get('ajouney.agentWide') === '1';
  const monitorLink = location.hash === '#monitor';   // 링크 끝에 #monitor 를 붙이면 모니터링 탭으로 연다
  setTab(monitorLink ? 'mon' : 'chat');
  const saved = prefs.get('ajouney.agentOpen');
  setOpen(monitorLink || (saved === null ? window.innerWidth >= 1100 : saved === '1'));
  renderPills();
  // 대시보드가 먼저 그려지도록, iframe 로드가 끝난 뒤(최대 4초 대기) 에이전트 엔진을 불러온다
  let started = false; const go = () => { if (!started) { started = true; startEngine(); } };
  $('#dash-frame').addEventListener('load', () => setTimeout(go, 300), { once: true });
  setTimeout(go, 4000);
})();
