/**
 * dsh-prompt-refine — 宿主半边。
 *
 * 只做两件事，都是无状态的：
 *
 * 1. **改写**：拿浏览器的请求，调一次模型，把用户草稿里的需求重写得更清楚、更具体、
 *    可直接执行。返回改写后的正文，**不碰任何会话状态、不动消息**。
 * 2. **路由**：`POST /plugins/dsh-prompt-refine/refine` 暴露上面那件事给浏览器半边。
 *
 * 刻意的取舍：
 * - **不挂 `agent/pre-step`**。同类插件是在回合开始前偷偷改写用户消息，用户看不见也拦不住。
 *   这里反过来：改写只发生在用户**按下按钮**的那一刻，结果先写回输入框，用户过目后自己发。
 * - **模型调用一律走 `ctx.get('llm')` 惰性获取**。宿主没装这个服务就当没有，回落到报错，
 *   绝不裸访问 `ctx.llm`（那会抛 `cannot get property ... without inject`）。
 * - **路由注册走 `ctx.inject(['webServer'], ...)`**。冷启动时 webServer 比本插件晚就绪，
 *   裸访问必然失败，而失败点又在轮询之前 —— 这条路只会静默地永不注册。
 * - **提示词可由用户覆盖**：`~/.dsh/prompt-refine/prompt.md` 存在就用它，改完下一条请求生效。
 *
 * @module dsh-prompt-refine
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 浏览器半边请求的宿主路由。必须和 client.js 里的 ROUTE 一字不差。 */
const ROUTE = '/plugins/dsh-prompt-refine/refine'

/** 请求体上限。草稿再长也不可能到这个量级，纯粹是防御。 */
const MAX_BODY_BYTES = 128 * 1024

/** 超时与输出上限。 */
const DEFAULTS = { timeoutMs: 45000, maxTokens: 8000 }

/**
 * 内置改写指令。用户可用 `~/.dsh/prompt-refine/prompt.md` 整体替换。
 *
 * 两条硬约束值得单独说明，因为它们决定了这个功能"好不好用"而不是"能不能跑"：
 * - **只补全、不发明**。模型最容易犯的错是替用户决定资源、编个团队分工、加个截止日期。
 *   那已经不是"优化输入"，是"篡改需求"。
 * - **长度自适应**。简单需求强行套结构会变成一坨模板话，反而更难读。
 */
const BUILTIN_PROMPT = `你是提示词优化器。用户输入的是一段简短、口语化、可能有歧义的需求。把它改写成一段清晰、具体、可直接执行的需求描述。

【身份】输出是**用户在对助手说话**。你只负责把用户的话写清楚，不是代替助手回答，也不是代替助手向用户提问。

【硬性禁止 —— 违反任何一条即视为改写失败】
1. 不得反问，不得向用户提问，不得请求用户补充信息。
2. 不得以助手身份说话。禁止出现"我可以帮你""我来帮你""请告诉我你需要什么""你希望我做什么""如果你需要""要不要我""作为 AI / 作为助手"这类表述。
3. 不得输出元话语。不要写"以下是优化后的提示词""我明白了""好的"之类。
4. 不得增加、删除或改变用户要求的功能与范围。
5. 不得替用户决定资源、团队分工、时间期限、技术选型 —— 除非用户自己提过。

【不要为了改写而改写】
- 用户输入本身已经清楚时（问候、寒暄、简短确认、单纯的提问），**原样保留，一个字都不要改**。
- 用户没有提出可执行任务时，不要替它编造任务框架。把「你好」改写成「向用户发送一句问候语，
  内容为你好」是错的 —— 那已经不是在优化用户的表达，而是把用户的话反转成了"指挥助手去面对用户"
  的元指令。

【改写要点】
- 补全省略：用户明显省略但执行必需的上下文要写清楚 —— 做什么、在哪里做、产出什么形式。
- 消解歧义：有歧义时按最合理的理解直接写定，不要列选项。
- 长度自适应：一两句能说清的就一两句话；确实有多项要求时才用短列表，不要硬凑结构。
- 保持语言：用与用户相同的语言输出。

直接输出改写后的需求正文本身。`

/** DSH 主目录：优先 `DSH_HOME`，否则 `~/.dsh`。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 用户可覆盖的提示词文件路径。 */
function promptFile() {
  return join(dshHome(), 'prompt-refine', 'prompt.md')
}

/**
 * 读当前生效的提示词。
 *
 * 文件不存在时**播种**一份默认内容，这样用户想改的时候有东西可改，而不是面对一个空文件。
 * 播种失败（只读盘、权限）不影响功能 —— 退到包内自带那份即可。
 *
 * @returns {{ text: string, source: 'user'|'builtin' }}
 */
