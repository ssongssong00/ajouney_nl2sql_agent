// 브라우저 엔진(web/js/engine)을 Node vm 에서 sql.js(web/vendor)로 실행 — dist/data 가 필요 (npm run build:data)
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dist', 'data');
const VENDOR = path.join(ROOT, 'web', 'vendor');

let loaded = null;
module.exports = function loadEngine() {
  if (loaded) return loaded;
  // 저장소가 ESM("type": "module")이라 UMD 파일을 require 로 못 읽음 → CommonJS 래퍼로 직접 실행
  const file = path.join(VENDOR, 'sql-wasm.js'), mod = { exports: {} };
  vm.runInThisContext(`(function (module, exports, require, __dirname, __filename) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file })(mod, mod.exports, require, VENDOR, file);
  const initSqlJs = mod.exports;
  const ctx = { console, performance, setTimeout, Promise, Date, Math, JSON, Map, Set, TextEncoder };
  ctx.window = ctx;
  ctx.initSqlJs = () => initSqlJs({ locateFile: f => path.join(VENDOR, f) });
  // core.js 의 loadExtraTables 가 <script> 로 불러오는 파일을 바로 실행
  ctx.document = { createElement: () => ({}), head: { append(s) { vm.runInContext(fs.readFileSync(path.join(DATA, path.basename(s.src)), 'utf8'), ctx); s.onload(); } } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(DATA, 'data.js'), 'utf8'), ctx);
  const src = ['core.js', 'rag.js', 'agent.js'].map(f => fs.readFileSync(path.join(ROOT, 'web', 'js', 'engine', f), 'utf8')).join('\n');
  vm.runInContext(src + '\n;globalThis.__api = { initDb, loadExtraTables, Sem, runAgent, DB, validateSql, validateDefinition, guardedQuery, retrieve, sqlPrompt };', ctx, { filename: 'engine' });
  const A = ctx.__api;
  loaded = (async () => { await A.initDb(); await new Promise(r => A.loadExtraTables(r)); A.Sem.init(ctx.SEM.items); return A; })();
  return loaded;
};
