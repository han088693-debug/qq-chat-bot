# 安装与使用教程

本教程以 **Windows、单机运行、一个 QQ 账号** 为例。先完成三个服务的状态检查，再由你决定何时加入聊天对象。仓库提供桥接程序、网页控制台和 DSH 插件；**DSH、SnowLuma、QQ 客户端及模型账号需要另外安装或配置**。

本文中的命令均在仓库根目录执行，除非另有说明。配置只填写在本机的 `config.json`；仓库的 `config.example.json` 是模板。

## 1. 准备环境

| 组件 | 需要准备的内容 |
| --- | --- |
| Node.js | **22.13.0 或更高版本**，包含 npm |
| Git | 用于克隆和更新仓库，也可以从 GitHub 下载代码压缩包 |
| DeepSeek Harness（DSH） | 独立安装，能够启动 Web 服务；在其设置中配置你有权限使用的模型 |
| SnowLuma | 独立安装并完成 QQ 登录，启用 OneBot v11 WebSocket 与 HTTP API |
| QQ | 使用 SnowLuma 所支持的客户端与运行环境 |

外部项目入口和来源说明见 [仓库首页](../README.md)。本仓库不会安装、启动或停止 SnowLuma，也不包含外部软件的安装包、登录状态或模型凭据。

先检查运行环境：

```powershell
node --version
npm --version
git --version
```

本项目对接 DSH 的 Cookie 鉴权、斜杠形式的 RPC 路径以及事件流协议；不要仅凭版本号相近就认定兼容。外部软件更新后，应重新检查连接、预设和工具是否可用。

## 2. 获取代码和安装依赖

```powershell
git clone https://github.com/han088693-debug/qq-chat-bot.git
cd qq-chat-bot
npm ci
Copy-Item -LiteralPath .\config.example.json -Destination .\config.json
```

私有仓库需要先用有访问权限的 GitHub 账号完成 Git 登录。`npm ci` 按锁文件安装依赖，并执行仓库内的 `postinstall`，修补 SnowLuma SDK 的 ESM 导出兼容问题。

已存在 `config.json` 时，保留原文件，逐项补充模板中的新配置；不要再次复制覆盖。JSON 不支持注释或末尾多余逗号。

## 3. 填写本机配置

用文本编辑器打开 `config.json`。先处理以下字段：

