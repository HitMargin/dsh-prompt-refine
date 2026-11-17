// 离线冒烟测试：把浏览器半边在 Node 里跑一遍。
//
// 它能抓到"`node --check` 抓不到"的三类错：
//   1. factory 体本身抛异常（顶层语法之外的运行时错误）；
//   2. apply() 里注册形状写错（ctx.slots / ctx.locale / ctx.effect 用错）；
//   3. 组件渲染时崩（prop 名字写错、hook 用错、变量未定义）。
//
// 它不验证真实 DOM 行为（那要浏览器），但把这三类错误挡在重启之前。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let loaded = null;
const windowStub = {
  __ModuleLoader__: { load: (def) => { loaded = def; } },
};

// ── 极简 React：够跑一次渲染 ──────────────────────────────────────────────
// 状态队列让测试能**指定**本次渲染看到的相位，从而真正走到每个分支
// （busy 的转圈图标、done/restored 的绿色、error 的红色文案）。
const stateQueue = [];
let renderCount = 0;
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => {
    renderCount += 1;
    const value = stateQueue.length > 0
      ? stateQueue.shift()
      : (typeof initial === 'function' ? initial() : initial);
    return [value, () => {}];
  },
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
};

// ── 极简 DOM：够 mountStyles 与 composerParts 不炸 ────────────────────────
const makeEl = () => ({
  id: '', textContent: '', style: {},
  remove() {}, appendChild() {}, querySelector: () => null,
  contains: () => false, parentElement: null,
});
const documentStub = {
  head: { appendChild() {} },
  body: makeEl(),
  getElementById: () => null,
  createElement: () => makeEl(),
  querySelectorAll: () => [],
  execCommand: () => false,
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  require: (name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  },
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  InputEvent: class {},
  Node: class {},
  URL,
};
sandbox.globalThis = sandbox;

vm.runInNewContext(code, sandbox, { filename: 'client.js' });

const fail = (msg) => { console.error('FAIL ' + msg); process.exitCode = 1; };
const ok = (msg) => console.log('ok   ' + msg);

// 1. 模块外壳
if (!loaded) { fail('__ModuleLoader__.load 没被调用'); process.exit(1); }
if (loaded.id !== 'dsh-prompt-refine') fail(`id 应为包名，实际 ${loaded.id}`);
else ok('模块 id 正确');

const plugin = loaded.factory((n) => {
  if (n === 'react') return ReactStub;
  throw new Error('unexpected require: ' + n);
});

if (!plugin || typeof plugin !== 'object') fail('factory 没返回对象');
if (plugin.name !== loaded.id) fail(`插件 name 必须与包名一致：${plugin.name}`);
if (!Array.isArray(plugin.inject)) fail('inject 必须是数组');
if (typeof plugin.apply !== 'function') fail('apply 必须是函数');
ok(`插件对象形状正确（name=${plugin.name}, inject=[${plugin.inject}]）`);

// 2. apply：注册路径
const registered = [];
let stylesMounted = false;
let registeredDict = null;
const ctx = {
  effect(fn, label) {
    const dispose = fn();
    if (label && label.includes('styles')) stylesMounted = true;
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: {
    // 记下注册的字典，让 bind 返回的 t() 能真查到中文，而不是回显 key。
    register: (ns, dict) => { registeredDict = dict; return () => {}; },
    bind: () => (key) => (registeredDict && registeredDict.zh && registeredDict.zh[key]) || key,
  },
  slots: {
    inject(name, cb) {
      const result = cb();
      registered.push({ name, result });
      return () => {};
    },
    register(def, component) {
      return { def, component };
    },
  },
};

try {
  plugin.apply(ctx);
  ok('apply() 未抛异常');
} catch (error) {
  fail('apply() 抛异常: ' + error.message);
  process.exit(1);
}

const seat = registered.find((r) => r.name === 'conversation.input.left');
if (!seat) fail('没注册到 conversation.input.left');
else ok('已注册到 conversation.input.left');

if (seat && (!seat.result || typeof seat.result.component !== 'function')) {
  fail('register 第二个参数不是组件函数');
}
if (!stylesMounted) fail('样式没挂载');

// 3. 组件渲染：逐相位强制状态，确认每个分支都不炸、文案对得上。
if (seat) {
  const Component = seat.result.component;
  const props = {
    sessionId: 'session-test',
    inputActions: { setDraft() {}, submit() {} },
  };

  /** 取渲染树里按钮上那行可见文字。 */
  const labelOf = (el) => {
    const span = (el.children || []).find((c) => c && c.props && c.props.className === 'prompt-refine-text');
    return span ? span.children[0] : undefined;
  };

  const cases = [
    ['idle', '', '优化输入'],
    ['working', '', '优化中'],
    ['done', '', '已优化'],
    ['restored', '', '已还原原稿'],
    ['error', '模型没有返回内容', '优化失败'],
  ];

  for (const [phase, error, expected] of cases) {
    stateQueue.length = 0;
    stateQueue.push(phase, error); // 组件里 useState 的顺序：phase、error
    try {
      const el = Component(props);
      if (!el || typeof el !== 'object') throw new Error('返回的不是元素');
      const actual = labelOf(el);
      const busy = phase === 'working';
      if (actual !== expected) throw new Error(`文案应为「${expected}」，实际「${actual}」`);
      if (el.props.disabled !== busy) throw new Error(`disabled 应为 ${busy}，实际 ${el.props.disabled}`);
      if (el.props['data-phase'] !== phase) throw new Error(`data-phase 应为 ${phase}`);
      const icon = (el.children || []).find((c) => c && c.props && c.props.className === 'prompt-refine-icon');
      const shape = icon && (icon.children || [])[0];
      if (busy && (!shape || shape.type !== 'circle')) throw new Error('busy 时应画转圈的 circle');
      if (!busy && (!shape || shape.type !== 'path')) throw new Error('常态时应画星形的 path');
      ok(`渲染 ${phase.padEnd(9)} 通过（文案「${actual}」，disabled=${el.props.disabled}）`);
    } catch (error) {
      fail(`渲染 ${phase} 失败: ${error.message}`);
    }
  }
}

console.log(process.exitCode ? '\n有失败项' : '\n全部通过');