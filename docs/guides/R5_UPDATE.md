# r5 更新与配置

本次同步本地 `v0.2.0-r5` 的增量功能，保留本仓库原有安装流程、空间巡逻、可选设备模块及安全默认值。没有打包个人配置、聊天数据、私人角色卡或外部图片素材。

## 表情与发送

- 新增表情情绪与角色筛选、品味笔记、收藏额度和按会话统计的发送额度。
- 外部图库从 `aigengtu.com` 获取公开索引与图片，经过地址、文件类型、尺寸和体积检查后缓存。仅用于私聊，不上传本地聊天文本给图库。图片本身不随源码分发，使用者自行确认使用权限。
- 文字、图片和表情共用会话冷却；需要“文字加表情”时，一次调用 `qq_send_message`，用 `messages` 加 `stickerId` 传入。
- 部分成功会返回已发送数量及表情失败信息；不要把已经发出的文字整批重发。
- `socialV2.sticker.external.enabled` 控制外部图库；`taste.enabled` 控制品味功能。`external.maxPerHourPerChat`、`external.maxPerDayPerChat` 与 `collect.maxPerDay` 分别限制外部表情和收藏频率。关闭外部图库不影响已有 QQ 收藏表情。

## 跨私聊记忆

`socialV2.crossMemory.enabled` 默认是 `false`。关闭时不会自动登记跨聊印象、刷新好友昵称缓存或把其他私聊的近况注入当前会话。

管理员明确需要跨聊共享时才将此项设为 `true`。启用后，已登记且在白名单中的其他私聊可能被引用，包括近期文字；这会改变不同私聊之间的信息隔离范围。`recordOnly: true` 仅限制来源为已登记联系人，不等同于每次共享都已获同意。默认不使用管理员私聊作为来源，群聊不参与共享。

关系资料保存在本机 `state/cross-memory.json`；修改开关后可重启桥接使配置生效。不要把该文件或其他 `state/` 数据提交到 Git。

## 升级与验证

先保存本机配置，再更新代码并执行 `npm ci`。将示例中需要的新字段合入自己的配置，不要直接覆盖正在使用的 `config.json`。

本仓库继续保留两分钟发送间隔示例、默认关闭的主动聊天、开发控制通道和可选空间自动操作。已有用户配置不会自动被改写。

离线验证：

```sh
npm run test:audit
npm run test:r5
npm run test:session-features
npm run test:optional
npm run test:patrol
```

这些测试使用夹具和模拟端点，不代表已完成真实 QQ 发消息、模型推理或空间操作的端到端验证。
