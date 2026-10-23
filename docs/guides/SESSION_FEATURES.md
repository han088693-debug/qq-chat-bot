# 会话功能与升级

本页说明按会话模型设置、日记隔离、角色卡注入、Bridge 插件和本地聊天指标。基础安装见 [快速开始](../QUICKSTART.md)；这里的配置与 API 示例只供本机管理员使用。

## 1. 按会话模型与思考强度

桥接读取 `config.json` 中的 `socialV2.sessionPolicies`，并通过 `/api/socialV2/policy` 提供读写。会话 key 的格式是 `private:<QQ号>` 或 `group:<群号>`，尖括号及其中说明必须换成本机实际值，不能直接作为有效 key 使用。

| 字段 | 当前实际用途 |
| --- | --- |
| `model` | 覆盖该会话的模型 ID；仍使用全局 `dsh.provider` |
| `reasoningEffort` | 覆盖该会话思考强度，桥接接受 `low`、`high`、`max` |
| `mode` / `preset` | 策略层校验、保存与返回；尚未替代主流程的全局模式、预设选择和收发分支 |

思考强度依次取会话覆盖、`dsh.effortByKind.private` / `.group`、`dsh.reasoningEffort`。模型未覆盖时使用 `dsh.model`。实际模型 ID 和强度还必须受当前 DSH provider 支持；配置被保存不代表服务商已接受该模型。

按会话策略不会自动开放白名单。模式与预设仍从控制台的全局设置决定，不能通过策略中的 `modeAllowed` 或 `preset` 字段推断实际权限已经改变。控制台「会话与审批」页可按会话编辑模型与思考强度；`mode` / `preset` 仅显示且不可编辑。保存后回读生效值，点击「清除」恢复全局默认。

### 用配置设置

下面是**合并片段**，保留本机配置的其他字段。`private:<QQ号>` 仅为位置说明，应换成自己的有效会话 key。

```json
{
  "dsh": {
    "effortByKind": {
      "private": "high",
      "group": "low"
    }
  },
  "socialV2": {
    "sessionPolicies": {
      "private:<QQ号>": {
        "reasoningEffort": "high"
      }
    }
  }
}
```

直接修改文件后重启桥接，再回读策略。不要把自己的账号、端点或模型凭据提交到示例文件。覆盖对象损坏时，程序会记录错误并回退到默认策略；检查日志，不能把“程序仍在运行”当成覆盖已生效。

### 用本机 API 读写

在仓库根目录运行以下 PowerShell。示例使用默认控制台端口，若已更改 `consolePort`，对应调整 `$bridgeBase`。只在变量中读取管理令牌，不把它写入命令参数、聊天内容或输出。

```powershell
$bridgeBase = 'http://127.0.0.1:3100'
$conversationKey = Read-Host '输入已有会话 key（private:QQ号 或 group:群号）'
$localConfig = Get-Content -LiteralPath .\config.json -Raw | ConvertFrom-Json
$consoleAccess = [string]$localConfig.consoleToken
if ([string]::IsNullOrWhiteSpace($consoleAccess)) {
  $consoleAccess = (Get-Content -LiteralPath .\state\console-token -Raw).Trim()
}
$headers = @{ 'x-console-token' = $consoleAccess }
$policyUrl = $bridgeBase + '/api/socialV2/policy'
$queryUrl = $policyUrl + '?key=' + [uri]::EscapeDataString($conversationKey)
Invoke-RestMethod -Uri $queryUrl -Headers $headers
```

响应中的 `effective` 是解析后的模型和思考强度，`globalMode` 是全局模式，`policy` 是策略层解析结果。`policy.mode` / `policy.preset` 不能当成实际运行模式与建会话预设的证明。

确认目标后，仅修改该会话思考强度并回读：

```powershell
$body = @{ key = $conversationKey; reasoningEffort = 'high' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $policyUrl -Headers $headers `
  -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri $queryUrl -Headers $headers
