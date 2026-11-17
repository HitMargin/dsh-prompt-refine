# dsh-prompt-refine · 优化输入

一个 [DSH](https://github.com/deepseek-ai) 插件：在输入框工具行左侧（权限控件右边）加一个
**「优化输入」**按钮。点一下，把草稿里那段简短、口语化、可能有歧义的需求，改写成交给模型
能一次做对的清楚描述，结果**原地写回输入框**——你过目之后自己发。

## 它做什么

| 你打的 | 点一下之后输入框里的 |
| --- | --- |
| `帮我搞个登录页面` | `做一个登录页面：包含账号、密码输入框和登录按钮；提交时校验非空，校验失败在输入框下方给出红色提示；未接入后端，先用本地状态模拟成功。` |
| `这个报错怎么回事` | `解释下面这条报错的含义和成因：先说明它在说什么，再指出最常见的几种触发原因，最后给出排查顺序。不要直接改代码，先解释清楚。` |

**不发明需求**：不替你决定技术选型、资源、团队分工、时间期限——除非你自己提过。

## 用法

- 点一下 → 按钮转圈 → 草稿被替换成改写结果，按钮变成绿色「已优化」。
- **再点一下 = 撤回**，还原成你原来的话（只要草稿还停在改写结果上）。
- 输入框为空时点它 → 按钮变红提示「输入框是空的」，不会发出任何请求。
- 改写失败（没选模型 / 模型超时 / 服务不可用）→ 按钮变红，鼠标悬停看原因，草稿**原封不动**。

## 改提示词

改写指令存在 `~/.dsh/prompt-refine/prompt.md`，**首次点击时自动生成**。改完下一条请求生效，不用重启。

删掉这个文件再点一次，会重新生成内置版本。

## 和其他插件的关系

本插件**不碰发送链路**。同类插件（如 `dsh-prompt-hardener`）是在回合开始前偷偷改写用户消息，
用户看不见也拦不住；这里反过来——改写只发生在你按按钮的那一刻，结果先落在输入框里，你过目后自己发。

两者可以同时装：一个管"这句怎么说更有力"，一个管"这句怎么说更清楚"。

## 安装

### 桌面版 / 本机

```powershell
# 1. 让 profile 能解析到本包（等价于 pnpm 的 link: 依赖）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-prompt-refine" `
  -Target "D:\Projects\dsh-prompt-refine"
```

然后在 profile 的 `package.json` 里：

```json
{
  "dependencies": { "dsh-prompt-refine": "link:D:/Projects/dsh-prompt-refine" },
  "dsh": { "profile": { "bundles": [ "…", "dsh-prompt-refine" ] } }
}
```

改完**重启 DSH**（客户端 bundle 在启动期注入）。

### 命令行版

```bash
dsh plugin --profile web add github:HitMargin/dsh-prompt-refine
```

### 桌面版

**插件** 页 → **添加插件** → 包名或地址栏填 `HitMargin/dsh-prompt-refine` → 安装。

## 开发

```bash
node --check index.js && node --check client.js
node test/smoke.mjs        # 客户端：模块外壳、slot 注册、五个相位渲染
node test/host.test.mjs    # 宿主：路由 → 模型调用 → 响应，含错误分支
node test/draft.test.mjs   # 草稿：setDraft 刷没刷界面都写对、撤回、空草稿
```

零依赖、零构建：host 半边不 import 任何 DSH 包，浏览器半边只 `require('react')`（由页面模块表提供）。
测试用 `node:vm` 把两半都真跑一遍，不需要浏览器、不需要 Electron。

### 一个已经踩过的坑

`inputActions.setDraft()` 是官方唯一的公开写入路径，但契约**没有保证它立刻把 contenteditable
刷成新文本** —— 已装的同类插件全都只在按下发送前调一次、紧接着就 `submit()`，从不观察界面。

所以实现里是"写完**验一眼 DOM**，没跟上再补写一次"。`test/draft.test.mjs` 的 B 用例专门钉这个：
让 `setDraft` 什么都不做，断言界面最终仍必须变成新文本。

> host 半边（`index.js`）改完**要重启应用**才生效。

## 许可

MIT