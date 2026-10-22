# 部署安全基线

本页列出当前实现的检查点和限制，供安装、升级或更改工具配置时核对。完整权限说明见 [RULES.md](../../RULES.md)，安装步骤见 [QUICKSTART.md](../QUICKSTART.md)。

## 初次配置

使用发布的 `config.example.json` 创建本机 `config.json`，并保留以下起点：

| 配置 | 初次设置 |
| --- | --- |
| `ownerQQ` | 模板为 `null`，由你填写自己的管理员账号 |
| `allow.private` / `allow.groups` | 模板为空，完成状态检查后再加入聊天对象 |
| `allowAllWhenEmpty` | `false` |
| `dsh.allowRemote` | `false` |
| `dsh.authToken` | 本机安装通常留空 |
| `devAgent.enabled` | `false` |
| `socialV2.voice.enabled` / `socialV2.tools.sendVoice` | `false` |
| `socialV2.asr.enabled` | `false`；准备本地转写程序与模型后再启用 |
| `slang.autoResearch` | `false` |
| `social.proactiveEnabled` / `socialV2.proactive.enabled` | `false`；按需开启主动发言 |
| `optional/config.json` 的各模块 `enabled` | 模板均为 `false`，按分项教程准备依赖后开启 |
| 设备 `allowControl` / QQ 空间 `allowWrites` / iPhone `saveScreenshots` | 模板均为 `false`，分别决定是否开放操作、写入与本地截图保存 |
| `qzonePatrol.enabled` / `runner.enabled` / `runner.autoLike` / `allowLikes` / `allowComments` / `allowReplies` / `allowPosts` | 模板均为 `false`；空间允许名单为空，`dryRun=true` |
| `qzonePatrol.watcher.enabled` | `false`；独立 `dryRun=true`、`sessionKey=""`，配置后仍需单独启动 |

功能关闭和未填白名单不代表软件完全不联网。DSH 连接、模型请求、已启用的搜索或热榜等功能有各自的访问路径；具体数据流见 [隐私说明](PRIVACY.md)。

## 预设与工具

通过 `node scripts/setup-dsh.mjs` 将聊天预设安装到实际使用的 DSH profile，并重启 DSH。确认 `qq-chat`、`qq-chat-v2` 存在，再在桥接控制台显式选择目标模式。

普通 QQ 聊天缺少专用预设时，预期行为是拒绝建会话；不要改成自动退回包含完整本地工具的默认预设。

当前工具约束同时使用注册期隐藏和执行期允许列表。`optional/` 为手机、QQ 空间和 B 站提供额外适配，必须在主安装之后单独配置安装。它不会替使用者安装外部软件、登录或配对；启用后应查看真实工具清单及其副作用。独立 MCP 不自动继承 QQ 白名单的逐会话边界，控制开关也不等于逐用户授权，详见 [总教程](../OPTIONAL_FEATURES.md)。

巡逻和指定账号读取受空间允许名单约束，空名单不放行他人目标；自己的说说另有读取入口。点赞、评论和精准回复要求近期候选，发帖使用独立开关和内容防重；所有真实写操作先持久预占，结果未明不会自动重试。需要收紧空间写入时，同时检查 `phone.qzone.allowWrites` 和 `qzonePatrol`，不能用其中一套限制推断另一套也被限制。完整操作步骤见 [巡逻教程](OPTIONAL_QZONE_PATROL.md)。

守望者只向显式配置、被桥接许可的私聊会话投递提醒，要求二代模式且 DSH 就绪；首次真实扫描仅建立历史基线。它与自动点赞运行器独立，安装 MCP 不会启动二者，也不创建系统定时任务。停止守望者只停止新提醒，已有提醒要在 Bridge 中检查；立即禁止其后续回复应同时关闭 `allowReplies` 或整个空间模块。

## 管理入口和状态文件

桥接控制台默认只监听 `127.0.0.1`，管理接口使用控制台令牌，二代会话操作还使用会话身份。保持控制台令牌与会话令牌用途分离；不要把管理令牌复制到角色提示或 QQ 消息。

本机状态目录包含可识别聊天对象的信息和凭据。代码会尝试收紧相关权限，但权限操作可能受操作系统、账号及沙箱影响；启动日志中的失败不能视为已完成保护。

Windows 可使用只读诊断：

```powershell
npm run diagnose:acl
```

不要把该命令和会修改权限的 `npm run harden-acl` 混为一谈。遇到读取失败时，先确认目标目录、当前用户与 DSH 运行用户，避免递归放宽整个工作盘权限。

## 相关离线检查

以下入口用于检查本地代码、样例或模拟环境：

```powershell
node scripts/test-audit-setup-guards.mjs
npm run test:hardening
```

检查应报告真实的失败和跳过。缺少外部独立语音项目时，相应检查跳过不等于那部分功能已通过；离线测试也不能证明当前 DSH profile 的实际工具装配正确。

`npm run self-test` 会调用真实 DSH 和模型，但不发送 QQ。发送脚本、控制台发送按钮和已开放的聊天会话可能产生真实 QQ 消息，应与离线检查区分。

## 仍需人工判断的部分

白名单控制接入对象，不能保证模型在允许对象内的每次发送都符合意图。敏感特征检测不能识别全部秘密、私人关系或上下文推断。搜索下载的地址检查也不能验证外部内容本身可信。

发生异常时，先停止相关发送或桥接进程，保存本机所需证据，再按“网关接收 → 桥接访问范围 → DSH 预设/模型 → 发送检查”的顺序定位。对外分享证据前按 [隐私说明](PRIVACY.md) 去除账号、令牌和消息正文中的私人信息。
