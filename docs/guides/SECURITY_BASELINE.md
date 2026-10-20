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

功能关闭和未填白名单不代表软件完全不联网。DSH 连接、模型请求、已启用的搜索或热榜等功能有各自的访问路径；具体数据流见 [隐私说明](PRIVACY.md)。

## 预设与工具

通过 `node scripts/setup-dsh.mjs` 将聊天预设安装到实际使用的 DSH profile，并重启 DSH。确认 `qq-chat`、`qq-chat-v2` 存在，再在桥接控制台显式选择目标模式。

普通 QQ 聊天缺少专用预设时，预期行为是拒绝建会话；不要改成自动退回包含完整本地工具的默认预设。

当前工具约束同时使用注册期隐藏和执行期允许列表。额外 MCP 服务可能带来新能力，尤其是源码中兼容的手机、iPhone、QQ 空间等工具；安装脚本并不提供这些外部服务，也无法替它们完成权限配置。新增服务后应查看真实工具清单及其副作用。

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
