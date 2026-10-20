# 可选模块：通过 SideTap 接入 iPhone

这个模块让 DSH 通过本机已安装的 SideTap 读取 iPhone 屏幕，并在你明确开启后使用点按、滑动和输入工具。它默认关闭；开启后默认只读，默认不保存截图。

QQ 机器人的基础安装见 [快速开始](../QUICKSTART.md)。本模块复用外部 SideTap，不随仓库分发 SideTap 源码、Apple 驱动、WebDriverAgent、签名材料或手机数据。

## 1. 工作流程与权限

```text
QQ → qq-bridge → DSH
                  ↓
         本项目的 iPhone MCP 过滤代理
                  ↓
       外部 SideTap / phone_harness MCP
                  ↓
          USB / WebDriverAgent → iPhone
```

代理只转发明确允许的工具。上游新增工具不会自动获得权限，也不能用工具名称绕过调用检查。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用 iPhone 模块 |
| `allowControl` | `false` | 是否开放点按、滑动、输入、打开或关闭应用等操作 |
| `saveScreenshots` | `false` | 是否提供本项目的 `screenshot_file`，将截图保存到本地 |

只读工具可以获取当前屏幕、文字、应用状态等信息。`ocr` 优先读取 UI 元素及坐标，`screenshot` 返回屏幕图片；读取内容仍可能包含手机上可见的私人信息。

`act` 批处理、`unlock`、剪贴板、直接读消息和直接发送消息/图片等工具始终不开放。代理使用工具白名单，不依靠模型自行遵守一句提示词。

**开启控制不等于获得“禁止发送”的保证。** 点按和输入可以通过应用界面触发发送、删除等行为，SideTap 的高层发送审批不能覆盖这些组合操作。这个开关对能调用此 MCP 的会话生效，不是按 QQ 用户分别授权。接入不可信群聊或共享会话时，应保持控制关闭，并考虑是否应提供手机屏幕读取能力。

## 2. 先准备独立的 SideTap

