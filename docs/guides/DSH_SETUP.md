# DSH 预设与工具安装

完整首次安装请按 [安装与使用教程](../QUICKSTART.md) 进行。本页保留 DSH 集成的安装入口，便于从源码诊断提示跳转。

## 安装入口

先独立安装 DSH，确认 CLI 可用，并在桥接仓库根目录完成 `npm ci` 和本机 `config.json` 配置。

默认安装到 `web` profile：

```powershell
node scripts/setup-dsh.mjs
```

其他 profile：

```powershell
node scripts/setup-dsh.mjs your-profile
```

将 `your-profile` 替换为实际 profile 名。若自定义 `DSH_HOME`，安装脚本、DSH 进程与桥接进程必须使用同一个值。

## 脚本实际修改什么

| 位置 | 行为 |
| --- | --- |
| 仓库 `plugins/qq-agent-presets/presets/` | 从 `dsh/agent-presets/` 重新生成两个预设的 patch |
| DSH profile 的 `cordis.patch.yml` | 同步 QQ、Host 辅助和安全搜索三个 MCP 条目 |
| DSH profile 的 `package.json` | 注册 `qq-mode-console`、`qq-agent-presets` bundle 与依赖 |
| DSH 插件和 profile 的依赖目录 | 建立指向当前仓库的插件链接 |
| 仓库 `state/mode.json` | 仅在缺失时创建本地模式备用文件 |

当前机制是 **bundle + Cordis 配置**。旧 `.agent-presets/` 副本可能被脚本提示，但不是当前预设安装来源。

脚本会校验现有 YAML，改写已有 `cordis.patch.yml` 时尝试创建时间戳备份并保留最近几份。备份失败会报告但不一定停止后续写入，因此修改既有 DSH 环境前仍应保存自己需要的本机配置。备份可能含有私密设置，不应提交到仓库。

安装脚本会尝试运行 DSH 的依赖安装命令。如果提示自动安装失败，处理 CLI/PATH 或网络问题后执行：

```powershell
dsh plugin --profile web install
```

如果安装到其他 profile，同步替换这里的名称。安装完成后重启 DSH，使预设与 MCP 配置加载。

## 验证与更新

1. 在 DSH 中确认 `qq-chat` 和 `qq-chat-v2` 可用。
2. 启动桥接，在本地控制台确认 DSH 连接状态。
3. 显式切换到需要的模式，并回读状态；本地备用文件不能覆盖已有 DSH 设置。
4. 新增或修改外部 MCP 后，检查实际工具清单及权限；安装了 QQ bundle 不代表所有其他工具都已隔离。

修改预设源文件、移动仓库或重新克隆到另一目录后，再运行安装脚本并重启 DSH。它不启动 QQ 或 SnowLuma，也不安装模型凭据、外部语音工具、手机服务或其他第三方 MCP。

## 可选 MCP 的安装顺序

主安装更新聊天预设及基础服务；外部模块使用另一个安装器。在本机 `optional/config.json` 配好依赖与开关后执行：

```powershell
node scripts/setup-dsh.mjs web
node optional/setup.mjs web --check
node optional/setup.mjs web
```

使用其他 profile 时同步替换三处名称，再重启 DSH。可选安装器只维护自己的 `mcp-qq-optional-*` 项，不安装 SideTap、ADB、Python 服务或平台账号；冲突、移除与分项教程见 [可选功能总教程](../OPTIONAL_FEATURES.md)。

本机鉴权通常保持 `dsh.authToken` 为空，由 `src/dsh-client.js` 使用本机 DSH 凭据建立会话。401、预设缺失和模式回滚的排查步骤见 [教程的常见问题](../QUICKSTART.md#9-常见问题)。
