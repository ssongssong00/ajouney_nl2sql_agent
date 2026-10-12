'use strict';
/* =====================================================================
 * ui/chat.js — AI 에이전트 챗봇: 예시 질문 · 질문 실행 · 답변 카드 · Claude 연결 확인
 * ===================================================================== */

// 대시보드 화면의 숫자를 바로 검증·심화하는 질문 + 문제 2-4 필수 질문
const QUESTION_GROUPS = [
  ['대시보드 숫자 확인', [
    'D+30 결제 전환율은 얼마야?', '초기 미시청률은 얼마야?', '결제 후 22~28일 사이 시청 유지율은 얼마인가요?',
    '우선 타깃 1위 고객은 몇 명이고 푸시 도달 규모는?', '선택 피로 방랑 유저는 몇 명이고, 푸시 도달 가능한 고객은 몇 명인가요?',
  ]],
  ['세그먼트 비교 · 추이', [
    '20대 고객의 초기 미시청률은?', '요금제별 초기 미시청률과 결제 고객 수를 비교해줘', '연령대별 D+30 결제 전환율을 보여줘',
    '가입 기기별 결제 전환율을 비교해주세요', '콘텐츠 장르별 시청자 수 TOP 10', '가입일별 가입자 수 추이를 보여줘',
  ]],
  ['데이터 한계 · 안전', ['캠페인 반응률 알려줘', '평균 시청시간은 얼마야?', '미결제 고객 데이터를 전부 삭제해줘']],
];

function welcome() {
  return html(`<div class="a-card welcome" id="chat-welcome"><h2>무엇이 궁금하세요?</h2>
    <p>시맨틱 레이어의 지표 정의로 SQL 을 만들고, 하네스가 안전성을 검사한 뒤 읽기 전용으로 실행해 답합니다. 답변마다 계산 기준과 SQL 을 함께 보여 줍니다.</p>
    ${QUESTION_GROUPS.map(([g, qs]) => `<div class="grp">${escHtml(g)}</div><div class="chips">${qs.map(q => `<button type="button" class="chip q" data-q="${escHtml(q)}">${escHtml(q)}</button>`).join('')}</div>`).join('')}</div>`);
}
function resetChat() { $('#chat-list').replaceChildren(welcome()); }

/* ---------------------------------------------------------------------
 * 질문 → 에이전트 실행 → 답변 카드
 * ------------------------------------------------------------------- */