| 字段 | 如何填写 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址；本教程使用 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` | 从你自己的 DSH 模型设置中选择可用值；模板中的名称不代表你的账号一定可用 |
| `dsh.reasoningEffort` | 选择该模型支持的推理强度 |
| `dsh.authToken` | **本机安装通常留空**；它不是模型 API Key |
| `dsh.allowRemote` | 本教程保持 `false` |
| `snowluma.wsUrl` | SnowLuma 页面显示的 OneBot WebSocket 地址 |
| `snowluma.httpUrl` | SnowLuma 页面显示的 OneBot HTTP API 地址；不要把 WebSocket 地址填进这里 |
| `snowluma.accessToken` | 与你自己的 OneBot 设置一致；未启用该鉴权时留空 |
| `snowluma.homeDir` / `launcherPath` | 可选，用于本机安装位置和端点发现；由你填写自己的路径 |
| `ownerQQ` | 你自己的管理员 QQ 号，填正整数；不填写时管理员命令和审批不可用 |
| `allow.private` | 允许聊天的 QQ 号数组；**管理员如需聊天，也请显式加入** |
| `allow.groups` | 允许聊天的群号数组 |
| `deny.private` / `deny.groups` | 拒绝访问的账号和群；优先于白名单 |
| `allowAllWhenEmpty` | 保持 `false`；白名单为空时不接入任何聊天对象 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 可留空，由程序生成并保存在 `state/console-token` |
| `sessionCwd` | 通常留空，由桥接在 `state/agents/` 下建立会话工作目录 |
| `agentPreset` / `socialV2.agentPreset` | 首次安装保留 `qq-chat` / `qq-chat-v2` |

**首次检查时，让两个白名单数组都保持为空。** 先完成后面的启动和检查，再在控制台「访问与安全」加入你决定开放的对象。空白模板不会包含任何人的真实 QQ 号或群号。

模板关闭了开发助手、语音收发中的可选能力、主动发言和黑话自动研究。黑话基础学习、风格学习和热榜有不同默认值，不能据此推断全部可选功能都关闭。先保持基础聊天设置；需要时按第 8 节与 [可选功能总教程](OPTIONAL_FEATURES.md) 逐项配置。

### DSH 的本机鉴权

桥接需要与 DSH 使用**同一份 `DSH_HOME` 和同一用户可读取的凭据文件**。默认目录是用户主目录下的 `.dsh`。如果你自定义了 `DSH_HOME`，在安装脚本、DSH 和桥接各自的终端里设置同一个值。

`src/dsh-client.js` 可以读取本机 DSH 的 `.credentials.yaml`，用其中的签名信息建立会话 Cookie，也保留启动令牌的兼容路径。因此通常让 `dsh.authToken` 留空，不要把模型 API Key、浏览器 Cookie 或过期启动令牌填进去。

`.credentials.yaml`、`state/console-token` 和登录链接都是本机私密数据，不应提交到 GitHub 或贴进 Issue。

## 4. 安装 DSH 预设与工具

DSH 独立安装并初始化完成后，执行：

```powershell
node scripts/setup-dsh.mjs
```

默认目标是 DSH 的 `web` profile。使用其他 profile 时：

```powershell
node scripts/setup-dsh.mjs your-profile
```

这里的 `your-profile` 只是示例名称，应替换为实际 profile。脚本会：

1. 从 `dsh/agent-presets/` 生成 `qq-chat`、`qq-chat-v2` 的 bundle patch。
2. 在目标 profile 注册 `qq-agent-presets` 和 `qq-mode-console` 两个插件。
3. 在 profile 的 `cordis.patch.yml` 挂载 QQ 工具、本机辅助工具和安全搜索 MCP。
4. 在没有本地模式文件时创建 `state/mode.json`，作为运行模式的备用来源。
5. 尝试调用 `dsh plugin --profile <profile> install` 安装 profile 的依赖。

**预设通过 bundle 和 Cordis 配置装配。不要把文件手工复制到旧的 `.agent-presets/` 目录来安装。**

如果脚本报告找不到 `dsh`，先检查 DSH CLI 是否已加入 PATH；自动安装依赖失败时，按输出提示手动执行：

```powershell
dsh plugin --profile web install
```

修改 profile 后需要重启 DSH。移动仓库目录后，也需要重新运行安装脚本，因为插件链接和 MCP 启动路径指向原目录。

## 5. 按顺序启动

分别保留各程序自己的终端或窗口，方便查看状态。

### 第一步：启动 DSH

默认 `web` profile 可使用：

```powershell
dsh web --host 127.0.0.1 --port 3080 --no-open
```

按 DSH 提供的本机登录方式打开 Web 页面，确认模型配置可用。若你使用其他启动方式或 profile，以那份安装的启动说明为准，并确保与第 4 节的安装目标一致。

### 第二步：启动 SnowLuma 并登录 QQ

使用 SnowLuma 自带的启动方式登录 QQ，查看实际 OneBot 地址、端口和 access token，使之与 `config.json` 一致。SnowLuma 的管理页面地址未必等于 OneBot HTTP 或 WebSocket 地址。

模板中的 `3000`、`3001` 只是示例端口。某些安装可能将接口放在同一端口或使用其他路径，以 SnowLuma 当前页面为准。

### 第三步：启动桥接

在仓库目录打开终端：

```powershell
npm start
```

然后打开 [本地控制台](http://127.0.0.1:3100)。如果出现令牌输入框，从本机 `state/console-token` 读取生成的值；配置了 `consoleToken` 时使用你自己设置的值。

进入「运行总览」，**显式选择「二代仿真」`reserved2`**，再确认页面显示的当前模式。安装脚本只会创建缺失的本地模式文件；旧设置、DSH 设置和进程初始模式都可能影响最终状态，因此不能仅凭“安装完成”判断当前模式。

## 6. 三处状态检查

下面的检查不要求发送 QQ 消息：

| 检查位置 | 应检查什么 | 能说明什么 |
| --- | --- | --- |
| DSH 页面 | Web 服务可访问、模型已配置；能找到 `qq-chat` 和 `qq-chat-v2` 预设 | DSH 服务和插件装配可用 |
| SnowLuma 页面 | QQ 账号在线，OneBot 服务已启用，地址和鉴权正确 | QQ 网关自身已准备好 |
| 桥接控制台 | `DSH 已连接`，SnowLuma 连接及上游健康状态，模式为 `reserved2`，二代仿真未暂停 | 桥接看到的连接与运行设置符合预期 |

**WebSocket 已连接不等于 QQ 接收链路正常。** 如果 SnowLuma 自报 `good=false`，先处理其上游接收问题；`good` 为未知时，记录为未知，不应当作检查通过。即使三处状态符合预期，也还没有验证一条真实 QQ 消息的完整往返。

确认准备完成后，到「访问与安全」填写 `ownerQQ` 和需要开放的白名单并保存。开启后，符合模式和唤醒条件的真实消息可能触发模型调用与回复；二代模式也可能按配置主动唤醒。教程中的命令没有自动发送测试消息。

## 7. 可选验证

以下独立检查使用本地样例或模拟服务，不需要登录 QQ：

```powershell
npm run test-md
npm run test:reply-wait
node --test src/core/session-router.test.mjs
```

它们分别检查文本转换、等待消息逻辑和会话路由策略。会话路由策略测试通过，并不表示该策略已经接入主桥接流程。

如果需要单独检查 **DSH 到模型的真实链路**：

```powershell
npm run self-test
```

该命令会创建临时 DSH 会话、提交短提示、等待模型回复并尝试归档。**它可能消耗模型额度，但不发送 QQ 消息。** DSH 使用非默认地址时：

```powershell
node src/self-test.js http://127.0.0.1:3080
```

仓库没有 `npm run selfcheck`。以上命令是供你执行的验证步骤，不代表你的电脑已经运行通过，也不能替代真实 QQ 往返的单独检查。

## 8. 常用功能

### 设置人格

在控制台「人格与角色」创建或选择角色卡。角色卡是 Markdown 文本，保存在 `roles/`。公开仓库不附带个人私密角色卡。

角色内容按轮次读取；保存后，后续轮次会使用更新内容，已经提交的提示不会被追溯修改。需要分别定义一代和二代规则时，可用 `〔一代〕`、`〔二代〕` 标记对应小节。

人格描述与工具规则分开：工具协议在 `dsh/agent-presets/`。修改预设后重新运行 `setup-dsh.mjs` 并重启 DSH，再检查对应会话是否使用新预设。

### 调整聊天节奏

「二代仿真」页提供工具开关、唤醒条件、等待时间、消息长度、连续气泡和限频参数。先使用保守设置，再根据实际行为调整。`reserved2` 通过工具决定发什么、何时发，模型在 DSH 中输出普通文本不一定会发到 QQ。

### 图片、表情与语音

配置片段、素材目录、形象文件与音频检查步骤见 [媒体教程](guides/OPTIONAL_MEDIA.md)。

- 图片理解依赖模型本身的图像输入能力；图片下载和发送还受到大小、来源及目录限制。
- 表情库依赖 SnowLuma 提供相关接口和可读取的表情资源。
- 发送语音使用你自己准备的音频，需要配置音频目录以及必要的 FFmpeg/ffprobe 工具；启用 AI 语音发送时，同时检查 `socialV2.voice.enabled` 与 `socialV2.tools.sendVoice`。
- 入站语音转写需另外安装 FFmpeg、whisper.cpp 及模型，并设置 `FFMPEG_PATH`、`WHISPER_CLI`、`WHISPER_MODEL`；准备好后再启用 `socialV2.asr.enabled`。转写失败会退回消息占位描述。
- 仓库不包含音频素材、语音模型或外部独立语音工具。

### 搜索、记忆与费用

黑话词库、记忆、知识库、日记和提醒均有代码支持；实际工具和停用边界见 [记忆教程](guides/OPTIONAL_MEMORY.md) 与 [学习和自动运行](guides/OPTIONAL_AUTOMATION.md)。开启自动研究或联网搜索会产生外部请求，搜索内容可能交给配置的服务商处理。

「令牌与花费」展示 DSH 提供的用量和按本地价格表计算的估算金额。价格表可能需要更新，账单以实际服务商为准。

开发助手 `devAgent` 与 `closed-agent` 模式可以使用更广的 DSH 工具面。首次聊天配置保持开发助手关闭、使用 `reserved2`；确实需要开发助手时，单独设置其工作目录、预设和管理员身份。

### iPhone、Android、QQ 空间和 B 站

仓库 `optional/` 提供这些能力的可选适配，模板全部关闭，外部软件和平台登录需另行准备。按 [可选功能总教程](OPTIONAL_FEATURES.md) 复制独立配置，先同步当前聊天预设，再安装可选 MCP：

```powershell
node scripts/setup-dsh.mjs web
node optional/setup.mjs web --check
node optional/setup.mjs web
```

上述可选安装命令需要先完成 `optional/config.json`，不会替你连接手机或登录账号。最后重启 DSH，并检查真实工具列表。设备控制、QQ 空间写入和截图保存各有显式开关；B 站代理只开放四个读取工具。

## 9. 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 控制台可以打开，但 DSH 未连接 | DSH 是否运行、`baseUrl` 是否一致、三个进程使用的 `DSH_HOME` 是否一致、本机凭据是否可读 |
| DSH 返回 401 | 是否手填了过期 `dsh.authToken`；本机安装先恢复留空，并检查 DSH 主目录和凭据权限 |
| 找不到聊天预设 / 工具不存在 | 是否在正确 profile 执行安装，bundle 依赖是否安装，DSH 是否已重启 |
| 切换模式后又变回来 | 确认新插件已加载；通过桥接控制台切换，检查 DSH 设置写入是否失败 |
| SnowLuma 返回 HTTP 426 | HTTP API 配置可能误填了仅支持 WebSocket 的端口或路径 |
| SnowLuma 已连接但收不到消息 | 查看账号在线状态、`good`、最近事件时间及 SnowLuma 自己的诊断日志 |
| 聊天没有回复 | 检查白名单、黑名单、角色静默、二代暂停、唤醒条件、限频和当前模式 |
| 模型有文字输出但 QQ 没消息 | `reserved2` 需要实际调用发送工具；检查工具是否安装和开启，以及发送拦截原因 |
| 语音不能用 | 是否另外安装所需程序和模型；确认功能开关、路径和文件权限 |
| 提示已有实例或端口被占用 | 找到已运行的桥接，只保留一个实例；不要在旧进程仍运行时删除锁文件 |

停止桥接时在其终端按 `Ctrl+C`。停止 DSH 或 SnowLuma 应使用各自的退出方式。断线期间的内存消息队列不是持久消息系统；桥接退出可能丢失尚未投递的队列，恢复连接也不保证补发所有已结束回合。