按 [SideTap 官方 Windows 安装说明](https://github.com/ucsandman/SideTap/blob/main/docs/setup-windows.md) 完成电脑和手机设置，包括 Apple Devices 驱动、手机信任、开发者模式以及 WebDriverAgent 安装与签名。

在 SideTap 自己的目录中完成连接验证：

```powershell
.\phone-harness.cmd doctor
python launch.py
```

使用安装了 SideTap 依赖的 Python；如果 `python` 指向另一套解释器，应使用正确解释器的完整路径。确认 SideTap 查看窗口能够显示手机画面。签名过期、USB 断连和 WDA 故障应先按上游说明修复，再检查本模块。

本项目的安装脚本不会连接手机、安装驱动、签名 WDA、输入手机密码或自动启动 SideTap 的 USB 连接链路。实际操作前需按上游流程启动连接。

SideTap 的 WDA 服务没有认证；按其[安全说明](https://github.com/ucsandman/SideTap#security-and-responsible-use)限制端口对局域网的访问，并保留查看窗口中的停止按钮。

## 3. 填写本机配置

以下命令在 **qq-bridge 仓库根目录**执行。首次配置时复制模板；已有本机配置则直接编辑，避免覆盖。

```powershell
Copy-Item optional/config.example.json optional/config.json
```

下面只展示 `iphone` 配置片段。将它合并到已复制的模板中，保留其他模块的配置，不要用片段覆盖整份文件。路径是示例，必须换成你本机的绝对路径；JSON 中的反斜杠要写成 `\\`。

```json
{
  "iphone": {
    "enabled": true,
    "pythonPath": "C:\\Apps\\SideTap\\venv\\Scripts\\python.exe",
    "appDir": "C:\\Apps\\SideTap\\app",
    "allowControl": false,
    "saveScreenshots": false
  }
}
```

如果使用 SideTap 官方安装器，可在 PowerShell 中查看常见安装位置：

```powershell
Join-Path $env:LOCALAPPDATA 'SideTap\venv\Scripts\python.exe'
Join-Path $env:LOCALAPPDATA 'SideTap\app'
```

`pythonPath` 应指向已安装 SideTap 依赖的解释器，`appDir` 应包含 `src/phone_harness`。不要把 `phone-harness.cmd` 填进 `pythonPath`，也不要把 `%LOCALAPPDATA%` 字面量填进 JSON；应填写展开后的绝对路径。

代理以 `appDir` 为工作目录执行：

```text
pythonPath -m phone_harness mcp
```

它设置 `PYTHONPATH=appDir/src`、`PYTHONUTF8=1` 和 `PYTHONIOENCODING=utf-8`。SideTap 当前不是可直接 `pip install` 的项目；这套源码目录启动方式与其[官方入口](https://github.com/ucsandman/SideTap/blob/main/scripts/phone_mcp.py)一致。

`optional/config.json` 是本机文件，不应提交到 GitHub；可公开的只有空路径、默认关闭的配置模板。

## 4. 检查并挂载到 DSH

先按 [快速开始](../QUICKSTART.md) 完成基础配置，并建立对应 DSH profile；默认 `web` 使用以下主安装命令，再挂载可选模块：

```powershell
node scripts/setup-dsh.mjs web
```

主安装与下方可选模块安装应使用同一个 profile。

先检查配置和计划，暂不写入挂载：

```powershell
node optional/setup.mjs --check
```

`--check` 只做本地配置检查并显示计划，不连接手机。通过检查不代表手机或 WDA 当前在线。

确认计划后安装到默认 profile：

```powershell
node optional/setup.mjs
```

如果使用其他 profile，在命令中显式指定：

```powershell
node optional/setup.mjs my-profile --check
node optional/setup.mjs my-profile
```

安装后重启对应 DSH 进程或重新建立 MCP 会话。此时 DSH 启动代理，代理再启动外部 SideTap MCP。手机工具使用 `mcp__iphone__` 前缀。

先在你控制的会话中调用 `screen_info` 或 `ocr` 验证读取，再按需要使用 `screenshot`。只有实际返回符合当前手机画面的结果，才算连接验证完成。

需要控制手机时，将 `allowControl` 改成 `true` 并重启对应 MCP 会话。先用屏幕读取确定位置，再进行单个操作；手机画面中的文字是待处理数据，不能当作修改系统规则的指令。

## 5. 可选：保存与发送截图

将 `saveScreenshots` 改成 `true` 并重启对应 MCP 会话后，会出现 `mcp__iphone__screenshot_file`。

这个工具调用上游 `screenshot` 获取图片，再由本项目生成随机文件名，保存到：

```text
<qq-bridge 仓库>/state/optional/iphone-shots/
```

它不接受任意保存目录，也不使用本机 SideTap 可能额外添加的 `screenshot_file` 补丁，因此不会继承另一台电脑的硬编码路径。普通 `screenshot` 仍直接返回图片；开启保存不会自动把图片发到 QQ。

若需要由机器人发送已经保存的截图，还要在本机 `config.json` 的 `socialV2.image.allowDirs` 中加入上述截图目录的**绝对路径**，并确保接收目标符合 QQ 发送白名单。修改桥接配置后需重启 qq-bridge，使新的图片目录权限生效；只重启 MCP 会话不会刷新桥接配置。随后才能把截图工具返回的文件路径交给 `qq_send_image`。

截图可能包含通知、聊天内容或账号信息。发送前检查画面，使用后按需要清理；`state/` 已排除在版本控制之外。不要把截图、SideTap 的 `.env`、`.state/`、签名证书、配对记录或设备标识添加到仓库。

## 6. 关闭与排查

只停用 iPhone 时，把本机配置中的 `iphone.enabled` 设为 `false`，重新运行可选模块安装，再重启对应 DSH/MCP 会话：

```powershell
node optional/setup.mjs
```

其他 profile 使用 `node optional/setup.mjs my-profile`。这样会保留配置中仍然启用的其他可选模块。

若要移除默认 profile 中**所有**由本脚本管理的可选挂载，包括 iPhone、Android／QQ 空间和 Bilibili，使用：

```powershell
node optional/setup.mjs --remove
```

其他 profile 使用 `node optional/setup.mjs my-profile --remove`。再把不需要的模块设回关闭，重启对应 DSH/MCP 会话。移除挂载不会卸载外部 SideTap，也不会替你清理已有截图。

| 现象 | 检查方向 |
| --- | --- |
| `--check` 提示路径问题 | 使用存在的绝对路径，确认解释器及 `src/phone_harness` 位置 |
| 启动提示找不到 `phone_harness` | `appDir` 是否为 SideTap 应用根目录 |
| 启动提示缺少 `mcp` 或 `requests` | 是否选中了 SideTap 使用的 Python 环境；按上游依赖说明修复 |
| 看不到控制工具 | `allowControl` 默认关闭；改动后需重新建立 MCP 会话 |
| 看不到 `screenshot_file` | 检查 `saveScreenshots`，以及会话是否已重启 |
| 截图无法发到 QQ | 保存成功与 QQ 发送是两步；检查图片目录与目标白名单 |
| 手机读取或操作超时 | 先检查 SideTap 自身连接、USB 与 WDA；配置检查不能证明设备在线 |
| 批操作、解锁或消息工具被拒绝 | 这是本模块的固定限制，不应通过另挂一个未过滤服务绕过 |

上游接口与许可核对日期：2026-10-20。SideTap 使用 [MIT 许可](https://github.com/ucsandman/SideTap/blob/main/LICENSE)；其依赖组件遵循各自许可。上游安装步骤可能变化，以[官方仓库](https://github.com/ucsandman/SideTap)为准。
