# 来源与第三方组件

本项目以 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的 `v0.2.0-r4` 为基础，整理其本地改造后的工作树。基线提交为 `a56164e`；这不是上游原样镜像，也没有携带本机原仓库的历史提交。

完整保留根目录 `LICENSE` 中的原版权及许可文本：

`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`

| 组件 | 本仓库包含什么 |
| --- | --- |
| QQ bridge | 桥接源码、网页控制台、安装/测试脚本、通用预设 |
| DeepSeek Harness | 对接代码和 npm 依赖声明；不包含其服务安装目录、凭据或会话 |
| SnowLuma | OneBot 对接代码和 npm 依赖声明；不包含软件本体、原生组件或登录资料 |
| `@snowluma/sdk` / `@snowluma/mcp` | 由使用者按锁文件从 npm 安装；`postinstall` 修补本地依赖副本的相对导入扩展名 |
| `opencc-js` | npm 依赖声明，用于语音转写后的繁简转换；具体版本见锁文件 |
| 音频工具与模型 | 不包含 FFmpeg、whisper.cpp、模型权重或用户音频 |
| 图片、表情、私人角色卡 | 不随仓库发布；使用者自行提供且自行确认授权范围 |

发布时本机安装的两个 `@snowluma/*` 包声明为 `SEE LICENSE IN LICENSE`，在所检查的安装目录中没有找到附带许可文件。这里记录这一事实，不据此推定第三方授权范围。使用或再分发前应查看 [SnowLuma 上游](https://github.com/SnowLuma/SnowLuma)、相应 npm 包及其最新许可说明。

根 LICENSE 后半部分包含上游作者的第三方说明与讨论；保留文本不代表本项目获得了额外的第三方许可。此仓库只提供声明的代码与模板，不提供任何模型服务额度或平台账号。
