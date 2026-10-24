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

## 启动环境保护

管理器发现 `HOME` 或 `CFFIXED_USER_HOME` 与 macOS 账户目录不一致，或设置了 `DREAMSKIN_PREVIEW=1` 时，仅启动只读后端，不初始化主题库，也不开放换肤、恢复、登录项等原生写操作。不要通过改写 `HOME` 为正式客户端选择另一套数据。

正式启动、重启和恢复前会核验现有 Codex 进程的数据环境；无法读取、多个实例配置不一致或自定义 profile 参数无法保留时，拒绝操作，不自动猜测目录。已有的绝对路径 `CODEX_HOME` 会保留，外观配置也从该目录读取；不会创建或搬迁项目及聊天数据库。

Codex 子进程使用核验过的 `HOME`、`CODEX_HOME` 和系统临时目录，不继承 `CFFIXED_USER_HOME`。这些保护不会修复或合并以前误建的 profile；相关目录应先保留。

使用说明见 [GUI使用说明.md](GUI使用说明.md)，签名更新通道见 [UPDATER.md](UPDATER.md)。
