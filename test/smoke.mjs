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

/* ── 样式与同级控件的一致性 ──
 * 这些是"写错了也照样跑、只有肉眼能看出来"的约束：
 * 多一条 border，按钮就在 composer 那一排无边框图标里像块贴上去的胶囊。
 */
{
  const css = plugin.__internals && plugin.__internals.CSS;
  if (typeof css !== 'string' || css.length === 0) {
    fail('__internals.CSS 缺失，无法校验样式');
  } else {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里提到的 border 不算
    // `border: none` 是我们要的（无边框），只有"真的画了一道线"才该被拦下。
    // 注意别用 `border\s*:\s*(?!none)` 这种写法：正则回溯会让 `border: none` 也命中
    // （\s* 可以少吃一个空格，让否定预查在 " none" 上成功）。
    const shorthand = [...bare.matchAll(/border\s*:\s*([^;}]+)/gi)]
      .map((m) => m[1].trim().toLowerCase())
      .filter((v) => v.length > 0);
    const drewShorthand = shorthand.some((v) => v !== 'none');
    const drewSide = /border-(top|right|bottom|left|color|width)\s*:/i.test(bare);
    if (drewShorthand || drewSide) {
      fail(`不应再出现描边（border: ${shorthand.join(', ')}）—— 同级控件都是无边框的`);
    } else {
      ok('无边框（与 composer 工具行的同级控件一致）');
    }

    if (!/height:\s*28px/.test(bare)) fail('高度应为 28px，与同级控件对齐');
    else ok('高度 28px，与同级控件一致');

    if (!/font:\s*inherit/.test(bare)) fail('应继承宿主字体（font: inherit）');
    else ok('字体继承宿主（font: inherit）');

    for (const token of ['interactive-bg-hover', 'interactive-bg-active', 'label-secondary']) {
      if (!css.includes(`--dsw-alias-${token}`)) fail(`缺少主题变量 --dsw-alias-${token}`);
    }
    ok('配色全部走 --dsw-alias-* 主题变量（深浅色主题都会跟随）');

    // 成功/失败靠淡底色表达，而不是描边 —— 描边上面已经禁掉了。
    if (!/data-phase="done"[\s\S]{0,140}color-mix/.test(bare)) fail('done 相位应有淡底色反馈');
    else ok('成功/失败相位用淡底色反馈（不依赖边框）');
  }
}

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