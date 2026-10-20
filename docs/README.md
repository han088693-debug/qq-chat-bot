# 文档索引

第一次安装，从 [安装与使用教程](QUICKSTART.md) 开始。它包含外部软件准备、本机配置、DSH 预设安装、启动顺序和不发送 QQ 的基础检查。

| 你要做什么 | 对应文档 |
| --- | --- |
| 安装、启动和排错 | [QUICKSTART.md](QUICKSTART.md) |
| 按需配置全部已有扩展能力 | [OPTIONAL_FEATURES.md](OPTIONAL_FEATURES.md) |
| 图片、表情、形象、语音发送和语音转写 | [OPTIONAL_MEDIA.md](guides/OPTIONAL_MEDIA.md) |
| 记忆、知识库、日记和提醒 | [OPTIONAL_MEMORY.md](guides/OPTIONAL_MEMORY.md) |
| 黑话、风格、搜索、热榜、主动话题和开发助手 | [OPTIONAL_AUTOMATION.md](guides/OPTIONAL_AUTOMATION.md) |
| iPhone 读取与按需控制 | [OPTIONAL_IPHONE.md](guides/OPTIONAL_IPHONE.md) |
| Android 读取与按需控制 | [OPTIONAL_ANDROID.md](guides/OPTIONAL_ANDROID.md) |
| QQ 空间读取与按需写入 | [OPTIONAL_QZONE.md](guides/OPTIONAL_QZONE.md) |
| QQ 空间巡逻配置、演练与运行管理 | [OPTIONAL_QZONE_PATROL.md](guides/OPTIONAL_QZONE_PATROL.md) |
| B 站四项只读工具 | [OPTIONAL_BILIBILI.md](guides/OPTIONAL_BILIBILI.md) |
| 了解消息流程、功能和未完成部分 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 按职责定位源码与本机数据 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 理解运行模式、管理员和工具权限 | [RULES.md](../RULES.md) |
| 安装或更新 DSH 插件、预设与 MCP | [DSH_SETUP.md](guides/DSH_SETUP.md) |
| 检查部署配置与能力范围 | [SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 检查提交内容、日志及隐私扫描盲区 | [PRIVACY.md](guides/PRIVACY.md) |
| 创建或维护角色卡 | [roles/README.md](../roles/README.md) |
| 查阅来源与第三方许可 | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |

独立 `../voice-tool/` 的 `voice-gui.mjs`、`voice-cli.mjs` 属于仓库外项目，没有随本仓库打包；桥接内的语音处理和控制台入口见媒体教程。`optional/` 则是本仓库提供的外部能力适配，使用自己的配置文件，安装方法见可选功能总教程。

文档区分源码已有能力、外部依赖和未接线功能。命令示例是供使用者执行的步骤，不表示其电脑已验证成功。历史个人配置、私密工作文档与聊天日志不作为发布文档提供。