```

若要覆盖模型，可在同一请求中增加 `model`，值须为当前全局 provider 中已配置的模型 ID。请求会保存到本机 `config.json`。改变覆盖项也会改变会话策略指纹，下一次处理可能退役旧映射并建立新上下文；不要为了切换参数反复写入不同策略。

恢复该会话的全部默认策略：

```powershell
$body = @{ key = $conversationKey; clear = $true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $policyUrl -Headers $headers `
  -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri $queryUrl -Headers $headers
```

`clear=true` 删除整个会话覆盖。对单个字段发送空字符串或 `null` 不等于删除已有值。未配置覆盖的旧会话继续使用原三项指纹，避免仅因升级就无故丢弃健康上下文。

## 2. 按会话日记

`qq_write_diary` 和 `qq_read_diary` 必须带当前会话令牌。桥接从令牌反查 key，再检查该会话是否仍被允许；模型无需自行填写另一份目标 key。

新日记存于 `state/diary/sessions/<scope>/`。二代唤醒只注入当前会话的日记，并按会话缓存；`socialV2.context.diaryInPrompt=false` 只关闭自动注入，不关闭两个日记工具。条数、长度及阅读范围见 [记忆教程](OPTIONAL_MEMORY.md)。

旧 `state/diary/` 根目录日记不会自动迁移或分发。保留原文件，必要时由管理员核实每条归属后整理；无法确定归属的条目不要放进任何聊天会话。知识库仍是实例共用资料，不能因日记隔离就把私密信息放入共用知识库。

## 3. 角色卡按需注入

二代唤醒按以下条件决定是否注入完整角色卡：

- 首次唤醒，或还没有成功注入记录；
- 当前角色、筛选后的卡片内容或 DSH 会话发生变化；
- 本轮存在上下文压缩提示。

其他轮次仅保留短提示；需要时模型仍可用 `qq_get_prompt` 读取角色与工具信息。角色文本先经过一代/二代小节筛选及 `role.maxInjectChars` 限制，再计算摘要。保存卡片后，下一次相关唤醒会检查新内容，无需重启 DSH。

记录位于本机 `state/wake-role-injections.json`。正常升级应保留它，不要删除整个 `state/` 来强制注入。角色卡决定人格，`dsh/agent-presets/` 决定聊天协议；修改预设仍需生成 patch、运行安装器并重启 DSH。

## 4. Bridge 插件与聊天指标

`src/plugin-host/` 负责插件加载、依赖、路由和失败隔离。目前的 `reminders`、`slang`、`token-ledger` 插件挂在 `/api/plugins/<id>/`，提供控制台管理入口；它们与 DSH 的 `plugins/qq-agent-presets/` 是两套不同的插件层。

插件路由继承控制台鉴权，聊天会话令牌不能进入该管理面。旧路由仍保留，并与新入口使用同一份状态文件；提醒到期触发仍由主桥接执行。当前没有完成所有功能插件化，也没有把这些数据整体迁到 `state/plugins/`。开发契约见 [CONTRACT.md](../../src/plugin-host/CONTRACT.md)。

控制台「人格与角色」页的「人味仪表盘」可按会话采集话轮、句长、工具痕迹和延迟等指标。也可在仓库根目录显式指定会话：

```powershell
$conversationKey = Read-Host '输入要查看的会话 key'
node scripts/persona-audit.mjs --key $conversationKey --days 1
```

增加 `--json` 输出结构化结果。它只读取本机状态和日志，不调用模型；结果受日志保留范围和启发式规则影响，不能当作角色质量评分或隐私审查结论。报告可能包含真实会话标识和聊天片段，分享前仍需脱敏。

出站处理会改写部分工具标识、内部字段串并过滤裸链接；这与敏感信息检查是不同步骤。诊断消息为何变化时，分别检查出站处理、发送闸门和日志。

`socialV2.wake.privateSkipProbability` 控制私聊唤醒时加入“这轮可以不回”提示的概率，默认 `0.15`，取值为 `0..1`，设为 `0` 可停用。首次唤醒不加该提示；它给模型选择空间，不是硬性丢弃收到的消息。

## 5. 归档会话恢复

DSH 就绪时，桥接会核对已有映射会话的归档状态，再继续投递排队消息。回合被 DSH 以 `blocked` 结束时，桥接尝试解除归档并补一次唤醒；解除失败则退役旧映射，并尝试向原 QQ 会话发送上下文重置提示。同一会话有 90 秒自愈冷却。

在本机日志中搜索 `blocked`、`已解除归档`、`启动自检` 可定位这条链路。DSH 协议不兼容、连接失败或补唤醒失败仍需人工检查。新上下文不会自动恢复旧会话所有内容。

## 6. 从旧版升级

1. 先停止桥接，保留自己的 `config.json`、`optional/config.json`、角色卡和 `state/` 备份。尤其保留日记、会话映射及空间互动去重状态。
2. 更新程序文件，处理自己的本地代码修改；不要把本机配置换成发布模板。
3. 在仓库根目录运行 `npm ci`，重新生成和安装预设：

   ```powershell
   node scripts/build-agent-preset-patches.mjs
   node scripts/setup-dsh.mjs web
   ```

   使用其他 DSH profile 时，把 `web` 换成同一目标 profile。安装方式是 bundle 与 Cordis profile，旧 `.agent-presets/` 目录不作为安装目标。

4. 已启用外部模块时，保留原独立配置，先执行 `node optional/setup.mjs web --check`，核对后再执行 `node optional/setup.mjs web`。只安装所需模块，最后重启 DSH。
5. 启动桥接，在控制台确认连接、全局模式、白名单和角色；回读所配置会话的策略。新日记没有旧条目不代表文件已丢失，先检查旧全局目录和归属。
6. 按当前改动运行相应离线检查，再单独安排已授权的真实往返验证。安装、离线检查及真实消息发送是不同步骤。

角色注入和插件宿主的离线检查入口：

```powershell
node --test src/core/session-router.test.mjs src/core/session-policies.test.mjs
node scripts/test-diary.mjs
node scripts/test-wake-role-card.mjs
node scripts/test-wake-role-inject.mjs
node scripts/test-plugin-host.mjs
```

这些是验证入口，不表示本机已经运行通过；本次发布实际执行的项目与结果见 [发布与验证说明](../RELEASE_REVIEW.md)。
