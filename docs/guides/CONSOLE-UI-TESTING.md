# 控制台离线预览与回归测试

演示服务只读取控制台 HTML，用内存夹具模拟 API；不会加载真实配置、聊天状态、QQ 或 DSH 服务。发送、重启、压缩和归档相关演示操作均不作用于生产环境。

## 预览

```sh
npm run preview:console
```

浏览器打开 `http://127.0.0.1:4173`。服务只监听本机回环地址，停止后丢弃内存数据。可使用 `--port=4174` 更换端口，或 `--original` 对照旧界面。后者读取仓库内的合成基线文件。

## 浏览器回归

测试需要 Playwright 模块，以及可用的 Chromium、Chrome 或 Edge：

```sh
npm install --no-save --package-lock=false playwright
npm run test:console-ui
```

如果模块安装在独立工具目录，将 `PLAYWRIGHT_MODULE` 设置为该模块的绝对目录。Windows 会查找已安装的 Chrome / Edge；其他环境可安装 Playwright Chromium，或用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定浏览器。

测试自行启动随机端口的演示服务，浏览器只允许访问该服务的地址，外部请求会被拦截并使验证失败。覆盖导航、草稿保留、权限设置、提示词、角色编辑、用量、移动布局、主题、健康面板、会话策略与压缩按钮。所有账号、消息和日志都是演示数据。

保存截图和结果可使用：

```sh
node scripts/test-console-ui.mjs --artifacts=tmp/ui-verification
```

`scripts/console-ui-contracts.json` 保留旧界面的写请求契约。新增功能单独断言，不用重新录制基线来掩盖失败。新增 API 必须同时补充 `console-ui-fixture.mjs`；未知接口、脚本异常和外部请求都会使测试失败。

不要用 `scripts/test-console.mjs` 替代这套测试：那个入口可能连接真实服务。离线回归通过不代表 QQ、DSH 或模型服务的实际往返已经验证。
