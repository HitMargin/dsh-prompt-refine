/**
 * dsh-prompt-refine — 浏览器半边。
 *
 * 在输入框工具行左侧（`conversation.input.left`，权限控件同一组）挂一个「优化输入」按钮：
 * 点一下 → 把草稿里的需求交给模型改写 → 结果**原地写回输入框**，用户过目后自己发。
 *
 * 几点刻意的取舍：
 * - **不碰发送链路**。同类插件是在回合开始前偷偷改写用户消息（`agent/pre-step`），用户看不见
 *   也拦不住。这里反过来：改写只发生在用户点按钮的那一刻，且结果先落在输入框里。
 * - **写草稿走官方通道 `inputActions.setDraft()`**，写完验一眼 DOM，没跟上才补写。
 *   官方契约保证这是唯一的公开写入路径，但没保证它立刻刷新界面；这道校验让两种情况都对。
 * - **再点一次 = 撤回**。改写结果与原稿都记在本地，草稿仍停在改写结果上时再点一下即还原。
 *   这样"撤回"不依赖宿主历史，也不和输入框自带的 Ctrl+Z 打架。
 * - **只用主题变量**（--dsw-alias-*）着色，深浅色主题都跟着走。
 * - **只 require('react')**：React 由页面的模块表提供，避免打包出第二份。
 *
 * @module dsh-prompt-refine/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-refine',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 必须等于 host 包名：模块表按包身份对账。 */
    const name = 'dsh-prompt-refine'

    /** host 注册的改写路由，必须与 index.js 里的 ROUTE 一致。 */
    const ROUTE = '/plugins/dsh-prompt-refine/refine'

    /** 语言域命名空间。 */
    const NS = 'prompt-refine'

    /**
     * 客户端超时。宿主侧自己有 45 秒上限，这里留一点余量；超时就当"没人回音"，
     * 否则请求一卡住按钮会**永远**停在「优化中」。
     */
    const CLIENT_TIMEOUT_MS = 60000

    /** 「已优化」停留多久后回到常态。 */
    const FLASH_MS = 2600

    const DICT = {
      zh: {
        label: '优化输入',
        tooltip: '把草稿里的需求改写得更清楚、更具体',
        working: '优化中',
        done: '已优化',
        again: '再点一次可撤回',
        empty: '输入框是空的',
        failed: '优化失败',
        restored: '已还原原稿',
      },
      en: {
        label: 'Refine',
        tooltip: 'Rewrite the draft into a clearer, more specific request',
        working: 'Refining',
        done: 'Refined',
        again: 'Click again to undo',
        empty: 'The input is empty',
        failed: 'Refine failed',
        restored: 'Restored',
      },
    }

    const CSS = `
/*
 * 对齐 composer 工具行里同级控件的真实规范 —— 取自
 * dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css 的 .select
 * （Plan / Read-only / 模型选择用的就是它）：
 *
 *   height: 28px; padding: 0 20px 0 8px; border: none;
 *   border-radius: var(--dsw-radius-sm);
 *   color: var(--dsw-alias-label-secondary);
 *   font-size: 13px; line-height: 20px; font-weight: 500;
 *   @media (hover: hover) { :hover { background-color: ...bg-hover } }
 *
 * 关键是最后一条：**hover 只换背景色，不动文字颜色**。之前我多写了
 * color: label-primary 这一句，浅色主题下那就是深色，于是"鼠标移上去文字变黑"。
 * 字号/字重/行高当时也没跟上（12px、无 font-weight、line-height: 1），所以看着比邻居小一圈。
 *
 * 注意：这段是模板字符串，注释里不能出现反引号，否则字符串会被提前截断。
 */
.${NS}-root {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  outline: none;
  background-color: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  appearance: none;
  transition: background-color 120ms ease;
}
@media (hover: hover) {
  .${NS}-root:hover:not(:disabled) {
    background-color: var(--dsw-alias-interactive-bg-hover, transparent);
  }
}
.${NS}-root:active:not(:disabled) {
  background-color: var(--dsw-alias-interactive-bg-active, transparent);
}
.${NS}-root:disabled {
  cursor: default;
  opacity: 0.5;
}
/*
 * 成功 / 失败用"淡底色 + 文字着色"表达，不再改边框。
 * color-mix 不被支持时整条声明作废、回落到透明，不会留下半个样式。
 *
 * 注意这里**只改背景**，文字颜色只在非 hover 时着色：hover 一律让位给通用
 * 背景反馈，和同级控件"hover 只换背景"的行为保持一致。
 */
.${NS}-root[data-phase="done"],
.${NS}-root[data-phase="restored"] {
  color: var(--dsw-alias-state-success-primary, inherit);
  background-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, transparent) 14%, transparent);
}
.${NS}-root[data-phase="error"] {
  color: var(--dsw-alias-label-error, inherit);
  background-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, transparent) 14%, transparent);
}
@media (hover: hover) {
  .${NS}-root[data-phase="done"]:hover:not(:disabled),
  .${NS}-root[data-phase="restored"]:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, transparent) 22%, transparent);
  }
  .${NS}-root[data-phase="error"]:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, transparent) 22%, transparent);
  }
}
.${NS}-icon {
  flex: none;
  width: 14px;
  height: 14px;
}
.${NS}-icon[data-busy="true"] {
  animation: ${NS}-spin 900ms linear infinite;
}
.${NS}-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
@keyframes ${NS}-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .${NS}-icon[data-busy="true"] { animation: none; }
}
`

    /** 挂样式表，返回卸载函数。 */
    function mountStyles() {
      const id = `${NS}-style`
      const previous = document.getElementById(id)
      if (previous && typeof previous.remove === 'function') previous.remove()
      const tag = document.createElement('style')
      tag.id = id
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (typeof tag.remove === 'function') tag.remove()
        else if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    /**
     * 从"我自己"往上找输入卡片，再从卡片里取草稿。
     *
     * 优先用产品自己声明的 `data-composer-card`（精确、不靠猜），退回"往上找第一个含
     * contenteditable 的祖先"（不依赖任何产品类名）。两者都拿不到就返回空。
     *
     * @param {object|null} root 本插件根节点。
     * @returns {{ card: Element|null, editor: Element|null }}
     */
    function composerParts(root) {
      if (!root) return { card: null, editor: null }
      const declared = document.querySelectorAll('[data-composer-card]')
      let card = null
      for (const el of declared) {
        if (el.contains(root)) {
          card = el
          break
        }
      }
      if (!card) {
        let el = root
        while (el && el !== document.body) {
          if (el.querySelector && el.querySelector('[contenteditable="true"]')) {
            card = el
            break
          }
          el = el.parentElement
        }
      }
      const editor = card ? card.querySelector('[contenteditable="true"]') : null
      return { card, editor }
    }

    /** 读一个 contenteditable 里的纯文本（nbsp 归一成空格）。 */
    function readEditorText(editor) {
      if (!editor) return ''
      const raw = typeof editor.innerText === 'string' && editor.innerText.length > 0
        ? editor.innerText
        : (editor.textContent || '')
      return String(raw).replace(/\u00a0/g, ' ').trim()
    }

    /** 现读输入框里的字（DOM 里那一份，也就是用户看得见的这一份）。 */
    function draftFromDom(root) {
      return readEditorText(composerParts(root).editor)
    }

    /**
     * 直接写 contenteditable。最后一招。
     *
     * 只在官方通道不存在、或者官方通道写完界面没跟上时才用。它绕过了 input machine，
     * 所以提及块（chip）、附件这些富内容会被抹成纯文本 —— 这也是为什么它只是兜底。
     * 派发 `input` 事件是必须的：不派发，宿主状态还停在旧草稿上，
     * 用户按回车发出去的是原文，而界面上显示的是新文。
     *
     * @param {Element} editor contenteditable 元素。
     * @param {string} text 要写入的正文。
     * @returns {boolean} 是否写成功。
     */
    function writeEditor(editor, text) {
      try {
        editor.focus()
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(editor)
        selection.removeAllRanges()
        selection.addRange(range)
        const ok = typeof document.execCommand === 'function'
          && document.execCommand('insertText', false, text)
        if (!ok) editor.textContent = text
        editor.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        }))
        return true
      } catch {
        return false
      }
    }

    /**
     * 写回草稿：官方通道优先，写完**验一眼 DOM**，没跟上再补一次直接写入。
     *
     * 为什么要验：`inputActions.setDraft()` 是 DSH 契约里唯一的公开写入路径（走 input
     * machine 的单一事务入口，撤销栈、提及块、图片附件都对得上），但契约**没有保证它立刻
     * 把 contenteditable 刷成新文本** —— 已装的同类插件全都只在按下发送前调一次、紧接着
     * 就 `submit()`，从不观察界面，所以这一点在真机上是空白。
     *
     * 于是这里做成自愈的：写 → 读 DOM → 一致就收工，不一致就补写。两种情况都对：
     * 官方通道刷了界面，DOM 已经等于新文本，不会多写；没刷，就由这里补上。
     *
     * @param {object|null} root 本插件根节点。
     * @param {object|undefined} inputActions 官方输入动作面。
     * @param {string} text 要写入的正文。
     * @returns {boolean} 是否写成功（界面已经是这段文本）。
     */
    function applyDraft(root, inputActions, text) {
      const { editor } = composerParts(root)

      let touchedHost = false
      if (inputActions && typeof inputActions.setDraft === 'function') {
        try {
          inputActions.setDraft(text)
          touchedHost = true
        } catch {
          /* 官方通道自己炸了也还有 DOM 这条路 */
        }
      }

      if (readEditorText(editor) === text) return true
      if (!editor) return touchedHost
      return writeEditor(editor, text)
    }

    /**
     * 控件本体。
     *
     * @param {(key: string) => string} t 语言域绑定。
     * @returns {object} React 组件。
     */
    function makeControl(t) {
      return function RefineControl(props) {
        const { sessionId, inputActions } = props || {}

        const rootRef = React.useRef(null)
        const undoRef = React.useRef(null) // { original, refined }
        const [phase, setPhase] = React.useState('idle') // idle | working | done | error
        const [error, setError] = React.useState('')

        // 草稿一律**现读 DOM**，不订阅 `useInput`。两条理由：
        // 一是我只在按下按钮那一刻需要它，响应式订阅是多余的；
        // 二是 DOM 里那一份才是用户看得见的 —— 宿主状态在 IME 组字、粘贴等路径上可能落后一步，
        // 而"优化"必须作用于用户眼前这段文字。

        // 「已优化」/「已还原」停留一会儿就回到常态。
        React.useEffect(() => {
          if (phase !== 'done' && phase !== 'restored') return undefined
          const timer = setTimeout(() => setPhase('idle'), FLASH_MS)
          return () => clearTimeout(timer)
        }, [phase])

        // 换会话时清掉上一份"可撤回"记录：草稿换了，撤回基准就没意义了。
        React.useEffect(() => {
          undoRef.current = null
          setPhase('idle')
          setError('')
        }, [sessionId])

        const busy = phase === 'working'

        const onClick = React.useCallback(async () => {
          if (busy) return

          // 撤回优先：草稿仍停在上次的改写结果上时，再点一下就是还原原稿。
          const undo = undoRef.current
          const current = draftFromDom(rootRef.current)
          if (undo && current === undo.refined && current !== undo.original) {
            undoRef.current = null
            if (applyDraft(rootRef.current, inputActions, undo.original)) {
              setPhase('restored')
              setError('')
            } else {
              setPhase('error')
              setError(t('failed'))
            }
            return
          }

          const text = current.trim()
          if (text.length === 0) {
            setPhase('error')
            setError(t('empty'))
            return
          }

          setPhase('working')
          setError('')

          try {
            const controller = typeof AbortController === 'function' ? new AbortController() : null
            const timer = controller ? setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS) : null
            let payload = null
            try {
              const res = await fetch(ROUTE, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text }),
                cache: 'no-store',
                ...(controller ? { signal: controller.signal } : {}),
              })
              const data = await res.json().catch(() => null)
              if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
              payload = data
            } finally {
              if (timer) clearTimeout(timer)
            }

            if (!payload || payload.ok !== true) {
              throw new Error((payload && payload.error) || t('failed'))
            }

            // 宿主判定"改写结果像反问，保留原文"。这不是失败，是**没改** ——
            // 草稿一个字都没动，但要告诉用户为什么点了没反应。
            if (payload.changed === false
              && typeof payload.error === 'string' && payload.error.length > 0) {
              setPhase('error')
              setError(payload.error)
              return
            }

            const refined = typeof payload.text === 'string' ? payload.text : ''
            if (refined.trim().length === 0) throw new Error(t('failed'))
            if (refined === text) {
              // 没什么可优化的：不留撤回基准，也不报成功，免得用户以为界面坏了。
              setPhase('idle')
              return
            }

            if (!applyDraft(rootRef.current, inputActions, refined)) {
              throw new Error(t('failed'))
            }
            undoRef.current = { original: text, refined }
            setPhase('done')
          } catch (cause) {
            setPhase('error')
            setError(String((cause && cause.message) || cause || t('failed')))
          }
        }, [busy, inputActions, t])

        const text = busy ? t('working')
          : phase === 'done' ? t('done')
            : phase === 'restored' ? t('restored')
              : phase === 'error' ? t('failed')
                : t('label')

        const hint = phase === 'done' ? t('again')
          : phase === 'error' && error ? error
            : t('tooltip')

        return h('button', {
          ref: rootRef,
          type: 'button',
          className: `${NS}-root`,
          'data-phase': phase,
          'data-refine-owned': 'true',
          disabled: busy,
          title: hint,
          'aria-label': hint,
          onClick,
        },
          h('svg', {
            className: `${NS}-icon`,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.4',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            'aria-hidden': 'true',
            'data-busy': busy ? 'true' : 'false',
          },
          busy
            // 转圈：三段弧，转起来是个"正在处理"的环。
            ? h('circle', {
              cx: '8', cy: '8', r: '5.4', 'stroke-dasharray': '12 6', opacity: '0.9',
            })
            : h('path', { d: 'M8 1.6l1.5 3.9 3.9 1.5-3.9 1.5L8 12.4 6.5 8.5 2.6 7l3.9-1.5z' }),
          ),
          h('span', { className: `${NS}-text` }, text),
        )
      }
    }

    return {
      name,
      inject: ['slots', 'locale'],

      /**
       * 测试缝：样式表是"写错了也照样跑、只有肉眼能看出来"的那类代码
       * （多一条 border 就在输入框里显得格格不入），离线测不了渲染，但能测文本。
       * 浏览器端不读这个字段。
       */
      __internals: { CSS },

      /**
       * 客户端插件入口。
       *
       * @param {object} ctx 浏览器侧 cordis 上下文。
       */
      apply(ctx) {
        // HMR 会重跑 apply 而不先卸载旧实例：先拆掉上一份，避免 slot 重复注册。
        try {
          if (typeof window.__PROMPT_REFINE_DISPOSE__ === 'function') window.__PROMPT_REFINE_DISPOSE__()
        } catch {
          /* 旧实例已经烂了也不影响新实例 */
        }

        const disposers = []
        const own = (fn, label) => {
          const dispose = ctx.effect(fn, label)
          disposers.push(typeof dispose === 'function' ? dispose : () => {})
        }
        window.__PROMPT_REFINE_DISPOSE__ = () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              /* 逐个拆，坏一个不影响其余 */
            }
          }
        }

        own(() => ctx.locale.register(NS, DICT), `${NS}: dictionaries`)
        const t = ctx.locale.bind(NS)
        own(() => mountStyles(), `${NS}: styles`)
        // order 递增：权限控件在前，本按钮紧随其后 —— 也就是"输入框左边、权限设置右边"。
        own(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: NS,
          order: 20,
          label: () => t('label'),
        }, makeControl(t))), `${NS}: composer control`)
      },
    }
  },
})