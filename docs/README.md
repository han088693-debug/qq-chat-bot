# 文档索引

第一次安装，从 [安装与使用教程](QUICKSTART.md) 开始。它包含外部软件准备、本机配置、DSH 预设安装、启动顺序和不发送 QQ 的基础检查。

| 你要做什么 | 对应文档 |
| --- | --- |
| 安装、启动和排错 | [QUICKSTART.md](QUICKSTART.md) |
| 了解消息流程、功能和未完成部分 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 按职责定位源码与本机数据 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 理解运行模式、管理员和工具权限 | [RULES.md](../RULES.md) |
| 安装或更新 DSH 插件、预设与 MCP | [DSH_SETUP.md](guides/DSH_SETUP.md) |
| 检查部署配置与能力范围 | [SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 检查提交内容、日志及隐私扫描盲区 | [PRIVACY.md](guides/PRIVACY.md) |
| 创建或维护角色卡 | [roles/README.md](../roles/README.md) |

桥接内的图片、表情、语音和 ASR 使用说明见 [教程的常用功能](QUICKSTART.md#8-常用功能)。独立 `../voice-tool/` 的 `voice-gui.mjs`、`voice-cli.mjs` 属于仓库外项目，没有随本仓库打包；不要把缺少该项目解释为桥接内的所有语音能力都不可用。

文档区分源码已有能力、外部依赖和未接线功能。命令示例是供使用者执行的步骤，不表示其电脑已验证成功。历史个人配置、私密工作文档与聊天日志不作为发布文档提供。
