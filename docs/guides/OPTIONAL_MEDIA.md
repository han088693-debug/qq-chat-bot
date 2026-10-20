# 图片、表情、语音和音乐

这些能力属于桥接自带的 QQ MCP。先完成 [基础安装](../QUICKSTART.md) 并选择 `reserved2`；以下字段合并到本机 `config.json`。直接改文件后重启桥接，改工具开关后也重启 DSH。

## 1. 发送图片与读取聊天图片

1. 在本机创建一个只放可发送图片的目录，例如 `C:/bot-media/images`。
2. 将自己有权使用的 PNG / JPEG 等图片放进去；不要把整个用户目录加入允许范围。
3. 合并配置：

```json
{
  "socialV2": {
    "image": {
      "enabled": true,
      "allowDirs": ["C:/bot-media/images"],
      "maxBytes": 8388608,
      "maxFiles": 100
    },
    "tools": {
      "listImages": true,
      "sendImage": true,
      "getImages": true
    }
  }
}
```

`qq_list_images` 列出允许目录里的素材；`qq_send_image` 可按文件名发图，或用已收到消息的 `messageId` 重发图片。绝对文件路径也必须在允许目录内，代码会比较真实路径。若没显式设置 `allowDirs`，仅当设置了 `sessionCwd` 时才默认使用其中的 `images/`；模板的空 `sessionCwd` 不会自动开放任意目录。

先查看图片列表，确认只出现预期素材，再自行测试发送。一次发图会占用回复间隔，工具报告冷却时不应立即追加另一条发送。接收图片和转发消息的读取依赖 SnowLuma 返回的资源，图像理解还依赖模型支持视觉。

入站图片限制是另一组字段 `socialV2.media.maxBytes`、`maxPixels`、`maxCount`，模板分别为 8 MiB、6400 万像素和 5 张。它们不代替本地发送目录限制。

## 2. 自定义形象

当前 `qq_get_self_image` 读取固定文件 `assets/deepseek娘.png`。准备一张自己有权使用的 PNG，按这个文件名放置，并保持 `socialV2.tools.getSelfImage=true`。

该工具把图片交给模型理解自己的形象，不会修改 QQ 账号头像，也不会自动把图片发到聊天中。目前没有自定义文件名配置或上传页面；角色文字仍在 `roles/` 中配置。私人形象文件不要加入提交。

## 3. 表情、备注与图片记忆

模板开启表情基础能力，入口包括：

| 工具 | 用途 / 对应开关 |
| --- | --- |
| `qq_list_stickers`、`qq_get_sticker_image` | 查看收藏表情；`tools.listStickers`、`getStickerImage` |
| `qq_send_sticker` | 向当前允许会话发送表情；`tools.sendSticker` |
| `qq_collect_sticker` | 收藏聊天里的表情；`tools.collectSticker` 和 `sticker.collect.enabled` |
| `qq_sticker_note` | 在本机记录理解；`tools.stickerNote` |
| `qq_sticker_remember` | 保存对某张图片/表情的语义记忆；`tools.stickerRemember` |
| `qq_set_sticker_remark` | 修改 QQ 收藏表情的官方备注；`tools.setStickerRemark`，模板关闭 |

`socialV2.sticker.enabled` 控制这组表情能力。收藏限额由 `sticker.collect.maxPerMinute` / `maxPerHour` 控制。图片记忆由 `sticker.memory.enabled` 控制，`applyToImages` 决定是否也用于普通图片，`maxEntries` 与 `maxNoteChars` 限制条数和备注长度。

使用时先列出表情、读取某张图，再记录一句准确含义。`qq_sticker_note` 写的是本机备注；修改 QQ 官方备注是另一个会影响账号的操作。表情记忆可能减少下次重复传图，但错误记忆也可能影响后续理解，需要在本机检查和纠正。

## 4. AI 发送已有音频

**AI 发语音默认关闭。** 这项能力处理已有音频，不包含完整的文字转语音合成器。

