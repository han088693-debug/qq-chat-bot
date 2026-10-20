# B 站只读 MCP 接入

本仓库提供 Node 代理，外部 Python 服务自行安装。QQ 聊天侧只开放四项工具：

| 工具 | 用途 |
| --- | --- |
| `bili_search` | 搜索视频 |
| `bili_video_info` | 视频信息 |
| `bili_comments` | 读取评论 |
| `bili_subtitle` | 读取可用字幕 |

代理在列出工具和调用工具两处检查名称，并强制设置子进程 `BILI_MCP_TOOLS` 为这四项。即使外部服务不识别此环境变量，代理也不会转交其他工具。评论、字幕等返回内容仍会进入模型上下文。

## 1. 准备外部服务

本教程采用 [adoresever/bilibili-mcp](https://github.com/adoresever/bilibili-mcp)，其许可署名为 AGI_Ananas，使用 MIT。核对的公开提交是 `1521d19d4118bfe23e08ec4c7702991c5f9de0ba`。它要求 Python 3.10+，入口为 `mcp_server.py`，以 stdio 提供 MCP。

在仓库外准备一个**新的空目录**。下面只下载指定源码、依赖清单、登录工具和许可，不下载账号资料或凭据备份：

```powershell
New-Item -ItemType Directory -Path 'C:\tools\bili-duty'
Set-Location 'C:\tools\bili-duty'
$sourceBase = 'https://raw.githubusercontent.com/adoresever/bilibili-mcp/1521d19d4118bfe23e08ec4c7702991c5f9de0ba'
foreach ($sourceFile in @('mcp_server.py', 'bili_login.py', 'requirements.txt', 'README.md', 'LICENSE')) {
    Invoke-WebRequest -Uri "$sourceBase/$sourceFile" -OutFile $sourceFile
}
py -3 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt 'mcp>=1,<2'
```

若已安装兼容的服务，不必重复下载或覆盖它；下面填写其实际 Python 路径、脚本和工作目录。这里限制 MCP SDK 1.x，是为了配合该入口使用的 `mcp.server.fastmcp`。依赖安装成功与平台接口可用是两回事，后者仍需实测。

## 2. 在外部目录完成登录

该实现的读取工具也会要求本机登录凭据。由使用者在自己的终端运行：

```powershell
& .\.venv\Scripts\python.exe .\bili_login.py
```

按外部程序的提示自行扫码、确认；完成后产生 `bili_credential.json`。二维码、凭据、备份和终端截图留在本机，不复制进 QQ 机器人仓库。

登录失败按上游说明排查。不要把登录工具临时加入 QQ 代理：普通聊天侧仍只保留四个读取工具。外部服务原本还提供评论、动态、私信等写操作，本接入不开放这些能力。

## 3. 配置 QQ 侧代理

返回 QQ 机器人仓库，先按 [总教程](../OPTIONAL_FEATURES.md#2-两份配置文件) 同步新版预设并复制可选配置。只修改 `optional/config.json` 的 `bilibili` 部分：

```json
{
  "bilibili": {
    "enabled": true,
    "command": "C:/tools/bili-duty/.venv/Scripts/python.exe",
    "args": ["C:/tools/bili-duty/mcp_server.py"],
    "cwd": "C:/tools/bili-duty",
    "env": {}
  }
}
```

`command` 必须是实际 Python 可执行文件的绝对路径，`cwd` 必须存在。`env` 只在外部服务确有需要时填写非私密设置；不要将账号凭据复制进去。无论怎样填写 `BILI_MCP_TOOLS`，代理都会覆盖为四项只读列表。

```powershell
node scripts/setup-dsh.mjs web
node optional/setup.mjs web --check
node optional/setup.mjs web
```

重启 DSH。若使用其他 profile，请在三条命令中使用同一个名字。安装器写入 `serverName: bili`，DSH 中可见名称通常带 `mcp__bili__` 前缀。

## 4. 验证和停用

1. `--check` 检查文件、配置和 profile，不登录 B 站、不调用 Python 服务。
2. 重启后查看 MCP 列表，应只出现上述四项。若出现其他 B 站工具，检查是否还保留了旧的直连 MCP 配置。
3. 需要真实验证时，先搜索一个无私人信息的公共关键词，再读取一个公开视频的详情。字幕不存在、评论受限或登录失效都可能导致读取失败，应依据工具错误处理。
4. `isError` 或失败结果不能当成查询成功，模型自己描述“已读取”也不够。

停止该能力：设 `bilibili.enabled=false`，重新运行可选安装并重启 DSH。它不会删除外部服务及其凭据，也不会退出 B 站账号。

本仓库的热榜采集是独立模块，关闭 B 站 MCP 不会自动关闭 `socialV2.hotTrends`。反过来也一样。

返回 [可选功能索引](../OPTIONAL_FEATURES.md)；许可关系见 [第三方说明](../../THIRD_PARTY_NOTICES.md)。
