# 来源与第三方组件

本项目以 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的 `v0.2.0-r4` 为基础，整理其本地改造后的工作树。基线提交为 `a56164e`；这不是上游原样镜像，也没有携带本机原仓库的历史提交。

完整保留根目录 `LICENSE` 中的原版权及许可文本：

`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`

## AI Companion Kit 的关系

[pinganbbOvO/ai-companion-kit](https://github.com/pinganbbOvO/ai-companion-kit) 是本次部署整合的参考来源。用于整理的本地 Kit 基线为 `24a9a0c6896b5bfe85d046c2ed245fd61cf9e090`；它的安装工具另外获取 `Derpyu520/qq-bridge`，并带有桥接补丁。Kit 顶层自身不是本仓库桥接源码的 Git 历史；其独立 `packages/companion` 也未并入本仓库。

`optional/phone/` 参考并改写了 Kit 的 [phone-mcp](https://github.com/pinganbbOvO/ai-companion-kit/tree/24a9a0c6896b5bfe85d046c2ed245fd61cf9e090/packages/phone-mcp)：保留需要的 Android / QQ 空间接入，增加显式配置、默认关闭、操作权限和本地图片目录限制。它不等同于原包的全部能力。原项目使用 MIT，版权为：

`Copyright (c) 2026 AI Companion Kit contributors`

许可全文保留在 [optional/phone/LICENSE.ai-companion-kit](optional/phone/LICENSE.ai-companion-kit)。Kit 公开主分支可能继续变化，部署参考链接不代表已自动同步其后续提交。

## 交付范围

| 组件 | 本仓库包含什么 |
| --- | --- |
| QQ bridge | 桥接源码、网页控制台、安装/测试脚本、通用预设 |
| AI Companion Kit phone-mcp | 经改写的可选 Android / QQ 空间服务与原许可；不含完整 Kit、安装环境、设备数据或个人补丁 |
| iPhone 适配 | 工具列表/调用过滤代理和安装说明；不包含 SideTap 本体、驱动、配对或设备资料 |
| B 站适配 | 四项只读工具代理和安装说明；不包含外部 Python 服务、登录凭据、二维码或运营脚本 |
| DeepSeek Harness | 对接代码和 npm 依赖声明；不包含其服务安装目录、凭据或会话 |
| SnowLuma | OneBot 对接代码和 npm 依赖声明；不包含软件本体、原生组件或登录资料 |
| `@snowluma/sdk` / `@snowluma/mcp` | 由使用者按锁文件从 npm 安装；`postinstall` 修补本地依赖副本的相对导入扩展名 |
| `opencc-js` | npm 依赖声明，用于语音转写后的繁简转换；具体版本见锁文件 |
| 音频工具与模型 | 不包含 FFmpeg、whisper.cpp、模型权重或用户音频 |
| 图片、表情、私人角色卡 | 不随仓库发布；使用者自行提供且自行确认授权范围 |

## iPhone 外部服务

iPhone 教程使用 [ucsandman/SideTap](https://github.com/ucsandman/SideTap) 的 `phone_harness` MCP 接口。其 [MIT 许可](https://github.com/ucsandman/SideTap/blob/main/LICENSE) 版权署名为 Wes Sander。本仓库仅包含标准 MCP 代理、明确工具列表和可选截图保存逻辑，不复制 SideTap 源码、安装环境、Apple 驱动或签名材料。使用时遵循外部项目自身的安装与许可说明。

## B 站外部服务

[B 站教程](docs/guides/OPTIONAL_BILIBILI.md) 使用 [adoresever/bilibili-mcp](https://github.com/adoresever/bilibili-mcp) 的公开接口，核对的源码基线为 `1521d19d4118bfe23e08ec4c7702991c5f9de0ba`。其 [MIT 许可](https://github.com/adoresever/bilibili-mcp/blob/1521d19d4118bfe23e08ec4c7702991c5f9de0ba/LICENSE) 署名 `Copyright (c) 2026 AGI_Ananas`。本仓库没有复制该 Python 服务；外部服务自身具有比这里开放范围更多的工具，QQ 适配只转交 `bili_search`、`bili_video_info`、`bili_comments`、`bili_subtitle`。

该外部服务的 Python 依赖包括 [bilibili-api-python](https://github.com/Nemo2011/bilibili-api)、[MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) 和 aiohttp，适用各自许可。本机安装过某个版本不等于本仓库保证其后续版本兼容。

## 其他许可边界

发布时本机安装的两个 `@snowluma/*` 包声明为 `SEE LICENSE IN LICENSE`，在所检查的安装目录中没有找到附带许可文件。这里记录这一事实，不据此推定第三方授权范围。使用或再分发前应查看 [SnowLuma 上游](https://github.com/SnowLuma/SnowLuma)、相应 npm 包及其最新许可说明。

根 LICENSE 后半部分包含上游作者的第三方说明与讨论；保留文本不代表本项目获得了额外的第三方许可。此仓库只提供声明的代码与模板，不提供任何模型服务额度或平台账号。
