# 可选功能总教程

先完成 [基础安装](QUICKSTART.md)，确认 SnowLuma、桥接和 DSH 的状态，再逐项增加能力。本文按当前源码说明配置；“可选”表示可以按需要配置，不代表所有功能默认关闭。

## 1. 选择要启用的能力

| 能力 | 配置或入口 | 额外依赖 / 教程 |
| --- | --- | --- |
| 图片、形象和表情 | `config.json` 的 `socialV2.image`、`sticker`、`tools` | 自己有权使用的素材；[媒体教程](guides/OPTIONAL_MEDIA.md) |
| AI 发已有语音 | `socialV2.voice.enabled` 与 `tools.sendVoice` | 音频、FFmpeg / ffprobe；[媒体教程](guides/OPTIONAL_MEDIA.md) |
| 收到语音后转文字 | `socialV2.asr.enabled` | FFmpeg、whisper.cpp、模型；[媒体教程](guides/OPTIONAL_MEDIA.md) |
| 轻量记忆、日记、知识库、提醒 | QQ MCP 工具与本机 `state/` | [记忆教程](guides/OPTIONAL_MEMORY.md) |
| 黑话与风格学习 | `slang`、`socialV2.learning` | 会使用 DSH 模型；[自动运行教程](guides/OPTIONAL_AUTOMATION.md) |
| 联网搜索、热榜、节日 | `webSearch`、`socialV2.hotTrends` | 搜索后端 / 外网；[自动运行教程](guides/OPTIONAL_AUTOMATION.md) |
| 主动话题 | `socialV2.proactive`；一代另有 `social.proactiveEnabled` | [自动运行教程](guides/OPTIONAL_AUTOMATION.md) |
| 管理员开发助手 | `devAgent` | 明确选择本机工作目录；[自动运行教程](guides/OPTIONAL_AUTOMATION.md) |
| 本机正在播放的音乐 | `qq_music_now` | Windows 媒体会话；[媒体教程](guides/OPTIONAL_MEDIA.md) |
| iPhone | `optional/config.json` 的 `iphone` | 独立 SideTap；[iPhone 教程](guides/OPTIONAL_IPHONE.md) |
| Android | `optional/config.json` 的 `phone.android` | ADB 与设备授权；[Android 教程](guides/OPTIONAL_ANDROID.md) |
| QQ 空间 phone 兼容入口 | `optional/config.json` 的 `phone.qzone` | 支持对应接口的 SnowLuma；[兼容入口教程](guides/OPTIONAL_QZONE.md) |
| QQ 空间读取、赞评、精准回复、发帖与巡逻 | `optional/config.json` 的 `qzonePatrol`；9 个工具，各类写入独立开关 | 支持对应接口的 SnowLuma；[空间扩展教程](guides/OPTIONAL_QZONE_PATROL.md) |
| QQ 空间新评论守望者 | `qzonePatrol.watcher`；独立进程、默认关闭且演练开启 | SnowLuma 与就绪的二代 Bridge；[守望者配置](guides/OPTIONAL_QZONE_PATROL.md) |
| B 站只读 | `optional/config.json` 的 `bilibili` | 独立 Python MCP；[B 站教程](guides/OPTIONAL_BILIBILI.md) |

角色卡、白名单、聊天模式、等待、唤醒、连续气泡和用量面板属于基础桥接，见 [快速开始](QUICKSTART.md) 与 [流程说明](ARCHITECTURE.md)。

按会话模型、思考强度、角色按需注入和 Bridge 插件也属于基础桥接，配置与升级见 [会话功能教程](guides/SESSION_FEATURES.md)。QQ 空间新部署推荐 `qzonePatrol`：它同时提供按需工具和单独启动的巡逻，不要求开启定时运行才能使用读取工具。

## 2. 两份配置文件

`config.json` 管桥接内能力；`optional/config.json` 管外部适配。两者都在 `.gitignore` 范围内。教程里的 JSON 是需合并的字段示例，不要用一个局部片段覆盖整份配置。

直接修改 `config.json` 后重启桥接；涉及 MCP 工具开关时同时重启 DSH，使工具列表刷新。控制台的部分设置可即时生效，以保存后的界面与实际工具列表为准。

外部适配首次配置：

```powershell
# 先同步当前版本的聊天预设；默认 profile 为 web
node scripts/setup-dsh.mjs web

# 仅首次复制，已有个人配置不要覆盖
Copy-Item -LiteralPath .\optional\config.example.json -Destination .\optional\config.json
```

随后按分项教程填写自己的依赖路径，仅把需要的模块设为 `enabled:true`。保持其他模块关闭，设备控制与 QQ 空间写入也可以继续关闭。

```powershell
node optional/setup.mjs web --check
node optional/setup.mjs web
```

最后重启 DSH。前一条检查 JSON、必要文件路径、目标 profile 和安装冲突，不写文件、不启动外部进程、不联系设备；后一条更新该 profile 的 `cordis.patch.yml`，也不会自行配对或登录设备。`--check` 成功不表示真实平台已连通。

如果主安装用了其他 profile，两条安装命令必须使用同一个名字。主安装和可选安装各自负责自己的条目，外部适配不能代替基础安装。

## 3. 自定义配置位置、停用与迁移

