# Ajouney+ 고객 여정 에이전트

OTT AJOU 고객 여정 대시보드(문제 1) 위에, 업무 용어로 질문하면 SQL을 만들어 답하는 NL2SQL 에이전트(문제 2)를 얹은 웹 앱입니다. 서버 없이 브라우저 안에서 동작하고, claude.ai 아티팩트로 배포합니다.

- 화면: 대시보드가 전체 화면을 쓰고, 오른쪽 "AI 에이전트" 패널에서 **챗봇**과 **하네스 모니터링** 탭을 씁니다.
- SQL 생성: claude.ai 아티팩트 안에서는 Claude가, Claude를 쓸 수 없을 때는 규칙 기반 템플릿 모드가 시맨틱 레이어의 계산식·조건 조각으로 SQL을 만듭니다. 미리 저장된 완성 쿼리로 답하지 않습니다.
- 하네스: 생성된 SQL을 실행 전에 검증(위험 명령·테이블·컬럼·JOIN·타입·실행 계획)하고, 오류가 나면 수정해 재실행(최대 2회)하며, 모든 단계를 로그로 남깁니다.

## 폴더 구조

```
data/                       빌드 입력
  metadata.json               팀 2-1 테이블·컬럼 메타데이터
  semantic_layer.json         팀 2-2 시맨틱 레이어 (원본)
  semantic_supplement.json    팀 파일에 없는 지표·용어 보충
  semantic_overrides.json     대시보드 v9 · 발표 PDF 숫자에 맞춘 보정 (예: D+22~28 유지율 48.9%)
  csv/                        원천 CSV 7종 (git 제외, 직접 넣음)
scripts/
  build-db.mjs                CSV → .build/ott.db (PK·FK 검증, 고객 여정 파생 테이블)
  semantic-adapter.mjs        팀 시맨틱 레이어 → 에이전트 정의 목록 변환
  export-data.mjs             ott.db + 정의 → dist/data/*.js (브라우저용 데이터)
  build.mjs                   web/ + dist/data → dist/ 조립
  serve.mjs                   로컬 확인용 정적 서버
web/
  index.html                  화면 틀 (CSS 는 빌드 때 인라인)
  css/app.css                 디자인 토큰 · 컴포넌트 (라이트/다크)
  dashboard.html              팀 대시보드 v9 (iframe 으로 표시) — git 제외, 직접 넣음
  js/engine/                  에이전트 엔진 — 로딩 순서 core → rag → agent
    core.js                     브라우저 SQLite 적재 · SQL 검증 · 읽기 전용 실행
    rag.js                      로그 저장소 · 시맨틱 정의 · 정의 검증 · RAG 검색(BM25 + 별칭)
    agent.js                    프롬프트 · 템플릿 모드 · 하네스 반복 · 로그 저장
  js/ui/                      화면 — 로딩 순서 common → chat → monitor → main
    common.js                   DOM 도구 · 화면 상태 · 결과 렌더 조각
    chat.js                     챗봇 · 답변 카드 · Claude 연결 확인
    monitor.js                  하네스 모니터링 · 테스트 실행 · 로그 내려받기
    main.js                     패널 · 상태 표시 · 엔진 불러오기 · 시작
  vendor/                     sql.js 1.13.0 (wasm + asm.js 대체 빌드)
tests/
  engine.cjs                  엔진을 Node 에서 실행하는 로더
  agent.test.cjs              회귀 테스트 32개
```

## 빌드와 실행

Node.js 22.5 이상이 필요합니다(`node:sqlite` 사용). 외부 npm 패키지는 쓰지 않습니다.

저장소에 없는 입력 두 가지를 먼저 넣습니다(둘 다 고객 단위 데이터라 git 에서 제외).
- `data/csv/` — 원천 CSV 7종 (user_dim, payment_fact, behavior_fact, watch_daily_fact, user_content_summary, content_dim, content_genre_bridge)
- `web/dashboard.html` — 팀 대시보드 v9 HTML (없으면 에이전트 패널만 동작)

