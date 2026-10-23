# QQ 空间工具、定时巡逻与评论守望者

空间模块提供五个读取工具及四个独立授权的写工具：点赞、一级评论、精准回复、发说说。巡逻进程按允许名单扫描，可单独开启自动点赞；评论守望者扫描自己的评论，并向明确配置的桥接私聊会话建立提醒。**各模块默认关闭，定时进程不随 `npm start` 或 MCP 安装自动启动。** 守望者本身不发评论；被提醒的会话仍须通过现有授权和精准回复检查。

本模块位于 `optional/qzone-patrol/`，配置在本机 `optional/config.json` 的 `qzonePatrol`，MCP 名称为 `qzone`。它独立于 [按需空间工具](OPTIONAL_QZONE.md) 的 `phone.qzone`，两者的开关、限频和目标限制分别生效。要让空间互动只经过巡逻限制，可保持 `phone.qzone.enabled=false`，或至少保持 `phone.qzone.allowWrites=false`。

## 1. 准备与默认值

需要 Node.js 与项目依赖，以及已经手动登录 QQ 的 SnowLuma。模块不依赖手机、ADB 或 Cookie 文件；读取需要 `get_login_info`、`get_qzone_msg_list`、`get_qzone_msg_detail`。点赞、一级评论、发说说分别需要 `like_qzone`、`comment_qzone`、`send_qzone_msg`。精准回复通过 `get_cookies` 临时取得当前账号的空间凭据，再访问固定的 QQ 空间回复接口；凭据不落盘、不展示。普通 OneBot v11 服务不一定实现这些接口。

先完成 [基础安装](../QUICKSTART.md)。在仓库根目录准备本机配置；已有配置不要覆盖：

```powershell
if (!(Test-Path -LiteralPath .\optional\config.json)) {
  Copy-Item -LiteralPath .\optional\config.example.json -Destination .\optional\config.json
}
```

模板中的巡逻配置如下。升级时把这个顶层对象合并进已有配置，保留其他模块的设置：

```json
{
  "qzonePatrol": {
    "enabled": false,
    "baseUrl": "http://127.0.0.1:3000",
    "accessTokenEnv": "SNOWLUMA_ACCESS_TOKEN",
    "dryRun": true,
    "allowLikes": false,
    "allowComments": false,
    "allowReplies": false,
    "allowPosts": false,
    "dailyReplyLimit": 10,
    "replyPerPostLimit": 3,
    "replyPerPersonLimit": 1,
    "replyMinGapSeconds": 60,
    "dailyPostLimit": 20,
    "postPerMinuteLimit": 3,
    "imageDirs": [],
    "imageMaxBytes": 8388608,
    "allowedUsers": [],
    "blockedUsers": [],
    "dailyLikeLimit": 8,
    "dailyCommentLimit": 3,
    "hourlyLimit": 6,
    "cooldownMinutes": 60,
    "scanPageSize": 12,
    "maxPostAgeHours": 72,
    "quietHours": {
      "start": "01:00",
      "end": "08:00",
      "timeZone": "Asia/Shanghai"
    },
    "runner": {
      "enabled": false,
      "intervalMinutes": 30,
      "autoLike": false
    },
    "watcher": {
      "enabled": false,
      "dryRun": true,
      "intervalMinutes": 10,
      "dailyAt": "21:00",
      "bridgeUrl": "http://127.0.0.1:3100",
      "bridgeTokenEnv": "QQ_BRIDGE_CONSOLE_TOKEN",
      "sessionKey": ""
    }
  }
}
```

旧的本机可选配置没有 `qzonePatrol` 时，会合并模板的关闭默认值。配置格式错误会停止操作，不会以“全部放行”或无配额的默认值继续执行。

