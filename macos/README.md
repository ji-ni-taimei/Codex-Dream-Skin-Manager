# macOS 平台

唯一用户入口是 `Codex Dream Skin.app`，使用 AppKit/WKWebView 承载与 Windows 相同的 React UI，并运行包内 Node/core。菜单栏提供窗口与页面导航，不再维护第二套主题界面或 SwiftBar 插件。

需要 macOS 13+。源码构建需要 Node.js 22.22.2、Swift/macOS SDK，在仓库根目录执行：

```bash
npm ci
bash macos/scripts/build-app.sh
# 制作 DMG：
bash macos/scripts/build-dmg.sh
```

默认应用输出为 `build/macos/Codex Dream Skin.app`，DMG 在 `macos/release`。构建脚本准备包内 Node、共享 UI/core、平台脚本与主题，不自动运行测试。首次打开管理器会初始化内置主题。

平台脚本保留 Codex 发现、启动、CDP 连接、主题发布、原生图片转换和外观恢复。主题库、编辑、导入导出及社区流程统一使用共享 core。
用户主题位于 `~/Library/Application Support/CodexDreamSkinStudio`；部署的引擎位于 `~/.codex/codex-dream-skin-studio`。源码清理不操作这些用户目录。

使用说明见 [GUI使用说明.md](GUI使用说明.md)，签名更新通道见 [UPDATER.md](UPDATER.md)。本轮没有执行 macOS 构建或实机验证。
