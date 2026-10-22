# 可选 QQ 空间模块

**本页保留 `phone.qzone` 兼容入口。新部署推荐 [空间扩展与巡逻](OPTIONAL_QZONE_PATROL.md) 的 `qzonePatrol` / `mcp__qzone__*`。** 新入口提供 9 个工具，增加自己的说说与评论读取、精准楼中楼回复、发帖，以及持久配额与去重；另有默认关闭的评论守望者。按需使用时不必启动巡逻或守望者。

两套入口的开关和额度互相独立。需要统一限制空间互动时，保持本页 `phone.qzone` 关闭或至少 `allowWrites=false`，只启用新入口需要的能力。原有 phone 工具名称保留兼容；不要同时加载另一个同名 `phone` 或 `qzone` MCP 服务。

这个模块通过本机 SnowLuma 的 HTTP API 读取动态、发布说说、点赞和评论。它不需要 Android、iPhone 或 ADB，也不读取或保存 QQ Cookie。默认关闭；启用后默认只提供读取工具。

代码位于 `optional/phone/`，MCP 名称为 `phone`。Android 与 QQ 空间共用这个 MCP 进程，但分别开关。

## 1. 准备网关

先完成主仓库的 QQ 桥接安装，手动登录 SnowLuma，并在本机打开 OneBot HTTP 服务。确认你的 SnowLuma 版本提供以下扩展动作；普通 OneBot v11 网关不一定支持 QQ 空间：

| 本模块工具 | SnowLuma HTTP 动作 |
|---|---|
| `qzone_feeds` | `get_qzone_feeds` |
| `qzone_my_posts`、`qzone_user_posts` | `get_qzone_msg_list` |
| `qzone_post` | `send_qzone_msg` |
| `qzone_like` | `like_qzone` |
| `qzone_comment` | `comment_qzone` |
| `qzone_recent_like` | 读取动态，再点赞，可选评论 |

地址只能是 `127.0.0.1`、`localhost` 或 `::1` 的 HTTP/HTTPS 根地址，不接受 URL 中的用户名、密码、路径、查询参数或跳转。

## 2. 先启用读取

完成 [快速开始](../QUICKSTART.md) 的主安装后，在仓库根目录先同步当前预设，再准备本机可选配置。下面使用默认 profile `web`；使用其他 profile 时，主安装与可选安装的名字必须保持一致。

```powershell
node scripts/setup-dsh.mjs web
if (!(Test-Path optional/config.json)) {
  Copy-Item optional/config.example.json optional/config.json
}
```

把以下字段合并到 `optional/config.json` 的 `phone.qzone` 对象中，保留其他模块现有设置；这是局部示例，不能用它覆盖整份配置：

```json
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:3000",
  "accessTokenEnv": "SNOWLUMA_ACCESS_TOKEN",
  "allowWrites": false,
  "imageDirs": []
}
```

`baseUrl` 要手动填成你的 OneBot **HTTP** 地址。模板已填 `3000`，不会自动跟随主配置中改变的端口；不要填 SnowLuma 管理页面或 WebSocket 地址。

鉴权有两种来源，优先级从高到低：

1. 启动 DSH 的进程所继承的 `SNOWLUMA_ACCESS_TOKEN` 环境变量。
2. 仓库根 `config.json` 的 `snowluma.accessToken`。

`accessTokenEnv` 填环境变量的名称，不能把真实令牌写进这个字段。HTTP 和 WebSocket 令牌可能不同，必须使用 HTTP 服务接受的那个。根配置令牌在每次调用时重读；没有可用令牌时直接报错，不降级为匿名调用。

安装可选 MCP 配置：

```powershell
node optional/setup.mjs web --check
node optional/setup.mjs web
```

然后重启 DSH。若使用非默认 profile，按照 [可选模块总览](../OPTIONAL_FEATURES.md) 的安装参数指定目标 profile。安装器不会替你启动 SnowLuma，也不会访问 QQ 空间。

如果已有其他来源的 `serverName=phone` MCP，安装器会要求先处理名称冲突，不能同时用同一个名字加载旧服务器和本模块。

## 3. 核对读取结果

启用后应看到：

- `mcp__phone__qzone_feeds`：好友动态，最多 20 条、最多第 5 页。
- `mcp__phone__qzone_my_posts`：自己的说说。
- `mcp__phone__qzone_user_posts`：指定账号对当前登录账号可见的说说。

可以先要求机器人“读取最近 3 条空间动态，只概括，不互动”。核对实际内容是否来自预期账号。对方设置空间权限、网关不支持动作或返回格式不同，都会明确报错；合法空列表才表示本次没有读到条目。

