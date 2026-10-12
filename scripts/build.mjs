// 배포 폴더(dist/) 조립: web/ 정적 파일 + dist/data(export-data 결과)
//  - dist/index.html : claude.ai 아티팩트용 본문 (문서 골격은 게시할 때 씌워짐)
//  - dist/local.html : 로컬 브라우저용 전체 문서 (npm run serve)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web'), OUT = path.join(ROOT, 'dist');

for (const f of ['data.js', 'data-watch.js', 'data-content.js']) {
  if (!fs.existsSync(path.join(OUT, 'data', f))) { console.error(`dist/data/${f} 가 없습니다. 먼저 npm run build:data 를 실행하세요.`); process.exit(1); }
}
for (const dir of ['js', 'vendor']) {
  fs.rmSync(path.join(OUT, dir), { recursive: true, force: true });
  fs.cpSync(path.join(WEB, dir), path.join(OUT, dir), { recursive: true });
}
// 팀 대시보드(문제 1)는 고객 키가 내장돼 저장소에 없다 — web/dashboard.html 에 넣어야 화면 왼쪽에 표시됨
const DASH = path.join(WEB, 'dashboard.html');
if (fs.existsSync(DASH)) fs.copyFileSync(DASH, path.join(OUT, 'dashboard.html'));
else console.warn('⚠ web/dashboard.html 이 없습니다. 팀 대시보드 HTML(문제 1 결과물)을 이 경로에 넣고 다시 빌드하세요. 에이전트 패널은 그대로 동작합니다.');

const css = fs.readFileSync(path.join(WEB, 'css', 'app.css'), 'utf8');
const page = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('/*@APP_CSS@*/', () => css);
fs.writeFileSync(path.join(OUT, 'index.html'), page);
fs.writeFileSync(path.join(OUT, 'local.html'), `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>[hidden]{display:none!important}</style></head><body>\n${page}\n</body></html>\n`);

const list = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? list(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const f of list(OUT)) console.log(path.relative(OUT, f).padEnd(28), (fs.statSync(f).size / 1e6).toFixed(2) + 'MB');