可以在执行可选安装前指定另一份本机 JSON：

```powershell
$env:QQ_BOT_OPTIONAL_CONFIG = 'C:/bot-config/qq-optional.json'
node optional/setup.mjs web --check
node optional/setup.mjs web
```

安装时会把这个路径写入 DSH MCP 环境配置。该 JSON 仍需符合模板结构，启用的外部程序必须使用真实存在的路径。更改位置后重新安装并重启 DSH。

停用某个外部模块：把其 `enabled` 改为 `false`，重新运行可选安装并重启 DSH。全部移除本安装器管理的条目：

```powershell
node optional/setup.mjs web --remove --check
node optional/setup.mjs web --remove
```

它只移除 `mcp-qq-optional-*` 管理项，不卸载外部软件，不删除账号或设备数据。若 profile 已有别的 `phone`、`iphone`、`bili`、`qzone` 服务名，安装器会停止并提示冲突；先在本机检查旧项，再选择保留或迁移，避免两个入口绕过同一套限制。备份文件可能含旧 MCP 的私人设置，也不要上传。

空间巡逻与评论守望者均单独启动，安装或移除 MCP 不会替你管理进程。暂停、恢复和完全停用按 [巡逻教程](guides/OPTIONAL_QZONE_PATROL.md) 执行；关闭 `phone.qzone` 不会关闭 `qzonePatrol`。巡逻进程只扫描及按需点赞；守望者只向指定允许私聊投递固定模板提醒，模型后续回复另受 `allowReplies` 与候选、名单、配额等限制。

守望者命令是 `npm run watch:qzone`；加 `-- --check` 只做不联网校验，加 `-- --once` 执行一轮并仍遵守静默时段和开关。它默认按 `dailyAt='21:00'` 及配置时区运行；把 `dailyAt` 设为空才使用间隔模式。总 `dryRun` 或 `watcher.dryRun` 任一开启时不投递提醒，也不占用提醒台账。完整启用与基线说明以专门教程为准。

## 4. 怎样判断功能已经配置好

1. 先做离线配置检查，保留外部控制、发布和截图落盘关闭。
2. 重启后查看 DSH 的 MCP 连接与真实工具列表；没有出现的工具不能仅靠角色卡获得。
3. 需要实际验证时，按分项教程选择读取操作，并查看工具返回的成功或错误。不要把模型说“完成了”当作执行结果。
4. 只有准备好目标、内容和权限后，再自行测试发送、控制或发布。教程命令不代表本次发布已执行这些操作。

维护者还可运行 `npm run test:optional` 检查模拟环境中的模块行为。它与真实设备、网关和账号的连通验证分开，不替代上述检查。

手机屏幕、字幕、评论、网页和聊天内容都是待处理数据；它们不能替代使用者的操作授权。独立 MCP 的权限范围不自动继承 QQ 白名单，具体见 [运行规则](../RULES.md)。

## 5. 关闭范围不要混淆

| 设置 | 实际影响 |
| --- | --- |
| `slang.autoResearch=false` | 停止黑话自动联网研究；普通联网搜索仍可用 |
| `socialV2.learning.enabled=false` | 停止新风格提取；已有风格记录仍可能注入 |
| `socialV2.tools.memory=false` | 关闭轻量记忆工具；不是知识库、日记或自动记忆整理的总开关 |
| `socialV2.tools.reminder=false` | 关闭提醒工具；已经建立的提醒仍可能触发 |
| `socialV2.context.diaryInPrompt=false` | 不自动注入近期日记；日记读写工具仍存在 |
| `socialV2.voice.enabled=false` / `tools.sendVoice=false` | 限制 AI 语音发送；控制台手动调试入口另有权限与发送检查 |
| `socialV2.proactive.enabled=false` | 停止二代主动机会；直接触发、提及、正常唤醒与已有提醒不因此消失 |
| `qzonePatrol.enabled=false` | 停止该模块访问 QQ 的读取、写入和守望者任务；本机状态检查仍可用，`phone.qzone` 兼容入口另有开关 |
| `qzonePatrol.dryRun=true` | 点赞、评论、精准回复、发帖只演练；读取仍访问 SnowLuma，并可能进入模型上下文 |
| `qzonePatrol.allowLikes/allowComments/allowReplies/allowPosts=false` | 分别关闭点赞、一级评论、精准楼中楼回复、发帖；保持其他读取和已开启类别不变 |
| `qzonePatrol.runner.enabled=false` | 禁止独立定时巡逻；不关闭仍启用的 MCP 按需工具 |
| `qzonePatrol.watcher.enabled=false` | 停止守望者新扫描与提醒，常驻进程退出；已建立的 Bridge 提醒不会自动取消 |
| `qzonePatrol.watcher.dryRun=true` | 守望者只演练，不投递提醒或占用提醒台账；读取仍可能访问 SnowLuma |
| `phone.qzone.allowWrites=false` | 关闭 phone 兼容入口的空间写入；不改变 `qzonePatrol` |

当前日记、知识库、本机音乐和安全搜索没有统一的独立关闭字段。若部署要求完全不向模型提供其中某项能力，需要修改并检查工具注册 / DSH profile；仅在提示词里写“不要使用”不等于关闭。