读取指定账号有本进程限频：3 分钟最多 5 次，滚动 24 小时最多 40 次。不提供绕过空间权限的方法。

## 4. 按需开放写操作

只有你需要机器人对外发布或互动时，才将 `allowWrites` 改为 `true`，重新运行安装器并重启 DSH。此后新增：

| 工具 | 用法 |
|---|---|
| `qzone_post` | `content` 为正文，可选 `images` |
| `qzone_like` | 使用刚读到的 `tid`、`targetUin`，可带 `abstime` |
| `qzone_comment` | 指定 `tid`、`targetUin` 和评论正文 |
| `qzone_recent_like` | 默认最新一条；`who` 按完整昵称或账号精确匹配，可带 `comment` |

开关开放的是能力；机器人仍应按你的明确要求或已授权的任务范围使用。昵称同时对应不同账号时，快捷点赞拒绝猜测。

发帖与点赞共用本进程限频：每分钟 1 次，滚动 24 小时 8 次。评论单独限频：10 分钟 1 次，滚动 24 小时 3 次。请求发出前预留额度，失败不会自动重试；重启 MCP 后计数重置。这不是账户级的持久配额。

如果快捷点赞已成功、随后评论失败，会分别报告两部分结果。不要为补评论重复整次“点赞并评论”。接口成功表示网关接受了动作；发帖最终显示效果仍应在 QQ 空间查看。

## 5. 发布配图

将自己的图片目录加入 `phone.qzone.imageDirs`，例如把以下字段合并到 `phone.qzone` 对象，保留该对象中的其他字段：

```json
{
  "imageDirs": ["C:/BotMedia/Qzone"]
}
```

最多 9 张，每张不超过 8 MB；支持 PNG、JPEG、GIF、WebP 内容签名。传目录中的文件名或完整路径。程序检查真实路径，拒绝目录穿越和越出允许目录的链接文件。

本模块不把任意图片 URL 交给网关下载。网络图片请先自行保存到允许目录；`imageDirs` 为空时只能发布纯文字。

## 6. 与定时巡逻的区别

本页的 `phone.qzone` 提供按需读取与写入；推荐的新入口使用本仓库独立实现的 `optional/qzone-patrol/`、`qzonePatrol` 配置和 `qzone` MCP，同时提供 9 个按需工具及可单独启动的定时巡逻，见 [空间扩展配置与使用教程](OPTIONAL_QZONE_PATROL.md)。精准回复采用新入口读取评论时生成的候选 ID，不接受模型自行拼接评论账号和标识。

两套模块独立开关、独立限频。巡逻的允许名单、持久配额和去重不会覆盖本页的 `phone.qzone` 写工具；需要统一限制空间互动时，应保持 `phone.qzone.allowWrites=false`，只启用巡逻允许的动作。安装模块本身不会启动定时巡逻，也不会自动点赞或评论。

旧部署可能另装 `qzone-sweeper` 并占用 `serverName=qzone`。公开仓库不附带旧部署的词库、私人配置或运行状态，两者的配置与历史格式也不通用。先在自己的 DSH profile 中处理服务名称冲突；不要把旧插件的定时任务或个人状态直接复制进来。

## 7. 排障与关闭

| 情况 | 检查 |
|---|---|
| 看不到空间工具 | `enabled`、安装器是否运行、DSH 是否重启 |
| 只能读取，没有发布工具 | 默认 `allowWrites=false`；需要时显式开启并重启 |
| HTTP 失败或鉴权失败 | HTTP 地址、端口、令牌来源；别混用管理页与 WebSocket |
| 某个空间看不了 | 对方权限、账号可见范围及网关功能；不要连续重试 |
| 列表格式不支持 | 当前网关返回格式与本模块不一致，不能解读为“没有动态” |
| 配图失败 | 文件存在、允许目录、真实路径、大小与内容签名 |
| 达到限频 | 等待相应时间窗口，不重复调用 |

关闭写操作：改 `allowWrites=false`。只停用 QQ 空间：改 `phone.qzone.enabled=false`，重新运行 `node optional/setup.mjs web` 并重启 DSH，保留 Android 和其他模块的现有开关。

`node optional/setup.mjs web --remove` 会移除本安装器管理的**全部**可选 MCP 挂载，包括 iPhone、Android/QQ 空间、巡逻和 B 站，不能用作只停用空间模块的命令。全部移除后也需重启 DSH；它不会停止另开的巡逻进程、退出 QQ 登录、卸载外部程序或删除账号数据。

本地配置、令牌、图片和真实动态都不应提交 Git。离线验证命令为 `node scripts/test-optional-phone.mjs`；它使用合成 HTTP/ADB 替身，并用临时配置核对 MCP 工具列表，不会访问真实账号或设备。