1. 按 [FFmpeg 官方说明](https://ffmpeg.org/download.html) 安装 FFmpeg 与 ffprobe，确保它们可被运行桥接的进程找到。
2. 将短音频放入仓库 `audio/`，例如 `greeting.wav`。
3. 合并配置，两个开关都打开：

```json
{
  "socialV2": {
    "voice": {
      "enabled": true,
      "dir": "audio",
      "allowAbsolutePath": false,
      "maxSeconds": 300,
      "maxBytes": 20971520,
      "ffmpegPath": ""
    },
    "tools": {
      "sendVoice": true
    }
  }
}
```

相对 `voice.dir` 以仓库为基准。保持 `allowAbsolutePath=false`，让 AI 从语音库选文件。FFmpeg 可由 `voice.ffmpegPath` 或环境变量 `FFMPEG_PATH` 指定；ffprobe 可用 `FFPROBE_PATH` 指定，它不是 `ffmpeg.exe`。

打开控制台“二代仿真 → 语音库与语音发送（调试）”，点击“刷新语音库”，确认文件探测结果。先**勾选“只校验不发送”**，再选择音频与允许的目标进行校验；这个复选框不是默认勾选。校验成功只说明当次文件/目标等检查通过，不是已经发送。

AI 使用 `qq_list_voices` 和 `qq_send_voice`；实际发送还受目标、会话、频率、时长和文件检查。控制台手动调试入口独立于 AI 开关，不能把关闭 AI 开关理解为手动发送也被禁用。

`maxPerMinute`、`maxPerHour` 控制语音次数，`defaultVolume` / `loudness` 控制处理参数。网关格式转换、编码器或音频探测失败时，按具体返回处理，不要以换扩展名代替转码。

仓库外独立 `../voice-tool/` 的 `voice-gui.mjs`、`voice-cli.mjs` 未打包；不需要它们也能使用上述桥接内入口。

## 5. 收到 QQ 语音后转写

ASR 与语音发送是两个独立能力。按 [whisper.cpp 官方文档](https://github.com/ggml-org/whisper.cpp) 准备 `whisper-cli` 及兼容的 ggml 模型；中文使用支持中文的模型，不能选择仅英语的 `.en` 模型。FFmpeg、可执行文件和模型权重均需自行安装。

当前代码的默认文件布局：

```text
tools/ffmpeg/bin/ffmpeg.exe
tools/whisper/bin/whisper-cli.exe
tools/whisper/models/ggml-small-q5_1.bin
```

也可在启动桥接的 PowerShell 中指定自己的路径：

```powershell
$env:FFMPEG_PATH = 'C:/tools/ffmpeg/bin/ffmpeg.exe'
$env:FFPROBE_PATH = 'C:/tools/ffmpeg/bin/ffprobe.exe'
$env:WHISPER_CLI = 'C:/tools/whisper/whisper-cli.exe'
$env:WHISPER_MODEL = 'C:/tools/whisper/ggml-small-q5_1.bin'
```

合并 `socialV2.asr` 后，从同一终端重启桥接：

```json
{
  "socialV2": {
    "asr": {
      "enabled": true,
      "maxSeconds": 120,
      "timeoutMs": 90000
    }
  }
}
```

处理流程是 SnowLuma 获取/转换语音 → FFmpeg 转 16 kHz 单声道 WAV → whisper.cpp 转写 → 繁简转换 → 加入聊天上下文。失败时保留失败或语音占位描述，不代表听懂内容。

先确认三个本机文件真实存在；需要实际验证时再向已允许会话提供一段无敏感内容的短语音，并检查转写结果。此时如果聊天已启用，正常聊天流程仍可能回复。转写计算在本机，转写文字随后可能发给 DSH 配置的模型服务。

## 6. 本机音乐信息

`qq_music_now` 使用 Windows 媒体会话读取本机 QQ 音乐等可识别播放器的歌曲标题、歌手、专辑、播放状态和进度。需要播放器确实向系统提供媒体会话；非 Windows 环境返回不支持或失败。

它不提供歌词，也不是音乐播放控制器。当前没有单独 `enabled` 配置，工具结果可能进入模型上下文；若要求完全禁止读取，需要调整工具注册，而不能靠停止主动话题代替。

返回 [可选功能索引](../OPTIONAL_FEATURES.md)。