| 字段 | 默认值与含义 |
| --- | --- |
| `enabled` | `false`；巡逻扫描及互动的总开关 |
| `baseUrl` | `http://127.0.0.1:3000`；SnowLuma 的 HTTP API 根地址，需按本机实际端口修改 |
| `accessTokenEnv` | `SNOWLUMA_ACCESS_TOKEN`；填写环境变量名称，不能填令牌本身 |
| `dryRun` | `true`；所有空间写入只演练，返回 `performed:false`；守望者也不投递提醒 |
| `allowLikes` / `allowComments` / `allowReplies` / `allowPosts` | 均为 `false`；分别开启点赞、一级评论、精准回复、发说说；演练也需要对应开关 |
| `allowedUsers` | `[]`；可读取和互动的其他账号；空数组拒绝所有外部目标。自己的说说/评论可独立读取，但只有名单内评论者可成为回复候选 |
| `blockedUsers` | `[]`；屏蔽优先，即使账号也在允许名单中仍拒绝 |
| `dailyLikeLimit` | `8`，允许 `0..200`；按配置时区的自然日统计点赞 |
| `dailyCommentLimit` | `3`，允许 `0..50`；按配置时区的自然日统计评论 |
| `dailyReplyLimit` / `dailyPostLimit` | `10` / `20`；按配置时区自然日统计，包含预占和未知结果 |
| `replyPerPostLimit` / `replyPerPersonLimit` | `3` / `1`；同一说说的回复数，以及同一人在同一说说下的回复数 |
| `replyMinGapSeconds` | `60`，不能低于 60；精准回复间隔，仍同时受全局冷却限制 |
| `postPerMinuteLimit` | `3`，允许 `0..3`；发说说最近一分钟上限 |
| `imageDirs` / `imageMaxBytes` | `[]` / `8388608`；明确允许的本地绝对目录与单张图片字节上限，最多 8 MiB |
| `hourlyLimit` | `6`，允许 `0..100`；四类空间写入合计的最近一小时上限 |
| `cooldownMinutes` | `60`，允许 `0..1440`；任何两次真实互动预占之间的最小间隔 |
| `scanPageSize` | `12`，允许 `1..50`；本轮合并后最多保留的候选数；每个账号最多读取 `min(3, scanPageSize)` 条 |
| `maxPostAgeHours` | `72`，允许 `1..720`；只接受这一时长内的动态 |
| `quietHours.start` / `end` | `01:00` / `08:00`；`HH:mm`，开始含、结束不含，支持跨午夜；相同时间表示不设静默时段 |
| `quietHours.timeZone` | `Asia/Shanghai`；用于静默时段和每日配额，使用有效的 IANA 时区名 |
| `runner.enabled` | `false`；独立定时进程开关；常驻运行和 `--once` 都要求它与顶层 `enabled` 为 `true` |
| `runner.intervalMinutes` | `30`，允许 `5..1440`；两轮间的等待分钟数 |
| `runner.autoLike` | `false`；对本轮候选尝试点赞；同时受 `allowLikes`、`dryRun`、配额及其他检查限制 |
| `watcher.enabled` / `watcher.dryRun` | `false` / `true`；评论提醒进程独立开关及投递演练，详见第 10 节 |

账号应作为字符串填写，只接受无前导零的正整数字符串，且必须能安全表示为整数。请在本机配置中填真实目标，不把名单放进示例、角色卡或 Git 提交。

HTTP 地址仅支持 `127.0.0.1`、`localhost`、`::1` 的 HTTP/HTTPS 根地址，不接受地址中的凭据、路径、查询参数或跳转。模板端口不会自动跟随主配置变化。

令牌先取巡逻进程或 DSH MCP 进程继承的指定环境变量；没有时读取根 `config.json` 的 `snowluma.accessToken`。必须是 HTTP 服务接受的令牌。仅在另一个终端设置环境变量不会影响已经启动的进程；没有可用令牌时不会匿名访问。

## 2. 先做离线检查

```powershell
npm run patrol:qzone -- --check
npm run patrol:qzone -- --status
```

`--check` 校验配置，`--status` 读取本机配置与巡逻状态；两者不访问网关，不会点赞或评论。`--status` 在模块关闭时仍可用于检查关闭状态。状态读取可能建立本机状态目录和短暂锁文件，不会清空配额。

