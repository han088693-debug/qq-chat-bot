# 可选 Android 模块

模块通过你已安装的 ADB 连接一台明确指定的 Android 设备。默认关闭；启用后默认只能检查连接、截图和读取界面结构。它不负责安装模拟器、配对设备、切换设备或部署手机应用。

代码与 QQ 空间模块共用 `optional/phone/server.mjs`，MCP 名称是 `phone`。QQ 空间不依赖 Android；只需要空间功能时不必启用本模块。

## 1. 手动准备设备

1. 从 Android 官方渠道安装 SDK Platform-Tools，找到 `adb` 或 `adb.exe`。
2. 在设备上启用开发者选项和 USB 调试，连接 USB，并由你本人确认调试授权。
3. 在自己的终端运行 `adb devices`，抄下准备接入的设备序列号。无线连接也应先由你手动完成配对和连接。

序列号属于本地配置，不要贴进公开文档或提交 Git。这里不附带任何预设设备标识，也不会自动选列表中的第一台设备。

## 2. 配置只读接入

先完成 [快速开始](../QUICKSTART.md) 的主安装。在仓库根目录同步当前预设，再准备本机可选配置。下面使用默认 profile `web`；使用其他 profile 时，主安装与可选安装的名字必须保持一致。

```powershell
node scripts/setup-dsh.mjs web
if (!(Test-Path optional/config.json)) {
  Copy-Item optional/config.example.json optional/config.json
}
```

把以下字段合并到 `optional/config.json` 的 `phone.android` 对象中，保留其他模块设置；这是局部示例，不能用它覆盖整份配置：

```json
{
  "enabled": true,
  "adbPath": "C:/Tools/platform-tools/adb.exe",
  "serial": "<你准备接入的设备序列号>",
  "allowControl": false
}
```

如果 `adb` 已在 PATH，可以用 `"adbPath": "adb"`。`serial` 必须填写；缺失时不会启动 ADB 进程或猜选设备。

```powershell
node optional/setup.mjs web --check
node optional/setup.mjs web
```

随后重启 DSH。非默认 profile 的安装参数见 [可选模块总览](../OPTIONAL_FEATURES.md)。安装过程只写 MCP 配置，不接触设备。

## 3. 确认只读工具

| 工具 | 结果 |
|---|---|
| `mcp__phone__phone_status` | 配置中那台设备是否处于可用状态，不枚举其他设备 |
| `mcp__phone__phone_screenshot` | 返回当前屏幕 PNG；本模块不在仓库保存截图 |
| `mcp__phone__phone_dump` | 返回界面文字、描述、可点击标记与中心坐标，最多 200 项 |

先将手机放到一个可以展示的普通界面，再要求机器人检查连接、看一张截图。截图和界面文字会进入模型上下文；不要在需要保密的页面上调用。

`phone_dump` 通过 `uiautomator dump /dev/tty` 读取 UI 树，不创建本仓库状态文件。游戏或其他自绘界面可能没有可读节点；部分设备也可能不支持这个输出方式，此时使用截图，不将空 UI 树误判为应用未打开。

## 4. 按需启用操作

把 `allowControl` 改成 `true`，重新运行安装器并重启 DSH，才会加入：

| 工具 | 输入 |
|---|---|
| `phone_tap` | `x`、`y` |
| `phone_tap_text` | 完整文字或描述 `text`；存在多个匹配时拒绝猜测 |
| `phone_swipe` | `x1`、`y1`、`x2`、`y2`，可选 `ms` |
| `phone_text` | 在已确认输入框里输入 `text` |
| `phone_key` | `back/home/enter/recent/delete/volume_up/volume_down` |
| `phone_open_app` | 已安装应用的完整 `packageName` |

操作前先读当前界面，不根据旧截图猜坐标。ADB 命令完成只表示已发送操作；点击或输入后的实际结果应通过新截图或 UI 树确认。

本模块不提供 `phone_shell`、配对、设备枚举/切换、宏、安装应用、任意命令或账号密码自动填写工具。

## 5. 中文输入

普通可打印 ASCII 文本通过 Android 的 `input text` 输入。中文或其他非 ASCII 文本需要设备上已有兼容的 **ADBKeyboard**，并由你手动把它切为当前输入法。

模块先检查当前输入法是否属于 `com.android.adbkeyboard`，再通过 `ADB_INPUT_B64` 广播传入编码后的文字。它不会下载输入法、安装 APK 或自动更改默认输入法。条件不满足会明确报错，继续用设备键盘输入即可。

若使用兼容性不同的输入法，不应只改包名绕过检查；应先验证其广播协议。本仓库只实现上述方式。

## 6. 排障与关闭

| 情况 | 检查 |
|---|---|
| 看不到工具 | `enabled`、是否运行安装器、是否重启 DSH |
| 有截图工具但不能点按 | `allowControl` 默认关闭 |
| ADB 操作失败 | 本机终端能否运行同一个 ADB、设备是否连接并授权、`serial` 是否正确 |
| 界面文字没有唯一匹配 | 重新查看截图，使用明确坐标 |
| 中文不能输入 | 当前是否手动启用兼容 ADBKeyboard |
| `phone_dump` 不支持或无节点 | 设备命令支持情况、自绘界面；改用截图观察 |
| 截图黑屏 | 当前界面可能限制截图，不能据此声称已看清内容 |

关闭操作能力：改 `allowControl=false`。只停用 Android：改 `phone.android.enabled=false`，重新运行 `node optional/setup.mjs web` 并重启 DSH，保留 QQ 空间和其他模块的现有开关。设备自身的调试开关仍由你管理。

`node optional/setup.mjs web --remove` 会移除本安装器管理的**全部**可选 MCP 挂载，包括 iPhone、Android/QQ 空间和 B 站，不能用作只停用 Android 的命令。全部移除后也需重启 DSH；它不会卸载 ADB 或删除手机数据。

离线验证：`node scripts/test-optional-phone.mjs`。测试注入模拟 ADB 与 HTTP，并用临时配置核对 MCP 工具列表；不启动真实 ADB，不连接手机，也不发送 QQ 消息。
