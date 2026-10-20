# 目录与职责索引

本索引按职责定位文件，不使用会随编辑变化的源码行号。需要查找具体实现时，按文件名、函数名、接口路径或工具名搜索。

## 仓库目录

| 路径 | 职责 |
| --- | --- |
| `src/` | 桥接、协议客户端、工具适配及业务模块 |
| `public/console.html` | 本地网页控制台 |
| `dsh/agent-presets/` | QQ 聊天预设的源配置 |
| `plugins/qq-agent-presets/` | DSH 预设 bundle、生成的 patch 和工具约束实现 |
| `plugins/qq-mode-console/` | DSH 模式设置插件 |
| `scripts/` | 安装、检查、回归、探针及手动操作脚本 |
| `optional/` | iPhone、Android、QQ 空间、B 站的独立配置、MCP 适配、空间巡逻与安装器 |
| `roles/` | 通用角色示例与角色编写说明；个人新增角色默认忽略 |
| `docs/` | 安装、架构、维护和隐私说明 |
| `config.example.json` | 无真实账号和凭据的配置模板 |
| `optional/config.example.json` | 外部可选模块模板；模块、设备控制、平台写入及截图落盘默认关闭 |
| `package.json` / `package-lock.json` | 命令入口、依赖声明与锁定版本 |
| `.gitignore` | 排除本机配置、运行状态、依赖、私密素材等 |
| `RULES.md` | 模式与权限规则 |
| `LICENSE` | 本仓库代码的许可证及保留声明 |

## 核心接入和控制

| 文件 | 负责什么 | 定位线索 |
| --- | --- | --- |
| `src/bridge.js` | 事件入口、配置、模式、会话、控制台、唤醒与发送检查 | `modeAllowed`、`ensureSession`、`/api/status`、`/api/socialV2/` |
| `src/snowluma-conn.js` | 网关连接、重连及端点发现 | OneBot、WebSocket、discovery |
| `src/dsh-client.js` | DSH 鉴权、RPC、事件流和会话操作 | `NodeApiClient`、`ensureAuth`、`events.mux` |
| `src/self-test.js` | 创建临时 DSH 会话并检查真实模型回复 | `npm run self-test`；会调用真实模型 |
| `src/core/session-router.mjs` | 独立的逐会话路由策略 | 当前只有测试接入，主桥接尚未调用 |
| `src/mcp-snowluma-safe.js` | QQ MCP 工具和桥接接口适配 | `server.tool`、`qq_send_message` 等 |
| `src/mcp-host-server.js` | 本机网关辅助信息 | Host MCP 注册 |
| `src/mcp-web-search-safe.js` | 受限制的联网搜索/抓取工具 | `web_search`、`web_fetch` |

## 聊天内容、媒体和长期状态

| 文件 | 职责 |
| --- | --- |
| `src/role-card.js` | 角色内容的分代筛选和注入准备 |
| `src/preset-prompt.js` | 预设提示词读取、校验和修改辅助 |
| `src/v2-wait.js` | 等待消息、安静窗口和消息连续性判断 |
| `src/qq-model-view.js` | 控制模型看到的 QQ 消息字段与体积 |
| `src/md-to-plain.js` | 将 Markdown 等内容转换成适合 QQ 的文本 |
| `src/forward.js` | 转发消息处理 |
| `src/image-send-lib.js` | 本地图片来源、格式、大小和发送准备 |
| `src/sticker-lib.js` / `src/sticker-memory.js` | 表情库、备注、使用记录和记忆 |
| `src/voice-core.js` / `src/send-voice-lib.js` | 音频检查、处理与共享发送辅助 |
| `src/voice-asr.js` / `src/voice-transcribe.js` | 入站语音提取及本地转写 |
| `src/slang-learner.js` / `src/style-learner.js` | 黑话候选、词库和表达风格学习 |
| `src/knowledge-lib.js` / `src/diary-lib.js` | 知识库和日记 |
| `src/reminders.js` | 提醒存储及到期状态 |
| `src/web-search.js` / `src/hot-trends.js` | 搜索后端及热榜缓存 |
| `src/holidays.js` | 节日相关信息 |
| `src/music-now.js` / `src/music-now.ps1` | Windows 当前媒体会话读取 |
| `src/token-ledger.js` / `src/model-prices.js` | 模型用量记录和金额估算 |

