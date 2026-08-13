<div align="center">
  <h1>doubao-vision-dsh</h1>
  <p>让没有视觉能力的模型通过桌面豆包"看见"聊天图片 —— DeepSeek Harness 宿主插件(CDP 桥接)</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Node.js](https://img.shields.io/badge/Node.js-339933)](https://nodejs.org)
  [![DeepSeek Harness](https://img.shields.io/badge/Platform-DeepSeek%20Harness-lightgrey)]()
  [![Stars](https://img.shields.io/github/stars/hawkongz/doubao-vision-dsh)](https://github.com/hawkongz/doubao-vision-dsh)
</div>

---

## 📋 目录

- [✨ 功能特性](#-功能特性)
- [🔍 它解决什么问题](#-它解决什么问题)
- [🚀 快速开始](#-快速开始)
- [📦 安装](#-安装)
- [🔧 配置](#-配置)
- [📖 使用说明](#-使用说明)
- [⚡ 三个内置工具](#-三个内置工具)
- [🧠 工作原理](#-工作原理)
- [❓ 常见问题](#-常见问题)
- [📌 Topics](#-topics)
- [🤝 参与贡献](#-参与贡献)
- [👥 贡献者](#-贡献者)
- [📄 许可证](#-许可证)

---

DeepSeek Harness(DSH)的纯文本模型路由看不见图片。本插件把聊天里收到的每一张图片通过 CDP 桥接发送到桌面豆包 App,让豆包代做识别并返回文字,模型据此正常回答用户。

它作为**宿主级插件**挂在 `$DSH_HOME/cordis.patch.yml` 用户补丁层,对**所有预设、所有会话**生效,可以随时热开关 —— 不需要切换模式,不绑定某个会话。

## ✨ 功能特性

* **全预设生效** — 挂在用户补丁层,任何 preset、任何对话里的模型都能自动使用
* **图片照常显示** — 聊天里只显示图片,附件 ID 走系统提示词的私有通道,界面上不留任何标记文字
* **停止按钮可取消** — 识别是标准工具调用,卡住时"停止"立即中断,绝不阻塞回合
* **纯文本模型安全** — 适配器层剥离图片块,图片内容永远到不了模型请求,不会报错
* **自动拉起豆包** — 豆包没运行时后台自动以调试端口重启,识别前预热,减少等待
* **图片自动归档** — 每张图片复制到 `attachments/collected/`(日期_哈希.ext),按内容去重
* **升级友好** — 全部能力走 `ctx.get()` 加 try/catch,DSH 升级后最坏情况是静默禁用,绝不会卡死启动

## 🔍 它解决什么问题

DSH 的模型路由是纯文本的:模型看不到图片,聊天里发图要么被拒,要么模型对着图片附件干瞪眼。常见做法是把图片块换成文字说明,但那样界面里你的消息就变成了长长一段指令,图片也不显示了。

本插件的做法是:

1. 图片块**原样留在消息里** —— 聊天界面正常显示图片;
2. 附件 ID 通过**系统提示词注入**(模型的私有通道)交给模型 —— 界面上看不到;
3. 模型调用识别工具,插件用 CDP 驱动桌面豆包看图 —— 识别过程可被"停止"按钮随时取消;
4. 豆包返回文字,模型结合你的问题正常回答。

## 🚀 快速开始

> **What you need:** Windows、已安装桌面豆包 App、DeepSeek Harness(DSH)。豆包不需要手动开,插件会自动拉起。

**Step 1 — 打开终端**

- Windows:按 `Win + R`,输入 `powershell`,回车

**Step 2 — 复制两个文件到插件目录**

插件只有两个文件:`doubao-vision.mjs`(实现)和 `doubao-vision-entry.mjs`(稳定入口)。

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\plugins" | Out-Null
Copy-Item .\doubao-vision.mjs "$env:USERPROFILE\.dsh\plugins\doubao-vision.mjs" -Force
Copy-Item .\doubao-vision-entry.mjs "$env:USERPROFILE\.dsh\plugins\doubao-vision-entry.mjs" -Force
```

**Step 3 — 在 `$env:USERPROFILE\.dsh\cordis.patch.yml` 里挂一行**

如果文件不存在就新建,内容如下;存在则在文件末尾追加 `insert:` 块:

```yaml
- insert:
    - id: doubao-vision
      name: "file:///C:/Users/你的用户名/.dsh/plugins/doubao-vision-entry.mjs?v=18"
```

把路径里的 `C:/Users/你的用户名` 换成你的实际用户目录(`$env:USERPROFILE` 的值)。

**Step 4 — 完成。** 保存补丁文件即热加载,无需重启。验证方法:任意对话的工具列表里出现 `doubao_vision`、`doubao_recognize_attachment`、`doubao_cdp` 三个工具;或看 `$env:USERPROFILE\.dsh\plugins\doubao-vision.log` 里出现 `apply: doubao-vision loaded`。然后直接在聊天里发一张图试试。

> 更新插件:替换 `doubao-vision.mjs`,并把 shim 与补丁行里的 `?v=N` 同时 +1(缓存击穿),保存补丁文件即可。

## 📦 安装

目录里只有两个文件,职责分明:

| 文件 | 职责 |
| :--- | :--- |
| `doubao-vision.mjs` | 插件实现:消息钩子、CDP 桥接、三个工具、图片归档 |
| `doubao-vision-entry.mjs` | 稳定入口 shim:加载失败时降级为空插件,绝不拖垮启动 |

依赖条件:

* Windows(CDP 端口与豆包路径按 Windows 惯例写死,`CdpClient` 依赖内置 WebSocket)
* 桌面豆包 App(默认路径 `%LOCALAPPDATA%\Doubao\Application\app\Doubao.exe`,可配置)
* 豆包以 `--remote-debugging-port=9225` 运行(插件检测不到时会自动先杀后起,历史对话保留)

## 🔧 配置

| 配置项 | 位置 | 说明 |
| :--- | :--- | :--- |
| 开关插件 | `cordis.patch.yml` 该行下加 `disabled: true` | 保存即生效,再删掉即恢复 |
| 豆包路径 | 插件行 `config.doubaoExe` | 默认 `%LOCALAPPDATA%\Doubao\Application\app\Doubao.exe` |
| 调试端口 | `CDP_PORT` 常量 | 固定 9225 |
| 缓存目录 | `$env:USERPROFILE\.dsh\attachments\collected` | 可读文件名副本,按内容哈希去重 |
| 版本后缀 | shim 与补丁行里的 `?v=N` | 改 `doubao-vision.mjs` 后两处同时 +1 |

## 📖 使用说明

* **聊天发图**:直接发图即可,识别自动进行;模型会根据你的话判断意图并组织问豆包的问题(比如你只要文字,它就会问"提取图中所有文字")
* **本地图片文件**:模型可调用 `doubao_vision` 传入文件路径识别截图、照片
* **取消**:识别是普通工具调用,"停止"按钮立即中断,不会像"消息预处理"那样卡住回合
* **隐私提示**:图片与提问文字会发给豆包(字节跳动),豆包聊天窗口会保留发送记录,敏感内容请勿使用

## ⚡ 三个内置工具

| 工具 | 用途 |
| :--- | :--- |
| `doubao_vision` | 识别本地图片文件(传路径),豆包未运行时自动拉起 |
| `doubao_recognize_attachment` | 识别聊天里的图片附件;省略 `attachment_id` 时识别本会话最近一张图 |
| `doubao_cdp` | 管理豆包调试连接:`status` / `restart` / `new-chat` / `ask` |

## 🧠 工作原理

```text
用户发图
  └─ agent/pre-step:保留图片块(界面正常显示图),缓存附件引用,后台预热豆包
  └─ agent/inbox/claimed + system-prompt/assemble:附件 ID 注入系统提示词(模型的私有通道)
  └─ adapter.stream:剥离图片块(纯文本模型收到的消息里没有图,不会报错)
  └─ 模型调用 doubao_recognize_attachment(可被停止按钮取消)
        ├─ CDP(9225)驱动桌面豆包:上传图片 → 注入问题 → 点击发送
        ├─ 轮询豆包回复(所有等待都尊重取消信号,硬超时兜底)
        └─ 返回识别文字
  └─ 图片自动归档到 attachments/collected(日期_哈希.ext,按内容去重)
```

图片存储有两处:原始缓存 `attachments/v1/objects/`(内容寻址,识别依赖它,**不要删**)和可读副本 `attachments/collected/`(方便浏览,可随意删)。

## ❓ 常见问题

* **停止按钮还能用吗?** 能。识别在工具调用内执行,停止立即中断;消息预处理阶段只做瞬时操作,从不等待豆包。
* **豆包没开怎么办?** 插件后台自动以调试端口重启豆包(先杀后起),并在识别前预热。
* **DSH 升级后插件失效了?** 看 `doubao-vision.log`。插件全部能力走 `ctx.get()` 加 try/catch,最坏情况是静默禁用,不会阻塞启动;多为内部 API 变动,欢迎提 Issue。
* **同一张图重复识别会重复调豆包吗?** 不会,识别结果有会话内缓存。
* **历史图片能再识别吗?** 能。模型不带 ID 调用识别工具时,默认识别本会话最近一张图;更早的图可以重发。

## 📌 Topics

[`dsh-plugin`](https://github.com/topics/dsh-plugin) · [`deepseek-harness`](https://github.com/topics/deepseek-harness) · [`doubao`](https://github.com/topics/doubao) · [`deepseek`](https://github.com/topics/deepseek) · [`vision`](https://github.com/topics/vision) · [`ocr`](https://github.com/topics/ocr) · [`cordis`](https://github.com/topics/cordis) · [`image-recognition`](https://github.com/topics/image-recognition)

## 🤝 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。核心约束:改 `doubao-vision.mjs` 后必须同步把 shim 与补丁行里的 `?v=N` 加一,否则改完不生效。

## 👥 贡献者

| 角色 | GitHub | 贡献 |
| :--- | :--- | :--- |
| 作者 / 维护者 | [hawkongz](https://github.com/hawkongz) | 全部功能设计与实现 |

PR 被合并后,请把你的名字加进这张表。

## 📄 许可证

[MIT](LICENSE)