`--status` 中的 `runner` 是已保存的配置，不能证明常驻进程正在运行；需同时查看运行它的终端。`counts` 是真实动作预占数，`lastScanAt` / `lastScanCount` 是最近扫描概况，`activeCandidates` 是仍有效的本机候选数，`dryRunCount` 仅统计保留的最近最多 100 条演练记录。状态检查不确认网关连接或当前登录账号。

自定义配置位置时，在启动这些命令的同一终端设置：

```powershell
$env:QQ_BOT_OPTIONAL_CONFIG = 'C:/bot-config/qq-optional.json'
```

安装到 DSH 时也使用同一变量；安装器会把此路径写入 MCP 环境设置。没有设置时默认读取仓库内 `optional/config.json`。

## 3. 单轮读取与演练

在本机配置中填写 HTTP 地址和允许名单，然后设置：

- `qzonePatrol.enabled=true`。
- `qzonePatrol.runner.enabled=true`。
- 保持 `dryRun=true`、`allowLikes=false`、`allowComments=false`、`runner.autoLike=false`。

执行一轮读取：

```powershell
npm run patrol:qzone -- --once
npm run patrol:qzone -- --status
```

这一步会访问真实 SnowLuma 的登录信息和允许目标的空间。静默时段、空允许名单或全部目标被屏蔽时，不会访问网关。扫描跳过当前登录账号、过期或明显未来的动态，以及网关标记为私密的条目；不绕过平台可见权限。

定时命令输出聚合概况，不打印账号、动态正文、评论、令牌或原始网关错误。全部目标读取失败会报告失败，不能解释成“这些人没有动态”；部分目标失败会报告失败数量。确认候选正文需使用下节的 MCP 扫描，读取结果可能进入 DSH 上下文。

每轮结果中的 `scanned` 是候选数，`failedTargets` 是读取失败目标数，`likesSubmitted` 是网关成功响应的点赞数，`likePreviews` 是演练数，`skipped` 是受去重、过期或配额等检查限制的候选数。`reason` 会说明只扫描、静默、空名单或配额限制等原因。

要预演自动点赞，把 `allowLikes=true` 和 `runner.autoLike=true`，仍保持 `dryRun=true`，再次运行 `--once`。演练仍检查目标、去重和当前配额，但不提交真实互动，也不消耗真实配额或占用成功动作去重记录；结果中的 `dryRun:true` 和 `performed:false` 不能作为真实点赞成功的证明。

## 4. DSH 中的巡逻工具

只有需要让模型查看候选或调用互动工具时，才安装巡逻 MCP。保持 `qzonePatrol.enabled=true`，按所用 profile 执行：

```powershell
node scripts/setup-dsh.mjs web
node optional/setup.mjs web --check
node optional/setup.mjs web
```

然后重启 DSH，查看真实工具列表。若 profile 已有其他 `serverName=qzone`，安装器会拒绝同名服务；先处理本机旧配置。原 `qzone-sweeper` 的代码、词库、私人状态及配置未导入本模块，不能直接混用。

| 工具 | 参数与用途 |
| --- | --- |
| `mcp__qzone__qzone_scan` | `{}`；扫描允许名单，返回候选摘要与 `candidateId`，自身不互动 |
| `mcp__qzone__qzone_status` | `{}`；查看开关、静默、配额、候选数和最近扫描概况 |
| `mcp__qzone__qzone_like` | `{ "candidateId": "扫描返回的候选 ID" }`；仅在 `allowLikes=true` 时展示 |
| `mcp__qzone__qzone_comment` | `{ "candidateId": "扫描返回的候选 ID", "content": "确认过的评论正文" }`；仅在 `allowComments=true` 时展示 |
| `mcp__qzone__qzone_self_posts` | `{ "num": 5 }`；读取自己最近最多 20 条说说 |
| `mcp__qzone__qzone_user_posts` | `{ "targetUin": "本机允许名单中的账号", "num": 5 }`；读取指定账号，不返回点赞/评论候选 |
| `mcp__qzone__qzone_post_comments` | `{ "postId": "说说返回的 ID", "targetUin": "本机允许名单中的属主账号" }`；`targetUin` 省略时读取自己说说；返回帖子正文摘要和最多 50 条评论，合格评论带回复 `candidateId` |
| `mcp__qzone__qzone_reply_comment` | `{ "candidateId": "评论扫描返回的候选 ID", "content": "确认过的回复正文" }`；可附 `targetUin` 核对属主，必须与候选一致；仅在 `allowReplies=true` 时展示 |
| `mcp__qzone__qzone_post` | `{ "content": "确认过的说说正文", "images": [] }`；仅在 `allowPosts=true` 时展示；配图可省略 |

