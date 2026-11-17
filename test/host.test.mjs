// 宿主半边的端到端测试：apply() → webServer 路由 → llm 调用 → JSON 响应。
//
// 这条链路正是"点一下按钮，草稿被改写"真正走的那条路。用假 ctx 把它整体跑一遍，
// 能在重启 DSH 之前证明：路由注册得上、模型调用参数对、异常路径不吞消息。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// 让提示词播种落在临时目录，别在测试里写用户的真实 home。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'prompt-refine-test-'));

const { apply, ROUTE, BUILTIN_PROMPT } = await import('../index.js');

const ok = (msg) => console.log('ok   ' + msg);

/** 假的 llm 服务：把收到的调用记下来，回一段固定改写结果。 */
function makeLlm(refined, behaviour = 'ok') {
  const calls = [];
  return {
    calls,
    stream: async function* (call) {
      calls.push(call);
      if (behaviour === 'throw') throw new Error('上游 429：配额耗尽');
      if (behaviour === 'empty') return;
      yield { type: 'text-delta', text: refined };
    },
  };
}

/** 假的 agentDefaultModel：返回当前选中的模型路由。 */
const makeModelService = (selection) => ({
  currentSelection: () => selection,
});

/**
 * 组装一个最小 cordis 上下文。
 * @param {object} opts `{ llm, selection }`。
 */
function makeCtx(opts) {
  const routes = new Map();
  const ctx = {
    get(name) {
      if (name === 'llm') return opts.llm || null;
      if (name === 'agentDefaultModel') return makeModelService(opts.selection);
      return null;
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject(services, callback) {
      const child = {
        webServer: {
          register(def) {
            routes.set(def.path, def.handler);
            return () => routes.delete(def.path);
          },
        },
      };
      const dispose = callback(child);
      return { dispose: typeof dispose === 'function' ? dispose : () => {} };
    },
    logger: () => ({ info() {} }),
  };
  return { ctx, routes };
}

/** 造一个假的 POST 请求。 */
function post(body) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
    method: 'POST',
  });
  return req;
}

/** 造一个假的响应对象。 */
function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

/** 调一次路由，返回 `{ status, json }`。 */
async function call(handler, req) {
  const res = fakeRes();
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON 响应保持 null */ }
  return { status: res.statusCode, json };
}

/* ── 1. 正常路径：改写成功 ─────────────────────────────────────────────── */

{
  const REFINED = '做一个登录页面：包含账号、密码输入框与登录按钮；提交时校验非空，不通过时在输入框下方给出红色提示；后端先本地模拟。';
  const llm = makeLlm(REFINED);
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'deepseek', model: 'v4' } });

  apply(ctx);

  assert.ok(routes.has(ROUTE), '路由没注册上');
  ok(`路由已注册：${ROUTE}`);

  const { status, json } = await call(routes.get(ROUTE), post({ text: '帮我搞个登录页面' }));

  assert.equal(status, 200, `状态码应为 200，实际 ${status}`);
  assert.equal(json.ok, true, 'ok 应为 true');
  assert.equal(json.changed, true, 'changed 应为 true');
  assert.equal(json.text, REFINED, '改写结果应原样回传');
  ok(`改写成功：${json.text.slice(0, 18)}…`);

  assert.equal(llm.calls.length, 1, '应只调一次模型');
  const call1 = llm.calls[0];
  assert.equal(call1.provider, 'deepseek');
  assert.equal(call1.model, 'v4');
  assert.equal(call1.messages[0].content[0].text, '帮我搞个登录页面', '用户原文应完整传给模型');
  assert.equal(call1.system, BUILTIN_PROMPT, 'system 应是内置改写指令');
  assert.equal(call1.purpose, 'prompt-refine');
  ok('模型参数正确（provider/model/messages/system/purpose）');
}

/* ── 2. 空草稿 → 400，且绝不调用模型 ───────────────────────────────────── */

{
  const llm = makeLlm('x');
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const { status, json } = await call(routes.get(ROUTE), post({ text: '   ' }));
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.equal(llm.calls.length, 0, '空草稿不该花一次模型调用');
  ok('空草稿 → 400，且不调模型');
}

/* ── 3. 模型报错 → ok:false，错误原因透传 ──────────────────────────────── */

{
  const llm = makeLlm('', 'throw');
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const { status, json } = await call(routes.get(ROUTE), post({ text: '写个脚本' }));
  assert.equal(status, 200, '业务失败用 200 + ok:false，浏览器半边才读得到原因');
  assert.equal(json.ok, false);
  assert.match(json.error, /429/);
  assert.equal(json.text, '');
  ok('模型报错 → ok:false，原因透传（429）');
}

/* ── 4. 模型吐空 → 明确报错，不把空串写回输入框 ───────────────────────── */

{
  const llm = makeLlm('', 'empty');
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const { json } = await call(routes.get(ROUTE), post({ text: '写个脚本' }));
  assert.equal(json.ok, false);
  assert.match(json.error, /没有返回内容/);
  ok('模型吐空 → 明确报错，绝不把空串写回输入框');
}

/* ── 5. 没有可用模型路由 → 提示先选模型 ───────────────────────────────── */

{
  const llm = makeLlm('x');
  const { ctx, routes } = makeCtx({ llm, selection: {} });
  apply(ctx);

  const { json } = await call(routes.get(ROUTE), post({ text: '写个脚本' }));
  assert.equal(json.ok, false);
  assert.match(json.error, /没有可用模型路由/);
  ok('没有模型路由 → 提示先选模型');
}

/* ── 6. 跨站请求必须拒绝 ─────────────────────────────────────────────── */

{
  const llm = makeLlm('x');
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const req = Object.assign(Readable.from([Buffer.from('{"text":"hi"}')]), {
    headers: { 'sec-fetch-site': 'cross-site' },
    method: 'POST',
  });
  const { status } = await call(routes.get(ROUTE), req);
  assert.equal(status, 403);
  assert.equal(llm.calls.length, 0, '跨站请求不该触发模型调用');
  ok('跨站写请求 → 403');
}

/* ── 7. 非 POST → 405 ───────────────────────────────────────────────── */

{
  const llm = makeLlm('x');
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const req = Object.assign(Readable.from([]), { headers: {}, method: 'GET' });
  const { status } = await call(routes.get(ROUTE), req);
  assert.equal(status, 405);
  ok('GET → 405');
}

console.log('\n全部通过');