```bash
npm run build:db -- "<CSV 폴더>"   # CSV 7종 → .build/ott.db (생략 시 data/csv)
npm run build:data                 # .build/ott.db → dist/data/data.js · data-watch.js · data-content.js
npm run build                      # dist/ 조립
npm run serve                      # http://localhost:8765/local.html
npm test                           # 회귀 테스트 (dist/data 필요)
```

로컬에서는 Claude 호출과 공유 로그 저장이 없어 템플릿 모드로 동작합니다. 둘 다 claude.ai 아티팩트 런타임(`sample`, `db`, `downloads` 기능)에서만 켜집니다.

## claude.ai 아티팩트로 배포

`dist/index.html`을 페이지로, 나머지 `dist/` 파일을 같은 경로로 함께 게시합니다. 이때 `sample`·`db`·`downloads` 기능을 선언해야 합니다.

- `js/engine/*`, `js/ui/*`, `vendor/*`, `data/*`, `dashboard.html`
- 아티팩트는 외부 CDN에서 스크립트 외 파일을 막으므로, sql.js의 `.wasm`도 같이 게시합니다. WebAssembly가 막힌 환경에서는 `sql-asm.js`로 자동 대체합니다.

## 질문 처리 흐름

1. **요청 안전성:** 데이터 변경·삭제 요청은 바로 차단합니다.
2. **Context 검색:** 관련 정의(최대 6개)와 의존 정의, 테이블·컬럼, JOIN 관계를 고르고, "20대" 같은 세그먼트 값을 DB 실제 코드로 확인합니다.
3. **데이터 가용성:** 원천이 없는 지표(캠페인 반응률 등)는 숫자를 만들지 않습니다.
4. **SQL 생성:** Claude 또는 템플릿 모드가 만듭니다. 프롬프트에는 계산식·조건 조각만 넘기고 완성 SELECT 문은 넘기지 않습니다.
5. **검증 → 실행:** 토큰 검사, SQLite 컴파일, 실행 계획 검사를 거쳐 읽기 전용으로 실행합니다(최대 5,000행, 8초).
6. **자동 수정:** 실패하면 수정 후 재검증·재실행합니다(최대 2회). 위험 SQL은 수정하지 않고 차단합니다.
7. **답변·로그:** 핵심 답변, 차트·표, 분석 기준, SQL·검증 과정, 검색된 정의를 보여 주고 Request ID 단위로 로그를 남깁니다.

## 데이터 정책

- 원천 CSV, `ott.db`, 생성된 `dist/`, 팀 대시보드 HTML(고객 키 5만 개 내장)은 모두 고객 단위 데이터를 담고 있어 저장소에 올리지 않습니다(`.gitignore`).
- 로그 미리보기에서는 `user_key`·`payment_key` 값을 마스킹합니다.

## 알려진 한계

- **Claude 호출:** claude.ai에서 `upstream_error`로 간헐적으로 실패합니다. 실패하면 템플릿 모드로 대체하고 답변에 표시합니다. 패널의 "Claude 연결 확인"으로 원인을 가릴 수 있습니다.
- **필터 인식:** 검색된 차원 정의 안에서만 세그먼트 값을 확인합니다. 그래서 "20대 iOS"처럼 차원이 둘인 질문에서 하나(iOS)가 빠질 수 있습니다.
- **템플릿 모드 범위:** 계산식 조각 하나와 그룹·필터 조합까지만 만듭니다. 조인이나 정렬·상위 N이 필요한 질문(장르별 TOP 10 등)은 Claude가 필요합니다.
- **팀 원본 문서 누락:** 팀 원본 시맨틱 레이어의 정의 13개에 설명·기간·단위 등 문서 필드가 비어 있습니다. 목록은 `tests/agent.test.cjs`의 `KNOWN_DOC_GAPS`에 있습니다.
- **행동 로그 미적재:** 행동 로그(`behavior_fact`, 45만 행)는 브라우저에 올리지 않습니다. 행동 지표는 고객 여정 테이블의 파생 컬럼으로만 답합니다.
- **쿼리 중단 불가:** SQL은 화면과 같은 스레드에서 실행되므로, 첫 행이 나오기 전에 오래 걸리는 쿼리는 중간에 멈출 수 없습니다.