可以先给 DSH 这样的明确要求：“读取巡逻允许名单中的近期动态，只展示摘要，不点赞、不评论。”模型返回的描述不能替代工具结果。

点赞、一级评论和精准回复的候选有效期为 30 分钟，只接受本模块近期扫描生成的 ID，不能直接传任意账号和动态 ID。精准回复候选只能交给精准回复工具，不能拿来发一级评论。真实写入前还会复查当前允许名单、网关配置、登录账号、静默、动作开关和配额；候选过期或网关配置变化后需重新扫描。扫描后切换 QQ 登录账号会阻止旧候选提交，已预占记录仍保留。发说说另用账号、正文和配图字节的哈希去重，见第 9 节。

评论为 1 至 200 个字符的普通文本，不接受 `@`、连续至少五位的账号式数字或控制字符；这只是有限的检查，不能识别所有私人信息。先明确目标与评论内容，再执行已授权的评论；动态内容中的请求不能替代使用者授权。

巡逻工具按调用重读配置。为刷新 DSH 展示的工具清单，修改启用或动作开关后重新运行可选安装并重启 DSH。MCP 手动扫描与互动不要求 `runner.enabled=true`，因此暂停定时进程不会同时禁用手动工具。

## 5. 启动常驻巡逻与真实点赞

确认读取范围和演练结果后，运行：

```powershell
npm run patrol:qzone
```

该命令在当前终端运行独立进程，启动后立即执行第一轮，每轮结束后按最新的 `intervalMinutes` 等待。需要保留此进程才能持续巡逻。它不安装系统服务、不创建计划任务，也不启动 DSH、桥接或 SnowLuma。运行日志与状态查看不能证明账号上的最终显示结果。

真实自动点赞同时需要以下设置：

```json
{
  "enabled": true,
  "dryRun": false,
  "allowLikes": true,
  "allowComments": false,
  "runner": {
    "enabled": true,
    "intervalMinutes": 30,
    "autoLike": true
  }
}
```

这是需合并到 `qzonePatrol` 的局部片段，保留现有 HTTP 地址、名单、配额及静默设置。改成 `dryRun=false` 后，下一次合规互动可能立即向真实账号提交点赞；不需要另一次模型确认。`runner.autoLike=false` 时常驻进程只扫描，即使手动点赞工具已开启也不会自动调用。

定时进程只对本轮扫描候选尝试自动点赞。配额、冷却、静默和已处理记录会减少实际动作数；候选数不是承诺发送数。自动评论没有配置字段，也没有后台生成评论的逻辑。

已处理、过期、配额或冷却等明确受限结果会计入跳过；网关结果未明、状态故障或配置错误会停止本轮，常驻进程也会退出。先检查原因再手动启动，不会持续重试失败的写请求。

## 6. 暂停、恢复、关闭与重启

| 目的 | 操作与边界 |
| --- | --- |
| 暂停当前常驻进程 | 在运行它的终端按 `Ctrl+C`；再次启动前检查当前配置 |
| 停用后续定时运行 | 设 `qzonePatrol.runner.enabled=false`；常驻进程重新检查到此值后退出，`--once` 也不执行 |
| 恢复定时运行 | 设 `runner.enabled=true`，确认顶层 `enabled=true`，重新执行 `npm run patrol:qzone` |
| 保留扫描、停止真实互动 | 设 `dryRun=true`，或分别关闭 `allowLikes` / `allowComments`；只关闭 `runner.autoLike` 仍保留手动写工具 |
| 完全关闭巡逻能力 | 设 `qzonePatrol.enabled=false` 和 `runner.enabled=false`，停止常驻进程，重新运行可选安装并重启 DSH |

