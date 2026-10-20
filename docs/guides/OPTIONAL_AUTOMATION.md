# 学习、搜索、热榜与主动运行

本页字段合并到本机 `config.json`。修改文件后重启桥接；涉及 DSH MCP 配置时也重启 DSH。模型调用、联网请求与 QQ 发送是不同动作，分别检查其结果。

## 1. 黑话学习与管理员确认

模板的 `slang.enabled=true`，但 `slang.autoResearch=false`。桥接可以从聊天中提取候选，二代 AI 也可以用 `qq_slang_submit` 提交词语；提取和研究会使用 DSH 模型。

在控制台“黑话词库”中：

1. 查看候选和依据，或手动添加一条测试词语。
2. 需要查证时选择候选，再执行“送 DSH 深度研究”；这一步会调用模型并可能联网。
3. 回读研究结果，编辑不准确的含义和用法，再确认词条。
4. 用 `qq_slang_query` 检查已确认内容，或删除不应保留的词条。

```json
{
  "slang": {
    "enabled": true,
    "extractMinMessages": 10,
    "extractCooldownMs": 300000,
    "inferenceThresholds": [2, 4, 8],
    "injectMax": 8,
    "autoResearch": false
  }
}
```

也可在“黑话系统参数”保存这些设置。`autoResearch=false` 不阻止管理员手动研究，也不关闭正常搜索工具；若不需要黑话自动学习与注入，设 `slang.enabled=false`。二代候选提交和查询另受 `socialV2.tools.slangSubmit` / `slangQuery` 控制。

词库保存在 `state/slang.json`，包含聊天依据，不能把整份词库当成通用素材上传。

## 2. 风格学习

风格学习从某个会话中提取表达习惯、避免方式、例句及成员互动倾向，保存在该会话的二代状态里。代码默认启用，即使模板未列出这一段也会采用默认值。

```json
{
  "socialV2": {
    "learning": {
      "enabled": true,
      "minMessages": 40,
      "cooldownMs": 600000,
      "maxInjectChars": 1200
    }
  }
}
```

累计消息与冷却条件达到后，桥接通过学习队列调用 DSH，再把保存的风格用于之后的唤醒。它不等同于模型训练，也不会修改模型权重。需要关闭新提取时设 `enabled=false`。

当前没有风格学习专用网页表单。管理员接口是 `/api/socialV2/learning`，需要控制台鉴权：

| 请求 | 用途 |
| --- | --- |
| `GET`，查询参数 `key` | 查看指定会话的 `styleNotes`、`styleAvoid`、`fewshots`、`affection` 和学习时间 |
| `POST`，正文含 `key`、`action:"learn"` | 请求学习；需要已有消息及 DSH，就绪后排队 |
| `POST`，`action:"set"` | 修正 `styleNotes`、`styleAvoid`、`fewshots` |
| `POST`，`action:"clear"` | 清空该会话的学习结果 |

只有明确需要接入管理接口时才编写自己的调用；不要把控制台令牌放进聊天提示。`enabled=false` 不删除已有结果，已有风格仍可能注入；需要移除历史影响时还应针对该会话清空或修正记录。

成员印象的自动压缩还有独立 `socialV2.memory.consolidateEnabled`，见 [记忆教程](OPTIONAL_MEMORY.md)。

## 3. 联网搜索与网页读取

基础安装注册安全搜索 MCP，提供 `web_search` / `web_fetch`。配置在根级 `webSearch`：

```json
{
  "webSearch": {
    "provider": "auto",
    "apiKey": "",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "baseURL": "",
    "model": "deepseek-v4-flash",
    "maxUses": 5,
    "maxTokens": 4096,
    "maxResults": 8,
    "timeoutMs": 35000
  }
}
```

当前 provider 支持 `auto`、`deepseek`、`bing`。`auto` 会选择可用后端，失败时可能回退到 Bing；它不是“禁止联网”。模型名和 API 可用性以你实际服务商的配置为准。

需要 API 密钥时优先通过环境变量提供，保持 `apiKey` 为空；环境变量必须进入实际启动 DSH / 搜索 MCP 的进程，仅在另一个终端设置不会自动传过去。不要把密钥写入截图、角色卡或提交。