function resolvePrompt() {
  const file = promptFile()
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim()
      if (text.length > 0) return { text, source: 'user' }
    } else {
      mkdirSync(join(dshHome(), 'prompt-refine'), { recursive: true })
      writeFileSync(file, `${BUILTIN_PROMPT}\n`, 'utf8')
    }
  } catch {
    /* 播种或读取失败都只影响"可定制"，改写本身照常 */
  }
  return { text: BUILTIN_PROMPT, source: 'builtin' }
}

/**
 * 模型路由：用户在下一条消息里会用的那个模型。
 *
 * 这不是某个回合发起的（消息还躺在输入框里），所以没有 agent 可以回退，只能问宿主的
 * 默认模型服务。拿不到就返回空串，由调用方报错 —— 报错比随便挑个模型强。
 *
 * @param {object} ctx cordis 上下文。
 * @returns {{ provider: string, model: string }}
 */
function resolveRoute(ctx) {
  let picked = null
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    if (service && typeof service.currentSelection === 'function') picked = service.currentSelection()
  } catch {
    /* 宿主没装这个服务就当没有 */
  }
  const value = picked && typeof picked === 'object' ? picked : {}
  return {
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
  }
}

/** 剥掉模型偶尔套上的 ``` 围栏。 */
function stripFences(text) {
  const trimmed = text.trim()
  const match = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

/**
 * 判断改写结果是不是"角色反了"——写成了助手在反问用户，而不是用户的需求。
 *
 * 为什么需要这一层：提示词里已经明令禁止反问和助手口吻，但**提示词不是保证**。
 * 一旦模型把用户的需求改写成"请告诉我你需要什么"，用户原话就被顶掉了，发出去
 * 模型只会回一句"你这句话像是模板提示语" —— 这正是要防的事故。
 *
 * 所以这里用确定性规则兜一道：命中就判定改写失败，保留用户原文。
 * 宁可"没优化"，也不能"把用户的话换成一句反问"。
 *
 * 刻意只匹配**第一人称指向用户**的说法，避免误伤正常需求里出现的"你"
 * （比如"帮我在登录页加个提示：密码错误"——这里的"你"不构成反问）。
 *
 * @param {string} text 待检查文本。
 * @returns {boolean} true 表示角色反了。
 */
function looksRoleReversed(text) {
  const value = String(text || '')
  if (value.trim().length === 0) return false

  const patterns = [
    // 直接向用户提问 / 索要信息
    /请告诉我.{0,12}(什么|哪些|如何|怎么|需要)/,
    /请问你.{0,8}(需要|想要|希望)/,
    /你(需要|想要|希望).{0,10}(我|帮忙|做).{0,6}(什么|哪些|怎么)/,
    /你希望我.{0,10}(做|帮|提供)/,
    /可以告诉我.{0,10}(什么|需求|目标)/,
    // 元指令：整句就是"让助手去面对用户"。
    // 例：把「你好」改写成「向用户发送一句问候语，内容为你好」。
    // 锚定行首是关键 —— 「给用户一个开关，让他们关掉提示」这类正常需求不受影响。
    /^(请|麻烦|帮我|给我)?(向|给|对)(用户|他|她|您|对方).{0,4}(发送|回复|说|讲|说明|展示|输出|打招呼|问好)/,
    // 助手自述身份 / 主动请缨
    /我可以(帮|为)你/,
    /我(来|会)帮(你|您)/,
    /作为\s*(一个)?\s*(AI|人工智能|助手|模型|语言模型)/,
    /如果你(还)?需要.{0,10}(我|可以|随时)/,
    /要不要我/,
    /需要我.{0,8}(帮|做|继续)/,
  ]
  return patterns.some((re) => re.test(value))
}

/** 追加在重试时 system 末尾的硬性约束。 */
const ROLE_GUARD_CLAUSE = `

上一次输出不合格：它把用户的需求写成了助手在反问用户。
重写。输出必须是**用户在对助手说话**的需求正文本身：不得提问、不得索要信息、不得以助手身份说话。`

/**
 * 调一次模型，把需求改写清楚。
 *
 * 调用形状与 `dsh-prompt-hardener` 里已验证可用的那条一致：`llm.stream({ provider, model,
 * system, messages, maxTokens, purpose, signal })`，逐块收 `text-delta`。
 *
 * @param {object} ctx cordis 上下文。
 * @param {string} text 用户草稿。
 * @param {object} [options] `{ timeoutMs, signal }`。
 * @returns {Promise<string>} 改写后的正文。
 */
async function refineText(ctx, text, options = {}) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('模型服务不可用（llm service unavailable）')
  }

  const route = resolveRoute(ctx)
  if (!route.provider || !route.model) {
    throw new Error('没有可用模型路由：请先在输入框下方选一个模型，或检查模型配置')
  }

  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : DEFAULTS.timeoutMs

  /**
   * 组一次调用的 signal。
   *
   * 每次调用都新建一个超时 signal —— 重试要重新计时，否则第一次耗掉的时间会
   * 让第二次一出生就接近超时，等于白重试。
   */
  const buildSignal = () => {
    const signals = [options.signal].filter(Boolean)
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signals.push(AbortSignal.timeout(timeoutMs))
    }
    if (signals.length === 0) return undefined
    if (signals.length === 1) return signals[0]
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
    return signals[0]
  }

  const prompt = resolvePrompt()
  const systemBase = prompt.text

  const call = async (system) => {
    const signal = buildSignal()
    let out = ''
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: Math.min(DEFAULTS.maxTokens, Math.max(800, Math.ceil(text.length * 4) + 400)),
      purpose: 'prompt-refine',
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
    return stripFences(out)
  }

  let refined = await call(systemBase)
  if (refined.length === 0) throw new Error('模型没有返回内容')

  /*
   * 角色反转兜底。
   *
   * 提示词里已经明令禁止反问，但提示词不是保证：模型完全可能把用户需求改写成
   * "请告诉我你需要什么"，把用户的话顶掉。一旦发出去，对方只会回一句"你这句话像是
   * 模板提示语"，用户的需求就丢了。
   *
   * 所以命中就重试一次（追加硬性约束）；两次都反就判定改写失败，交回路由层保留原文。
   * 宁可"没优化"，也不能"把用户的话换成一句反问"。
   */
  if (looksRoleReversed(refined)) refined = await call(`${systemBase}${ROLE_GUARD_CLAUSE}`)

  if (looksRoleReversed(refined)) {
    const error = new Error('改写结果像在向用户反问，已保留原文')
    error.code = 'ROLE_REVERSED'
    throw error
  }

  if (refined.length === 0) throw new Error('模型没有返回内容')
  return refined
}