配置按轮次、下一目标读取前及自动点赞前重读；修改配置不能撤回已经发出的网关请求。要立即停止持续运行，先在其终端结束进程，再修改配置。关闭 DSH 或桥接不会停止另开的巡逻进程；关闭巡逻也不会退出 QQ 或停用 `phone.qzone`。

在轮间等待时改为关闭，最迟到下一轮检查才会退出；`Ctrl+C` 会中断等待。正在执行的单次请求仍可能完成，暂停结果应结合终端退出和本机状态核对。

正常重启使用相同的 `state/optional/qzone-patrol/`，保留动作去重和配额。配置中的 `enabled` 不会自动启动进程；暂停后恢复、电脑重启或终端关闭后，都需要按上述命令重新启动。仓库未附开机自启配置。

## 7. 配额、去重与结果未明

巡逻在本机持久保存预占记录，然后才向网关提交动作。同一目标账号、同一动态、同类动作只能预占一次；点赞和评论分别记录。定时进程与 MCP 使用同一状态目录，通过跨进程锁共享配额和去重；同一目录同时只允许一个常驻或单轮定时进程，另开一个会报锁占用。更换登录账号不会清空这个目录的配额或去重记录。

每日上限按 `quietHours.timeZone` 的自然日重算，小时上限是最近 60 分钟，冷却在点赞与评论之间共用。任一相关配额设为 `0` 表示禁止该类互动尝试，演练也不执行，不表示无限制。状态中的计数包括成功、发送前预占以及结果未明的动作。

请求超时、网关报错、发出后中断或重启时留下的预占都不会自动重发。同一动作以后可能返回 `already_reserved`；先到 QQ 空间核对实际结果，不要反复调用或删除状态来强行重试。本版本不提供自动解除未知记录或清空去重的命令。

`performed:true` 表示网关返回了成功响应；账号页面的最终显示仍需在 QQ 空间检查。网关成功响应、模型说“完成”和用户看到动作生效是不同证据。

## 8. 本机数据、排障与验证

状态位于 `state/optional/qzone-patrol/`。其中包含候选账号、动态 ID、动作哈希、时间及运行信息，属于私人数据；不保存动态正文和评论正文并不意味着状态可公开。目录和本机配置均由 `.gitignore` 排除，已跟踪文件和历史提交仍需另外检查。详情见 [隐私说明](PRIVACY.md)。

状态损坏、无法持久保存、路径包含链接或锁无法取得时，模块停止对应操作；不会自动清空记录恢复额度。遇到 `state_busy` 时先检查是否另有进程正在运行。确认所有相关进程均停止后，再在本机检查遗留锁的归属；保留状态和必要诊断证据，不删除整个目录排障。

| 结果或问题 | 下一步 |
| --- | --- |
| `disabled` 或定时开关关闭 | 检查顶层 `enabled` 与 `runner.enabled`；手动工具和定时进程的要求不同 |
| `quiet_hours` / `no_allowed_users` | 检查配置时区、静默窗口与独立允许/屏蔽名单 |
| `token_missing` / 网关请求失败 | 检查 HTTP 地址、服务支持、实际进程的环境变量和根配置；不要贴出令牌 |
| `candidate_expired` / `candidate_source_changed` | 在当前配置下重新扫描；不要手工构造候选 |
| `candidate_account_changed` | 扫描后登录账号变化或无法确认；核对实际账号，保留预占并重新扫描 |
| `candidate_target_changed` | 传入的 `targetUin` 与候选绑定的说说属主不同；先核对读取结果，不用评论者账号代替属主 |
| `gateway_format` | 网关未返回可核实的帖子归属或评论格式；不创建候选、不猜测属主，先在本机核对网关版本和接口 |
| `quota_zero` / `quota_exhausted` / `cooldown` | 查看本机状态并等待适用窗口；重启不会恢复额度 |
| `already_reserved` | 已处理或结果未明；在 QQ 空间核对，不重复提交 |
| `config_changed` | 预占后配置改变，已停止提交并保留预占；核对配置和状态 |
| 看不到 MCP 工具 | 检查启用、正确 profile、同名冲突、安装结果与 DSH 重启 |

