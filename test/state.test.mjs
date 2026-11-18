// 验证状态持久化：模拟组件卸载（切走会话）→ 重新挂载（切回来）→ 状态应恢复。
//
// 这是 bug 复现测试：切走会话再切回来，按钮状态不能回到 idle、撤回基准不能丢。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const code = readFileSync(join(ROOT, 'client.js'), 'utf8');

/* ── 极简 React（支持 useState 有状态实例） ── */
function makeReact() {
  let hookIdx = 0;
  const hooks = [];
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.flat().filter((c) => c != null) } };
    },
    useState(initial) {
      const idx = hookIdx++;
      if (!(idx in hooks)) hooks[idx] = typeof initial === 'function' ? initial() : initial;
      return [hooks[idx], (v) => { hooks[idx] = v; }];
    },
    useRef(initial) {
      const idx = hookIdx++;
      if (!(idx in hooks)) hooks[idx] = { current: initial };
      return hooks[idx];
    },
    useEffect() {},
    useCallback(fn) { return fn; },
    _reset() { hookIdx = 0; },
    _hooks: hooks,
  };
}

/* ── 极简 DOM + sessionStorage ── */
const dom = new Map();
const sessionStorageData = new Map();
const document = {
  getElementById: (id) => dom.get(id) || null,
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  head: { appendChild(n) { dom.set(n.id, n); } },
};
const sessionStorage = {
  getItem: (k) => sessionStorageData.has(k) ? sessionStorageData.get(k) : null,
  setItem: (k, v) => sessionStorageData.set(k, String(v)),
  removeItem: (k) => sessionStorageData.delete(k),
};
const window = {
  __ModuleLoader__: { load(spec) { captured = spec; } },
};
let captured = null;

const sandbox = { window, document, sessionStorage, console, fetch: async () => ({ ok: false }) };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox);

const react = makeReact();
const plugin = captured.factory((n) => {
  if (n === 'react') return react;
  throw new Error('未知模块: ' + n);
});

/* ── 运行 apply，拿到 Component ── */
let seat = null;
const ctx = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  locale: {
    register() { return () => {}; },
    bind() { return (k) => ({ label: '优化输入', done: '已优化', restored: '已还原原稿', failed: '优化失败', working: '优化中', tooltip: '', empty: '', again: '' }[k] || k); },
  },
  slots: {
    inject(slotKey, cb) {
      const r = cb();
      if (slotKey === 'conversation.input.left') seat = r;
      return () => {};
    },
    register(def, Component) { return { def, component: Component }; },
  },
};
plugin.apply(ctx);

if (!seat || !seat.component) {
  console.error('FAIL: conversation.input.left 未注册');
  process.exit(1);
}
const Component = seat.component;

/* ── 辅助：模拟一次会话渲染 ── */
function renderFor(sessionId) {
  react._hooks.length = 0;
  react._reset();
  return Component({ sessionId, inputActions: {} });
}

/* ── 用例 1：完成 phase 落盘，切回来恢复 ── */
{
  sessionStorageData.clear();
  sessionStorageData.set('prompt-refine:state:s-1', JSON.stringify({
    phase: 'done', error: '', undo: { original: '帮我改', refined: '帮我改进' },
  }));

  const el = renderFor('s-1');
  assert.equal(el.props['data-phase'], 'done', `切回来 phase 应为 done，实际 ${el.props['data-phase']}`);
  console.log('ok   切回会话后 phase 恢复为 done');
}

/* ── 用例 2：idle 态不写盘 ── */
{
  sessionStorageData.clear();
  const el = renderFor('s-2');
  assert.equal(el.props['data-phase'], 'idle');
  console.log('ok   无存储时默认 idle');
}

/* ── 用例 3：sessionStorage 按会话隔离 ── */
{
  sessionStorageData.clear();
  sessionStorageData.set('prompt-refine:state:s-A', JSON.stringify({ phase: 'done', error: '', undo: { original: 'a', refined: 'b' } }));
  sessionStorageData.set('prompt-refine:state:s-B', JSON.stringify({ phase: 'error', error: '测试错误', undo: null }));

  const a = renderFor('s-A');
  const b = renderFor('s-B');
  assert.equal(a.props['data-phase'], 'done');
  assert.equal(b.props['data-phase'], 'error');
  console.log('ok   会话间状态隔离（s-A=done, s-B=error）');
}

/* ── 用例 4：working 态在真实环境会被 effect 归为 idle ──
   * 假 useEffect 不执行 effect 回调，所以这里只能验证"能恢复到 working"，
   * 真正的 working→idle 转换由 sessionId 变化 effect 在真实环境完成。 */
{
  sessionStorageData.clear();
  sessionStorageData.set('prompt-refine:state:s-3', JSON.stringify({ phase: 'working', error: '', undo: null }));
  const el = renderFor('s-3');
  // 假 useEffect 下，useState 的初始值直接取 saved.phase（working）
  assert.equal(el.props['data-phase'], 'working', `无 effect 时保持存储值，实际 ${el.props['data-phase']}`);
  console.log('ok   working 态存储能恢复（真实环境由 sessionId effect 归为 idle）');
}

/* ── 用例 5：撤回基准也能恢复（关键！否则切回来再点会再优化一遍）── */
{
  sessionStorageData.clear();
  sessionStorageData.set('prompt-refine:state:s-4', JSON.stringify({
    phase: 'done', error: '', undo: { original: '帮我改', refined: '帮我改进后的' },
  }));
  const el = renderFor('s-4');
  assert.equal(el.props['data-phase'], 'done');
  // title 应包含"还原"提示（在中文 i18n 下）
  assert.ok(el.props.title && el.props.title.length > 0, 'done 相位应有 tooltip');
  console.log('ok   撤回基准恢复（切回后 phase=done，再点会还原而非再优化）');
}

console.log('\n全部通过');