// clean() 行为验证：走真实路由，让假模型分别输出围栏/引号/混合形态。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pr-clean-'));

const { apply, ROUTE } = await import('../index.js');

const cases = [
  { raw: '```text\n优化后的需求```', want: '优化后的需求', label: '围栏' },
  { raw: '"```优化后的需求```"', want: '优化后的需求', label: '引号包围栏' },
  { raw: '"优化后的需求"', want: '优化后的需求', label: '引号' },
  { raw: "'优化后的需求'", want: '优化后的需求', label: '单引号' },
  { raw: '他说"你好"之后离开了', want: '他说"你好"之后离开了', label: '正文中引号不动' },
  { raw: '  优化后的需求  ', want: '优化后的需求', label: '首尾空白' },
];

let bad = 0;
for (const c of cases) {
  const routes = new Map();
  const ctx = {
    get(name) {
      if (name === 'llm') return { stream: async function* () { yield { type: 'text-delta', text: c.raw }; } };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return null;
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject(s, cb) {
      const child = { webServer: { register(def) { routes.set(def.path, def.handler); return () => {}; } } };
      cb(child);
      return { dispose: () => {} };
    },
    logger() { return { info() {} }; },
  };
  apply(ctx);
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ text: '帮我改' }))]), {
    headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
    method: 'POST',
  });
  const res = { statusCode: 0, body: '', writeHead() {}, end(b) { if (b) this.body += b; } };
  await routes.get(ROUTE)(req, res);
  const json = JSON.parse(res.body);
  const got = json.changed ? json.text : '(原样保留)';
  const verdict = got === c.want ? 'ok   ' : 'FAIL ';
  if (got !== c.want) bad += 1;
  console.log(verdict + c.label.padEnd(14) + ' → ' + JSON.stringify(got));
}
console.log(bad ? '\n有失败项' : '\n全部通过');
process.exit(bad ? 1 : 0);