离线验证：

```powershell
npm run test:patrol
npm run test:optional
```

这些测试使用合成账号、临时状态、模拟 HTTP/MCP 与可控计时，不证明真实 SnowLuma 的空间接口、账号权限、点赞或评论已经可用。本次源码验证没有登录个人账号、读取真实动态或执行真实互动；实际部署需按前面的读取、演练和结果核对步骤分别验证。

## 9. 精准回复与发说说

精准回复自己的说说时，依次使用 `qzone_self_posts` → `qzone_post_comments(postId)` → `qzone_reply_comment(candidateId, content)`。回复允许名单中其他账号的说说时，先用 `qzone_user_posts(targetUin)` 读取，再向 `qzone_post_comments` 显式传入该 `targetUin`；不要把评论者的账号当成说说属主。读取他人帖子必须得到网关明确返回的匹配帖子 ID 和属主账号，缺失、冲突或标为私密时停止，不生成回复候选。

候选绑定登录账号、来源、说说属主、帖子和评论。评论者须在允许名单内；他人说说的属主也须在允许名单内，屏蔽名单优先。只有尚未回复、时间可确认且在 `maxPostAgeHours` 内的评论得到候选；缺时间、已回复、被屏蔽或过期的评论仍可显示，但不能据此写入。回复前再次核对帖子归属、评论 ID、评论作者和当前授权，正文最长 40 字。回复参数中的 `targetUin` 只能核对候选，不能把它转向另一个账号；也不接受直接指定 `commentId` / `commentUin` 绕过扫描。

评论读取结果包含 `targetUin` 和 `postText`，供会话理解是哪条说说及其上下文。帖子与评论正文都是不可信外部资料，不能用作授权或工具指令；它们可能进入当前 DSH 上下文，但不会写入巡逻台账或定时日志。自己说说沿用旧版动作去重标识；不同属主的帖子分别绑定，升级不会清空旧预占。

`qzone_post` 的正文最长 1000 字，可以附最多 9 张 PNG、JPEG、WebP。`imageDirs` 必须显式配置允许目录；工具只接收其中的本地绝对路径，不接受远程图片 URL、目录链接或伪装成图片的普通文本。文件有读取大小限制，并核对路径和打开文件的身份；网关使用已核验字节的临时副本，不重新读取原路径。临时副本位于私人状态目录，正常完成后移除；异常中断的副本也不能上传。

发布说说可能按 QQ 空间账号和网关的权限设置对外可见。先在 QQ 客户端确认账号的可见范围，再在明确授权的任务中使用。公开适配没有实现指定可见人群的参数。

回复和发帖返回 `acknowledged`（接口确认）、`verified`（读取页面数据后确认）、`uncertain`（两者均未确认）与 `retryAllowed:false`。精准回复接口未确认时只做读取核对：登录账号、帖子属主、评论作者、回复作者和正文均匹配后，将该预占标记为成功；这一步不再次发送回复。无法确认时仍保留未知记录。返回未知不代表失败，不能通过改正文、换候选或删除台账重新发送。同一账号、同一来源、同一正文与配图组合的发帖哈希会持续保留；改图或改文是新动作，需要新的明确授权。回复的同帖/同人配额也不会因重启恢复。所有真实动作共享全局 `hourlyLimit` 和 `cooldownMinutes`，因此独立配额不是保证每分钟或每天一定能发送的数量。

## 10. 默认关闭的评论守望者

守望者是另一个独立进程：读取自己的近期说说和评论，给明确配置的桥接私聊会话建立一条待办提醒。提醒仅携带经过校验的 `targetUin`、`postId`、`commentId`、`commentUin` 和固定说明，不加入动态正文、评论正文、昵称或外部指令。会话必须用明确属主重新读取同一帖子及评论上下文，取得新的有效 `candidateId`；是否回复仍由 `allowReplies`、`dryRun`、名单、静默、配额和持久预占决定。守望者仍只监看自己的说说，不因手动工具增加他人帖回复能力而扩大扫描范围，也不自动点赞、发一级评论或发说说。