## 安装和检查

| 文件或入口 | 用途与运行影响 |
| --- | --- |
| `scripts/setup-dsh.mjs` | 修改目标 DSH profile、建立插件链接并尝试安装依赖；完成后重启 DSH |
| `scripts/build-agent-preset-patches.mjs` | 从预设源配置生成 bundle patch |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs` | 工具约束的主要实现；预设目录中的同名文件为转导出 |
| `src/safe-fetch.js` | 外部资源请求的地址和响应限制 |
| `src/sensitive.js` | 输出内容的敏感特征检查 |
| `src/state-acl.mjs` | 本机状态目录权限处理 |
| `scripts/diagnose-acl.mjs` | 只读检查 Windows 路径权限 |
| `scripts/harden-state-acl.mjs` | 修改本机配置和状态的文件权限 |
| `scripts/privacy-scan.mjs` | 发布内容的辅助扫描；规则和盲区见 [隐私说明](guides/PRIVACY.md) |
| `scripts/test-*.mjs` | 回归检查；区分离线样例、模拟服务和可选真实环境段 |
| `scripts/probe-*.mjs` / `scripts/verify-*.mjs` | 诊断真实环境或检查结构；先读脚本说明，不当作全部离线检查 |
| `scripts/send-voice.mjs` / `scripts/send-test-group.mjs` | 手动发送入口，可能向真实 QQ 发送内容 |
| `scripts/voice-tool-locator.mjs` | 查找未打包的外部独立语音工具，缺少时报告相应检查跳过 |

## 可选模块

可选模块的职责如下；操作步骤见 [可选功能总教程](OPTIONAL_FEATURES.md)。

| 文件 | 职责 |
| --- | --- |
| `optional/config.mjs` | 读取独立 JSON，校验开关、路径、设备选择和回环地址 |
| `optional/setup.mjs` | 检查/安装/移除自管的 DSH MCP 条目，支持 `--check` 与 `--remove` |
| `optional/proxy.mjs` | iPhone / B 站的工具注册与调用过滤；可选私有截图保存 |
| `optional/phone/server.mjs` | Android / QQ 空间 MCP stdio 入口 |
| `optional/phone/core.mjs` | 具体设备读取、控制及 QQ 空间访问实现 |
| `optional/phone/LICENSE.ai-companion-kit` | 改写来源的 MIT 许可 |
| `optional/qzone-patrol/core.mjs` | 允许名单扫描、候选校验、演练、互动配额与持久去重 |
| `optional/qzone-patrol/state.mjs` | 跨进程锁与原子保存；状态损坏时停止操作 |
| `optional/qzone-patrol/server.mjs` | 独立 `qzone` MCP 的扫描、状态、点赞和评论工具 |
| `optional/qzone-patrol/runner.mjs` | 常驻或单轮巡逻、按需自动点赞，以及本机配置检查和状态命令 |

## 本机运行时目录

以下内容由使用者在本机创建或由程序生成，不应与源代码一起发布：

| 路径 | 典型内容 |
| --- | --- |
| `config.json` | 真实 QQ 号、白名单、端点、令牌及本机路径 |
| `optional/config.json` | 真实设备选择、外部软件位置与可选服务设置 |
| `state/` | 会话映射、会话令牌、控制台令牌、聊天活动、记忆、词库、日记、提醒及用量 |
| `state/optional/qzone-patrol/` | 巡逻候选、动作预占与结果、配额和定时运行状态；重启后保留 |
| `audio/`、自定义图片目录 | 用户自己的音频和图片 |
| `node_modules/` | 安装的依赖；通过 `npm ci` 重建 |
| 使用者自己的 `DSH_HOME` | DSH profile、凭据与会话记录 |
| SnowLuma 自己的安装和数据目录 | QQ 网关、登录资料、日志及资源 |
| 仓库外的 `../voice-tool/` | 可选独立语音项目，含 `voice-gui.mjs` 和 `voice-cli.mjs` |
| 外部 SideTap / B 站服务目录 | 运行环境、设备配对、账号凭据与日志 |

停止进程、清理日志、重置聊天会话和删除运行状态是不同操作。诊断时先保留需要的本机证据，避免用删除整个 `state/` 的方式尝试解决所有问题。