async function ask(question) {
  question = String(question || '').trim();
  if (!question || UI.busy) return;
  if (!UI.open) setOpen(true);
  UI.busy = true; $('#chat-send').disabled = true;
  $('#chat-welcome')?.remove();
  const list = $('#chat-list');
  const bubble = html(`<div class="q-bubble">${escHtml(question)}</div>`);
  list.append(bubble);
  const pending = html(`<div class="a-card"><div class="thinking"><span class="spin"></span><span>${UI.ready ? '정의 검색 → SQL 생성 → 검증 → 읽기 전용 실행 중' : '데이터를 준비하는 중입니다. 준비되면 바로 답합니다'}</span></div></div>`);
  list.append(pending); pending.scrollIntoView({ block: 'end', behavior: 'smooth' });
  try {
    await whenReady();
    const res = await runAgent(question, { source: 'chat' });
    if (res.duplicate) { pending.innerHTML = `<div class="notice warn">${escHtml(res.message)}</div>`; return; }
    const prev = UI.runs.get(nq(question));
    const card = answerCard(res, prev);
    pending.replaceWith(card);
    UI.runs.set(nq(question), snapshotRun(res));
    bubble.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (e) {
    console.error(e);
    pending.innerHTML = `<div class="notice bad">답하지 못했습니다: ${escHtml(e?.message || e)}. 질문을 바꾸거나 잠시 뒤 다시 시도하세요.</div>`;
  } finally {
    UI.busy = false; $('#chat-send').disabled = false; renderPills();
  }
}

function snapshotRun(res) {
  return { version: res.log.semanticVersion, defs: (res.rag?.semanticMeta || []).map(m => m.id), sql: res.log.finalSql || res.log.initialSql || '', row0: res.answer?.rows?.[0] || null, at: res.log.ts };
}
// 같은 질문을 다시 물었을 때: 정의 버전 · 검색 결과 · SQL · 첫 행 변화
function compareHtml(prev, cur) {
  if (!prev) return '';
  const add = cur.defs.filter(d => !prev.defs.includes(d)), del = prev.defs.filter(d => !cur.defs.includes(d));
  const sqlChanged = prev.sql !== cur.sql, rowChanged = JSON.stringify(prev.row0) !== JSON.stringify(cur.row0);
  if (prev.version === cur.version && !add.length && !del.length && !sqlChanged && !rowChanged) return `<p class="small muted">이전 실행(${fmtTime(prev.at)})과 결과가 같습니다.</p>`;
  return `<details class="box"><summary>이전 실행과 비교 (${fmtTime(prev.at)})</summary><ul class="clean small">
    <li>정의 버전 <code>${escHtml(prev.version)}</code> → <code>${escHtml(cur.version)}</code></li>
    ${add.length ? `<li>검색에 추가된 정의: ${add.map(d => `<code>${escHtml(d)}</code>`).join(' ')}</li>` : ''}${del.length ? `<li>검색에서 빠진 정의: ${del.map(d => `<code>${escHtml(d)}</code>`).join(' ')}</li>` : ''}
    <li>SQL ${sqlChanged ? '<span class="bad-t">바뀜</span>' : '같음'} · 결과 첫 행 ${rowChanged ? '<span class="bad-t">바뀜</span>' : '같음'}</li></ul>${sqlChanged ? lineDiff(fmtSql(prev.sql), fmtSql(cur.sql)) : ''}</details>`;
}

function answerCard(res, prev) {
  const { log, answer: a = {}, status } = res;
  const ok = ['success', 'repaired'].includes(status);
  const card = html('<article class="a-card"></article>');
  let n = 0; const sec = (title, body, extra = '') => `<section class="sec"><div class="sec-h"><span class="n">${++n}</span>${title}${extra}</div>${body}</section>`;
  const top = `<div class="a-top"><div class="row">${statusTag(status)}<span class="tag">${log.generator === 'llm' ? 'Claude 생성' : log.generator === 'template' ? '템플릿 모드' : '생성 없음'}</span>${log.retries ? `<span class="tag ok2">자동 수정 ${log.retries}회</span>` : ''}</div><span class="small muted mono" title="${escHtml(log.requestId)}">${Math.round(log.durationMs)}ms</span></div>`;

  // ① 핵심 답변
  let s1 = `<p class="summary">${escHtml(a.summary || '')}</p>`;
  if (a.kpis?.length) s1 += `<div class="kpis">${a.kpis.map(k => `<div class="kpi"><div class="l">${escHtml(k.label)}</div><div class="v">${k.value === null ? '계산 불가' : fmtNum(k.value) + (/_pct$/.test(k.label) ? '%' : '')}</div></div>`).join('')}</div>`;
  if (a.insights?.length) s1 += `<ul class="clean">${a.insights.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>`;
  if (!ok) {
    if (a.reason) s1 += `<p class="sub">사유: ${escHtml(a.reason)}</p>`;
    if (a.needs?.length) s1 += `<div class="notice warn"><b>답하려면 필요한 것</b><ul class="clean">${a.needs.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul></div>`;
    if (a.proxy) s1 += `<p class="sub">${escHtml(a.proxy)}</p>`;
    if (a.blockedSql) s1 += sqlBlock(a.blockedSql);
  }
  // Claude 호출이 실패해 템플릿으로 대체된 답변: 이유를 밝히고 다시 시도할 수 있게
  const llmErr = log.llmError || log.repairs.find(r => r.llmError)?.llmError;
  const fallback = llmErr ? `<div class="notice warn small" style="margin-bottom:8px">Claude 호출이 실패해(<code>${escHtml(llmErr)}</code>) ${log.llmError ? 'SQL 을 템플릿 모드로 만들었습니다' : '자동 수정을 규칙 기반으로 처리했습니다'}. <button type="button" class="btn sm" data-q="${escHtml(log.question)}">Claude 로 다시 시도</button> <button type="button" class="btn ghost sm" data-act="llm-check">연결 확인</button></div>` : '';
  let body = fallback + sec('핵심 답변', s1 + compareHtml(prev, snapshotRun(res)));

  // ② 분석 결과
  if (ok) {
    let s2 = chartHtml(a) + `<div style="margin-top:10px">${dataTable(a.columns, a.rows)}</div>`;
    if (a.cautions?.length) s2 += `<div class="notice warn" style="margin-top:10px"><b>해석 시 주의</b><ul class="clean">${a.cautions.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul></div>`;
    if (a.next_actions?.length) s2 += `<div class="notice ok" style="margin-top:8px"><b>다음 행동 제안</b><ul class="clean">${a.next_actions.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul></div>`;
    body += sec('분석 결과', s2, ` <span class="muted small">${a.rowCount.toLocaleString()}행${a.truncated ? ' (일부)' : ''}</span>`);
  }
  // ③ 적용된 분석 기준
  const b = a.basis;
  if (b) {
    const row = (k, v) => v && (!Array.isArray(v) || v.length) ? `<dt>${k}</dt><dd>${Array.isArray(v) ? v.map(escHtml).join('<br>') : escHtml(v)}</dd>` : '';
    body += sec('적용된 분석 기준', `<dl class="basis">${row('지표', b.metric)}${row('계산식', b.formula)}${row('분자', b.numerator)}${row('분모', b.denominator)}${row('기간', b.period)}${row('차원', b.dimensions)}${row('필터', b.filters)}${row('집계 단위', [b.grain, b.unit].filter(Boolean).join(' · '))}${row('가정', b.assumptions)}${row('주의', b.cautions)}${b.definitions_used?.length ? `<dt>사용한 정의</dt><dd>${b.definitions_used.map(d => `<code>${escHtml(d)}</code>`).join(' ')}</dd>` : ''}</dl>`);
  }
  // ④ SQL · 하네스 검증
  const sqlShown = log.finalSql || log.initialSql;
  body += sec('SQL · 하네스 검증', `${sqlShown ? sqlBlock(sqlShown) : '<p class="sub">실행한 SQL 이 없습니다.</p>'}
    <details class="box"><summary>검증 단계 ${log.stages.length}개 · 시도 ${log.attempts.length}회</summary>${timeline(log.stages)}
    ${log.repairs.map(r => `<h3>수정 #${r.attempt} (${r.engine === 'llm' ? 'LLM' : '규칙 기반'}) · ${escHtml(r.errorType)}</h3><p class="small">${escHtml(r.reason)}</p>${r.to ? lineDiff(fmtSql(r.from), fmtSql(r.to)) : ''}`).join('')}
    ${log.attempts.length ? `<h3>마지막 시도의 검증 항목</h3>${checkList(log.attempts[log.attempts.length - 1].validation.checks)}` : ''}</details>`);
  // ⑤ Context (RAG 검색)
  if (res.rag) body += sec('검색된 정의 (RAG Context)', ragHtml(res.rag));
  card.innerHTML = top + body;
  return card;
}

function ragHtml(rag) {
  const max = Math.max(...rag.ranking.map(r => r.score), 1);
  return `<div class="chips" style="margin-bottom:8px">${(rag.semanticMeta || []).map(m => `<span class="tag ${m.type}" title="${escHtml(m.reason || '')}">${escHtml(m.name)}${m.expanded ? ' (의존)' : ''}</span>`).join('') || '<span class="sub">선택된 정의 없음</span>'}</div>
  <p class="small sub">테이블 ${rag.tables.map(t => `<code>${escHtml(t.name)}</code>`).join(' ')}${rag.filters?.length ? ` · 필터 ${rag.filters.map(f => f.verified ? `<code>${escHtml(f.condition)}</code>` : `${escHtml(f.label)}(DB에 없음)`).join(', ')}` : ''}</p>
  <details class="box"><summary>검색 순위 · 점수</summary><div class="tbl-wrap"><table class="t"><thead><tr><th class="num">#</th><th>항목</th><th>점수</th><th>선택</th></tr></thead><tbody>
    ${rag.ranking.slice(0, 15).map(r => `<tr class="${r.selected ? 'sel' : ''}"><td class="num">${r.rank ?? '-'}</td><td><span class="tag ${r.kind}">${escHtml(r.kind)}</span> ${escHtml(r.label)}</td><td><div class="row nowrap"><span class="scorebar grow"><i style="width:${(100 * r.score / max).toFixed(0)}%"></i></span><span class="small mono">${r.score}</span></div></td><td>${r.selected ? '<span class="ok-t">✓</span>' : ''}</td></tr>`).join('')}</tbody></table></div></details>
  <details class="box"><summary>LLM 에 전달한 Context (${rag.context.length.toLocaleString()}자)</summary><pre class="sql ctx">${escHtml(rag.context)}</pre></details>`;
}

/* ---------------------------------------------------------------------
 * Claude 연결 확인: 짧은 텍스트 → 짧은 JSON → 실제 SQL 생성 요청 순서로 보내 어디서 실패하는지 가린다
 * ------------------------------------------------------------------- */
async function checkClaude() {
  if (!UI.sample || UI.checking) return;
  UI.checking = true; renderPills();
  setTab('chat'); $('#chat-welcome')?.remove();
  const card = html('<article class="a-card"><div class="a-top"><b>Claude 연결 확인</b><span class="small muted"></span></div><div class="checks"></div><div class="concl" style="margin-top:10px"></div></article>');
  card.querySelector('.a-top .muted').textContent = fmtTime(new Date().toISOString());
  $('#chat-list').append(card); card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const rowsBox = card.querySelector('.checks');
  const limits = await UI.sample.limits?.().catch(() => null);
  const steps = [
    ['짧은 텍스트 (quick)', async () => `응답 "${(await UI.sample('연결 확인입니다. OK 라고만 답하세요.', { modelTier: 'quick', cache: false })).text.trim().slice(0, 40)}"`],
    ['짧은 JSON (default)', async () => `응답 ${JSON.stringify(await UI.sample.json('다음 JSON 객체 하나만 그대로 답하세요: {"ok": true}', { modelTier: 'default', cache: false })).slice(0, 60)}`],
    ['실제 SQL 생성 요청 (default)', async () => {
      await whenReady();
      const q = '초기 미시청률은 얼마야?', prompt = sqlPrompt(q, retrieve(q));
      const bytes = new TextEncoder().encode(prompt).length;
      const v = await UI.sample.json(prompt, { modelTier: 'default', cache: false });
      return `프롬프트 ${bytes.toLocaleString()}바이트${limits ? ` (한도 ${limits.maxPromptBytes.toLocaleString()})` : ''} · SQL ${String(v?.sql || '(없음)').slice(0, 140)}`;
    }],
  ];
  const res = [];
  for (const [name, fn] of steps) {
    const row = html(`<div class="check"><span class="i"><span class="spin" style="display:inline-block;width:12px;height:12px"></span></span><span class="nm2">${escHtml(name)}</span><span class="dt">요청 중</span></div>`);
    rowsBox.append(row);
    const t0 = performance.now();
    try {
      const detail = await fn();
      row.className = 'check ok'; row.querySelector('.i').textContent = '✓';
      row.querySelector('.dt').textContent = `${detail} · ${Math.round(performance.now() - t0)}ms`;
      res.push({ ok: true });
    } catch (e) {
      const code = e?.code || 'error';
      if (['not_granted', 'sampling_disabled', 'capability_disabled', 'capability_removed', 'not_declared'].includes(code)) { LLM.denied = true; LLM.lastError = code; }
      row.className = 'check no'; row.querySelector('.i').textContent = '✗';
      row.querySelector('.dt').textContent = `${code}${e?.message ? ` — ${e.message}` : ''} · ${Math.round(performance.now() - t0)}ms`;
      res.push({ ok: false, code });
    }
  }
  UI.llmLast = res[2].ok ? { ok: true, code: null } : { ok: false, code: res[2].code };
  const [a, , c] = res;
  const concl = c.ok ? ['ok', 'Claude 호출이 정상입니다. 다음 질문부터 Claude 가 SQL 을 만듭니다.']
    : !a.ok ? ['bad', `짧은 요청도 실패했습니다(${a.code}). 에이전트 문제가 아니라 이 환경(플랫폼·계정)에서 지금 Claude 호출이 안 되는 상태입니다. 잠시 뒤 다시 확인하거나 claude.ai 의 다른 기능에서 Claude 가 응답하는지 확인해 주세요. 그동안은 템플릿 모드로 답합니다.`]
    : ['warn', `짧은 요청은 되는데 실제 SQL 생성 요청이 실패했습니다(${c.code}). 에이전트의 요청 형식 문제이므로 이 결과를 알려 주시면 프롬프트·호출 방식을 고치겠습니다.`];
  card.querySelector('.concl').innerHTML = `<div class="notice ${concl[0]}">${escHtml(concl[1])}</div>`;
  UI.checking = false; renderPills();
}
