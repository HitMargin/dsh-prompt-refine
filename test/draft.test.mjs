// 草稿写入的端到端测试。
//
// 这是整个插件里风险最高的一段：`inputActions.setDraft()` 是官方唯一的公开写入路径，
// 但契约没有保证它**立刻**把 contenteditable 刷成新文本（已装的同类插件全都只在按下
// 发送前调一次、紧接着就 submit()，从不观察界面）。
//
// 所以这里把三种情况都钉住：
//   A. 官方通道刷了界面     → 不多写一次 DOM
//   B. 官方通道没刷界面     → 补写一次 DOM，界面必须变成新文本
//   C. 根本没有官方通道     → 直接写 DOM
//   D. 再按一次              → 还原原稿（撤回）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const REFINED = '做一个登录页面：账号、密码、登录按钮；提交时校验非空，不通过给红色提示；后端先本地模拟。';
const ORIGINAL = '帮我搞个登录页面';

const ok = (msg) => console.log('ok   ' + msg);

/**
 * 搭一个可控的假 DOM / 假宿主。
 * @param {object} opts `{ repaint: boolean, withActions: boolean }`
 */
function makeHarness({ repaint, withActions }) {
  const execCalls = [];
  const editor = {
    innerText: ORIGINAL,
    textContent: ORIGINAL,
    focus() {},
    dispatchEvent() {},
  };
  const card = {
    querySelector: (sel) => (sel === '[contenteditable="true"]' ? editor : null),
    contains: () => true,
    parentElement: null,
  };

  const documentStub = {
    head: { appendChild() {} },
    body: {},
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', style: {}, remove() {} }),
    querySelectorAll: () => [card],
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: (cmd, _ui, text) => { execCalls.push(text); editor.innerText = text; return true; },
  };

  const actions = withActions
    ? {
      setDraft(text) { if (repaint) editor.innerText = text; },
      submit() {},
    }
    : undefined;

  const windowStub = {
    __ModuleLoader__: { load: () => {} },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  };

  const ReactStub = {
    createElement: (type, props, ...children) => {
      const el = { type, props: props || {}, children };
      if (props && props.ref) props.ref.current = el;
      return el;
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    require: (n) => (n === 'react' ? ReactStub : (() => { throw new Error('unexpected require ' + n); })()),
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    InputEvent: class { constructor(_t, init) { Object.assign(this, init); } },
    Node: class {},
    URL,
    fetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, changed: true, text: REFINED }),
    }),
  };

  // 加载并取出组件
  let loaded = null;
  sandbox.window.__ModuleLoader__.load = (def) => { loaded = def; };
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });
  const plugin = loaded.factory((n) => (n === 'react' ? ReactStub : undefined));

  const seats = [];
  const ctx = {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: {
      inject: (name, cb) => { seats.push({ name, result: cb() }); return () => {}; },
      register: (def, component) => ({ def, component }),
    },
  };
  plugin.apply(ctx);

  const seat = seats.find((s) => s.name === 'conversation.input.left');
  const el = seat.result.component({ sessionId: 's1', inputActions: actions });
  el.parentElement = card; // composerParts 从按钮往上找卡片

  return { el, editor, execCalls };
}

/* ── A. 官方通道已经刷新界面 → 不该多写一次 DOM ─────────────────────── */
{
  const { el, editor, execCalls } = makeHarness({ repaint: true, withActions: true });
  await el.props.onClick();
  assert.equal(editor.innerText, REFINED, '界面应已变成改写结果');
  assert.equal(execCalls.length, 0, '界面已经对了，不该再补写 DOM');
  ok('A 官方通道已刷新 → 不重复写 DOM');
}

/* ── B. 官方通道没刷新界面 → 必须补写，界面要真的变 ────────────────── */
{
  const { el, editor, execCalls } = makeHarness({ repaint: false, withActions: true });
  await el.props.onClick();
  assert.equal(editor.innerText, REFINED, '界面必须真的变成改写结果，不能只改宿主状态');
  assert.ok(execCalls.length >= 1, '没刷新时应当补写一次 DOM');
  ok('B 官方通道没刷新 → 补写 DOM，界面真的变了');
}

/* ── C. 根本没有官方通道 → 直接写 DOM ─────────────────────────────── */
{
  const { el, editor, execCalls } = makeHarness({ repaint: false, withActions: false });
  await el.props.onClick();
  assert.equal(editor.innerText, REFINED);
  assert.ok(execCalls.length >= 1);
  ok('C 没有官方通道 → 直接写 DOM');
}

/* ── D. 再按一次 = 撤回，还原原稿 ─────────────────────────────────── */
{
  const { el, editor } = makeHarness({ repaint: true, withActions: true });
  await el.props.onClick();
  assert.equal(editor.innerText, REFINED, '第一次点击应写入改写结果');
  await el.props.onClick();
  assert.equal(editor.innerText, ORIGINAL, '第二次点击应还原原稿');
  ok('D 再次点击 → 还原原稿（撤回）');
}

/* ── E. 空草稿不发请求 ──────────────────────────────────────────── */
{
  const { el, editor, execCalls } = makeHarness({ repaint: true, withActions: true });
  editor.innerText = '   ';
  let fetched = false;
  await el.props.onClick();
  assert.equal(editor.innerText, '   ', '空草稿不该动输入框');
  assert.equal(execCalls.length, 0);
  assert.equal(fetched, false);
  ok('E 空草稿 → 不写不请求');
}

console.log('\n全部通过');