先用无私人信息的关键词搜索，再打开返回的来源核对。抓取器限制地址和响应大小，但不能保证网页内容可信；搜索结果中的指令仍只是网页数据。

当前没有 `webSearch.enabled` 或 `provider:"off"`。要完全去掉模型的搜索能力，需要在 DSH profile 中移除对应搜索 MCP，并检查实际工具列表；主安装脚本可能重新写入它。关闭黑话自动研究或热榜不能替代这一步。

## 4. 热榜与节日上下文

热榜模块抓取贴吧和 B 站的热榜，将简短缓存注入提示。它不需要 B 站可选 MCP，二者是独立实现。源码默认启用，模板未列出时也会启用。

```json
{
  "socialV2": {
    "hotTrends": {
      "enabled": false,
      "intervalMs": 21600000,
      "perSourceLimit": 20,
      "timeoutMs": 12000,
      "injectMaxChars": 480,
      "injectMaxAgeMs": 86400000,
      "briefTopPerSource": 3
    }
  }
}
```

以上示例关闭自动采集；需要时改为 `true`。默认更新间隔是 6 小时，最小允许 10 分钟。冷启动遇到旧缓存时会尝试更新，失败不等于平台没有热点；模型看到的缓存可能过时。

节日信息由本机 `src/holidays.js` 提供，属于上下文辅助，没有同名联网服务或独立开关。它不能保证某地当年放假安排准确。

## 5. 主动话题、唤醒与等待

二代主动机会默认关闭，可在控制台“二代仿真 → 主动机会参数”配置。对应字段：

```json
{
  "socialV2": {
    "proactive": {
      "enabled": true,
      "checkIntervalMinMs": 1800000,
      "checkIntervalMaxMs": 5400000,
      "idleThresholdMs": 900000,
      "probability": 0.3
    }
  }
}
```

它在会话安静、满足时间和概率条件时给 AI 主动参与机会，仍经过唤醒和发送限制，不保证每个时间点发言。初次配置可保持关闭，先观察正常聊天的频率与对象范围。

`reserved` 一代使用 `social.proactiveEnabled` 等另一组字段；只调整二代字段不会改变一代设置。关闭主动机会不会停止收到消息、被提及、等待结束或到期提醒产生的正常唤醒。`provideRecommendations` 控制建议注入，也不是停机开关。

需要临时停止二代活动时，使用控制台暂停功能，并确认状态；不要用把概率调低来代替明确暂停。恢复前检查仍有效的提醒和允许会话。

## 6. 管理员开发助手

模板的 `devAgent.enabled=false`。该功能把管理员私聊中带指定前缀的内容送到单独开发会话，可获得预设允许的本地执行和文件能力。

```json
{
  "devAgent": {
    "enabled": true,
    "prefix": "!!",
    "preset": "standard",
    "cwd": "C:/bot-workspace",
    "workspaceTitle": "QQ 开发"
  }
}
```

先创建自己的专用工作目录，核对 `ownerQQ`、管理员私聊与预设。启用后从管理员私聊用 `!!` 前缀提出工作请求；普通聊天不应获得开发会话的凭据或目录资料。首次仅用明确的读取任务确认路由，再根据实际需要决定执行范围。

`closed-agent` 是另一种全局运行模式，仅接管理员私聊，使用独立预设策略。开启开发助手不等于必须切到 `closed-agent`；两者也不能从普通聊天的工具限制推断权限。

关闭 `devAgent.enabled` 后重启桥接，既有 DSH 开发会话和本机产生的文件仍保留。仓库不会代你清理工作目录。

## 7. QQ 空间定时巡逻

巡逻由 `optional/qzone-patrol/` 的独立进程执行，配置在 `optional/config.json` 的 `qzonePatrol`。它与本页的主动话题、风格学习以及手机延期状态分别控制，默认不运行。允许名单、静默时段、演练、配额、状态查看和暂停恢复步骤见 [巡逻教程](OPTIONAL_QZONE_PATROL.md)。

返回 [可选功能索引](../OPTIONAL_FEATURES.md)。