/** 用原生 req/res 读 JSON 请求体（不引入任何依赖）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
  })
}

/** 只接受同源发起的写请求。 */
function isTrustedWrite(req) {
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
  if (site === 'cross-site') return false
  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = String((req.headers && req.headers.origin) || '')
  if (origin.length === 0) return true
  try {
    const host = String((req.headers && req.headers.host) || '')
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 插件入口。
 *
 * @param {object} ctx cordis 上下文。
 */
export function apply(ctx) {
  const note = (message) => {
    try {
      if (typeof ctx.logger === 'function') ctx.logger('prompt-refine').info(message)
    } catch {
      /* 日志打不出去不是功能故障 */
    }
  }

  /** @param {(fn: Function, label: string) => void} mount */
  const mount = (fn, label) => ctx.effect(fn, label)

  /* ─────────────────────────── 1. 改写路由 ─────────────────────────── */

  mount(() => {
    const handler = async (req, res) => {
      const send = (code, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      }
      // text 提到 try 外面：角色反转时要靠它回填原文。
      let text = ''
      try {
        if (!isTrustedWrite(req)) {
          send(403, { ok: false, error: 'cross-site request rejected' })
          return
        }
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          send(405, { ok: false, error: 'method not allowed' })
          return
        }

        const body = await readJsonBody(req)
        text = body && typeof body.text === 'string' ? body.text : ''
        if (text.trim().length === 0) {
          send(400, { ok: false, error: 'text required' })
          return
        }

        const refined = await refineText(ctx, text)
        const changed = refined !== text
        send(200, { ok: true, changed, text: refined })
      } catch (error) {
        // 角色反转不是"失败"而是"不改"：原话必须留在输入框里，一个字都不动。
        // 只有这条路能既拦住反问、又不让用户的话凭空消失。
        if (error && error.code === 'ROLE_REVERSED') {
          note(`refine rejected (role reversed), original kept`)
          send(200, { ok: true, changed: false, text, error: String(error.message || error) })
          return
        }
        send(200, { ok: false, changed: false, text: '', error: String((error && error.message) || error) })
      }
    }

    // 冷启动时序：webServer 比本插件晚就绪，必须等它，不能裸访问 ctx.webServer。
    const fiber = ctx.inject(['webServer'], (child) => {
      let disposer = null
      try {
        disposer = child.webServer.register({ kind: 'exact', path: ROUTE, handler })
        note(`route registered: ${ROUTE}`)
      } catch (error) {
        // HMR 重入时会抛 duplicate exact route；旧 handler 功能等价，记一笔就够。
        note(`route registration failed: ${String((error && error.message) || error)}`)
        return () => {}
      }
      return () => {
        try {
          disposer()
        } catch {
          /* 已经卸掉就算了，卸载路径不该再抛 */
        }
      }
    })

    return () => {
      try {
        void fiber.dispose()
      } catch {
        /* 同上 */
      }
    }
  }, 'prompt-refine: refine route')
}

export { BUILTIN_PROMPT, DEFAULTS, ROLE_GUARD_CLAUSE, ROUTE, looksRoleReversed }