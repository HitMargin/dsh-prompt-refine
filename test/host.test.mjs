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

const { apply, ROUTE, BUILTIN_PROMPT, looksRoleReversed } = await import('../index.js');

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

/* ── 8. 角色反转：改写结果像助手在反问用户 ───────────────────────────── */

{
  // 真实事故：用户需求被改写成"请告诉我你需要什么"，发出去对方只会回
  // "你这句话像是模板提示语"。原话必须留在输入框里。
  const llm = makeLlm('请告诉我你需要优化成什么，比如要写什么、在哪里用、希望得到什么形式的结果。');
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const original = '你好，帮我把登录页的报错文案改清楚一点';
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ text: original }))]), {
    headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
    method: 'POST',
  });
  const { status, json } = await call(routes.get(ROUTE), req);

  assert.equal(status, 200, '角色反转是"没改"而不是 HTTP 失败');
  assert.equal(json.ok, true);
  assert.equal(json.changed, false, '不应标记为已改写');
  assert.equal(json.text, original, '必须把原话原样返回，一个字都不能动');
  assert.ok(typeof json.error === 'string' && json.error.length > 0, '应带原因说明');
  assert.equal(llm.calls.length, 2, '应重试一次：首轮 + 追加硬性约束的一轮');
  ok('改写结果像反问 → 重试后仍不合格则保留原文');
}

/* ── 9. 首轮反转、重试合格 → 正常改写 ──────────────────────────────── */

{
  let n = 0;
  const llm = {
    calls: [],
    stream: async function* (call) {
      n += 1;
      this.calls.push(call);
      yield { type: 'text-delta', text: n === 1
        ? '请问你需要我做什么？'
        : '把登录页密码错误提示改成「密码不正确，请重新输入」。' };
    },
  };
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const req = Object.assign(Readable.from([Buffer.from('{"text":"改一下登录页报错"}')]), {
    headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
    method: 'POST',
  });
  const { json } = await call(routes.get(ROUTE), req);

  assert.equal(json.changed, true, '重试合格应采纳');
  assert.ok(json.text.includes('密码不正确'), '应采纳重试后的结果');
  assert.equal(llm.calls.length, 2, '首轮 + 重试，共两次');
  assert.ok(llm.calls[1].system.length > llm.calls[0].system.length, '重试应追加硬性约束');
  ok('首轮反转、重试合格 → 采纳重试结果');
}

/* ── 10. 正常改写不受影响（不能因为加了兜底就误伤） ───────────────── */

{
  const good = '把登录页密码错误提示改成「密码不正确，请重新输入」。';
  const llm = makeLlm(good);
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const req = Object.assign(Readable.from([Buffer.from('{"text":"改一下登录页报错"}')]), {
    headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
    method: 'POST',
  });
  const { json } = await call(routes.get(ROUTE), req);

  assert.equal(json.ok, true);
  assert.equal(json.changed, true);
  assert.equal(json.text, good, '正常改写应原样采纳，一次调用');
  assert.equal(llm.calls.length, 1, '不该触发重试');
  ok('正常改写一次通过，不误伤');
}

/* ── 11. 判定函数本身 ──────────────────────────────────────────────── */

{
  const reversed = [
    '请告诉我你需要优化成什么',
    '请问你需要我做什么？',
    '你希望我帮你做点什么',
    '我可以帮你改这段代码',
    '如果你还需要什么，随时告诉我',
    '作为 AI 助手，我建议你先明确目标',
    // 元指令形态：把用户的话反转成"让助手去面对用户"。
    '向用户发送一句问候语，内容为你好。',
    '给用户回复一句问候',
    '请向用户说明这个改动的影响',
  ];
  for (const s of reversed) {
    assert.equal(looksRoleReversed(s), true, `应判定为反转: ${s}`);
  }

  // 正常需求里出现"你"不该被误伤 —— 这是最容易写错的地方。
  const fine = [
    '帮我在登录页加个提示：密码错误时告诉用户「密码不正确」',
    '把「提交」按钮改成「保存并继续」，位置不变',
    '优化首页加载速度，首屏要在 1 秒内出来',
    '给用户一个开关，让他们能自己关掉这个提示',
    // 行首是"给用户"但后面不是"发送/回复/说"—— 是正常的需求，不能误伤。
    '给用户一个批量导入的入口',
    '你好',
  ];
  for (const s of fine) {
    assert.equal(looksRoleReversed(s), false, `不应判定为反转: ${s}`);
  }
  ok(`角色反转判定：${reversed.length} 条命中、${fine.length} 条正常需求不误伤`);
}

/* ── 12. 实际事故：发「你好」被改写成「向用户发送一句问候语」 ─────── */

{
  // 用户的原话只有两个字，改写器却把它反转成"指挥助手去面对用户"的元指令。
  // 发出去模型只会回一句问候 —— 用户的需求（打招呼）被掉了个方向。
  const llm = makeLlm('向用户发送一句问候语，内容为你好。');
  const { ctx, routes } = makeCtx({ llm, selection: { provider: 'p', model: 'm' } });
  apply(ctx);

  const original = '你好';
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ text: original }))]), {
    headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
    method: 'POST',
  });
  const { status, json } = await call(routes.get(ROUTE), req);

  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.changed, false, '不能采纳元指令');
  assert.equal(json.text, original, '必须把「你好」原样留下');
  ok('发「你好」被改写成元指令 → 原样保留原文');
}

console.log('\n全部通过');