| 配置 | 行为 |
| --- | --- |
| `watcher.enabled` | 默认 `false`；与顶层 `enabled` 同时开启才可运行 |
| `watcher.dryRun` | 默认 `true`；只读扫描，不投递提醒，也不建立真实提醒的基线或预占 |
| `watcher.intervalMinutes` | 默认 10，范围 `5..1440`；检查或轮询间隔 |
| `watcher.dailyAt` | 默认 `"21:00"`；按 `quietHours.timeZone` 每天到点执行一轮。设 `""` 切换为间隔模式 |
| `watcher.bridgeUrl` | 默认 `http://127.0.0.1:3100`；只能使用本机环回 HTTP/HTTPS 根地址 |
| `watcher.bridgeTokenEnv` | 默认 `QQ_BRIDGE_CONSOLE_TOKEN`；指定保存桥接管理令牌的环境变量名称，不把令牌写进配置 |
| `watcher.sessionKey` | 默认空，必须由操作者填写 `private:<目标账号>`；不自动猜 owner，也不接受群聊会话 |

先保证该私聊会话已经完成正常配置。守望者在真实投递前读取 Bridge 的状态和私聊名单：目标必须是 owner 或 `allow.private` 成员，并且不在 `deny.private`；Bridge 必须运行于未暂停的 `reserved2` 模式，且 DSH 已就绪。最终提醒接口还会自行复核当前模式下的目标许可。只在终端或凭据管理方式中设置管理令牌环境变量，不把它贴到截图、教程或提交中。

配置目标会话后，保持两个演练开关均为 `true`，再开启 `watcher.enabled`，执行：

```powershell
npm run watch:qzone -- --check
npm run watch:qzone -- --once
```

`--check` 只校验配置，不访问 Bridge 或 SnowLuma，也不证明令牌、会话或连接可用。`--once` 立即扫描一轮，忽略每天的计划时间，但仍遵守静默时段与所有开关。读取结果可能进入本机状态；命令行仅输出数量和结果，不打印账号或正文。

确认扫描范围后，在本机将 `qzonePatrol.dryRun` 和 `watcher.dryRun` 均改为 `false`，表示允许向指定会话投递提醒。首次真实运行只把现存评论登记为历史基线，不补发历史提醒；来源或登录账号改变后也会重新建立基线。随后每轮最多提醒一个新评论，其余留待后续轮次。要让模型执行精准回复，还需另行开启 `allowReplies` 并明确授权回复范围；只开启提醒不等于授予回复权限。

```powershell
npm run watch:qzone
```

进程必须持续运行才会定时检查；默认每天 21:00 到点后的一次检查执行扫描，后续检查不会重复执行当日轮次。若当天到点时处于静默窗口，会等到静默结束后的检查。进程不创建系统计划任务、不修改开机自启、不自动启动依赖服务；导入守望者或 MCP 模块供测试与集成使用也不会启动服务或扫描。

提醒通过 `POST /api/socialV2/reminder-add` 投递，预占在请求前落盘。超时、空回执或中断均保留未知记录，不会自动重投。返回 `delivered:1` 仅表示 Bridge 确认创建提醒，不能证明模型已醒来或 QQ 空间回复已发出。真实回复结果仍应查看精准回复工具的回执和 QQ 空间。

守望者使用同一私人 `patrol-state.json` 内的 `watcher` 字段保存基线、提醒哈希和状态，不保存评论正文；独立 `watcher.lock` 防止多个进程或手动轮次重叠。状态损坏、锁异常或配置变更时停止相关操作。不要删除基线或未知记录来补催。

暂停时将 `watcher.enabled=false`；运行中的进程在下次检查时退出，投递前也会重新检查。按 `Ctrl+C` 可立即结束等候。关闭守望者只停止创建后续提醒，已经进入 Bridge 的提醒仍可能唤醒会话；需要同时撤销实际回复权限时，把 `allowReplies=false` 或顶层 `enabled=false`，并在 Bridge 提醒列表中处理已创建的待办。`runner.enabled=false` 只停原来的巡逻定时器，`allowReplies=false` 只停精准回复，不替代守望者总开关。
