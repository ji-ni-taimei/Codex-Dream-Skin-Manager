# P0：跨平台迁移基线与差异决策

日期：2026-09-29。范围：现有源码盘点、数据边界、首批契约设计；不执行换肤、不读取本机用户主题、不修改现有业务。

关联：[总迁移方案](cross-platform-migration-plan.md)、[首批桥接契约](manager-bridge-v1.md)。功能总清单继续以总方案第 4 节为准，本文记录会影响实现的差异和决定。

## 1. 页面及业务归属冻结

| Windows 基准 | 当前实现 | 迁移归属与阶段 |
| --- | --- | --- |
| 控制台：筛选、排序、卡片、预览、状态、刷新 | `src/MainWindow.cs` 的 BuildDashboard、ApplyThemeFilters、RefreshStatusAsync、RefreshDashboardPreview | P1 先做列表/预览/应用/状态；完整筛选与操作区在 P2/P4 完成 |
| 应用/启用、暂停/继续、重置、恢复 | MainWindow 的 ApplySelectedThemeAsync、EnableAsync、TogglePauseAsync、ResetSkinAsync、RestoreAsync；DreamSkinService | 流程决策归核心，脚本归平台适配；P1 包装最小应用路径，P3 收敛所有状态机 |
| 导入图片：单选编辑、批量添加、保存/保存并应用 | BuildCustomSkin、BrowseImageAsync、AddImagesAsync、SaveCustomAsync、ImportItemsAsync | 前端保留草稿；创建、去重、事务、逐项结果归核心，P2 |
| 主题设置：参数编辑、恢复已存参数、保存修改 | BuildSavedThemeEditor、SaveSavedThemeAsync、Models.cs | 无 WPF 类型的参数与业务模型归 contracts/core，P2 |
| 主题包、下载素材、删除 | ImportPackagesAsync、ExportSelectedTheme、DownloadSelectedMediaAsync、DeleteSelectedThemeAsync、ThemePackageService | 核心服务 + 文件选择/回收站能力，P2 |
| 检查更新、版本、打赏、消息与确认 | CheckForUpdateAsync、ShowDonationDialog、ConfirmStartupIfRequiredAsync | 更新策略归核心，安装归平台；UI 文案/提示共享，P4 |

Mac 的 ManagerWindow/ThemeSettingsView 不作为第二套设计源。保留其另存副本、静态/动态筛选、最近修改排序、原始视频播放、ZIP 兼容、操作记录。菜单栏/Dock、登录项、引擎修复、SwiftBar 兼容、社区入口和独立更新通道在 P4 接入同一核心，不遗漏为“非窗口功能”。

## 2. 功能与脚本差异

| 项目 | Windows 现状 | macOS 现状 | 决定 |
| --- | --- | --- | --- |
| 主题列表 | manager-actions `ListThemes` 独立于 Status，支持 Quick/SkipThemes | Status 可附带 list-manager-themes 输出；原生 GUI 还直接扫描目录 | 新契约列表与状态分开；不让状态刷新触发整个媒体库扫描 |
| 操作版本 | managerApiVersion 1.8 | managerApiVersion 1.5；gui-library 另有 create/save/import/export/delete | bridgeVersion 独立版本，不复制旧 supportedActions 当作新能力声明 |
| 编辑和删除预设 | UpdateTheme/DeletePreset；预设配置覆盖文件 | gui-library save/delete，预设已播种到用户主题库 | 以统一 ThemeRef 引用，平台仓储处理具体布局；不能把 Mac 主题目录替换成 Windows 相对路径 |
| 分类 | ThemeCategories 的 8 个显示类别：dynamic/people/anime/landscape/city/animals/technology/art；从 category、标签和扩展名推导 | gui-library 校验的是 dream/nature/cyber/minimal/dark/warm/custom/uncategorized；GUI 还有自己的筛选 | 区分 storageCategory 与 displayCategories；共享 UI 使用 Windows 推导规则，保存时不把显示 ID 直接写入旧枚举 |
| 透明度 | DTO 和 manager-actions 包含 bubbleOpacity/surfaceOpacity | gui-library 支持两字段，但 list-manager-themes 未输出，旧 manager-actions 参数也没有这两项 | 从受校验的完整主题配置读取；不可由旧列表默认值覆盖磁盘配置 |
| 自动焦点 | C# 列表模型默认 0.5；预览按焦点/自定义取景计算 | gui-library 指纹区分缺失焦点与显式 0.5；旧列表同样补 0.5 | 保留焦点字段是否存在；预览显示默认值不回写，区分自动与显式焦点 |
| 应用 | UI 先读状态，再确认启动/恢复；必要时 DeferLiveApply，视频先连接校验；读取 rendererApplied | switch-theme 处理切换、锁、快照及失败恢复；冷路径可调用 start --restart-existing | 首批接口不能简单映射成一条脚本；适配器需要保留全过程及重启约束 |
| 暂停/继续 | 返回 rendererRemoved/rendererApplied，UI 检查真实效果 | 兼容 Pause/Resume 仅回 isPaused；Resume 直接调用 --restart-existing | P3 包装有确认与实际效果证据的用例；不得直接暴露旧 Resume 给新 UI |
| 渲染状态 | Status 提供独立 rendererStatus/rendererMessage | Status 提供 session、injectorAlive、cdpOk、appliedThemeId；active 时可用 themeId 补 appliedThemeId，深度 CDP 检测只检查端点 | 不把 Mac active、ID 一致或 cdpOk 映射成“已核验渲染”；没有实际验证时标 unknown |
| 批量/包 | C# 包解析 + PowerShell 导入 | gui-package/gui-library 与 ZIP/批量 Shell 入口并存 | P2 统一单项导入事务、指纹和逐项结果，保留兼容入口 |
| 更新 | 静态清单 + SHA-256 + Windows 安装器 | 普通清单前往发布页；配置的 GUI 通道验签安装 | 共享查询模型，平台更新模式分别声明，不能降级信任校验 |

上述差异来自当前源码，不是运行结果。尤其不能根据“存在同名 Action”判断功能等价。

## 3. 数据归属与兼容读取

| 数据 | Windows 默认位置/来源 | macOS 默认位置/来源 | P1/P2 处理 |
| --- | --- | --- | --- |
| 用户数据根 | `%LOCALAPPDATA%/CodexDreamSkin` | `~/Library/Application Support/CodexDreamSkinStudio` | 平台适配提供；不对真实目录执行迁移 |
| 自定义库 | 数据根 `themes/` | 数据根 `themes/`，也含播种的预设 | 以来源+本地 ID 标识，不按绝对路径作为公共 ID |
| 内置主题 | 随包 windows/presets、catalog；数据根 preset-settings 覆盖参数 | 随包预设播种到用户库；deleted-presets 记录删除 | 保留来源、排序、覆盖与删除语义，不批量重新播种 |
| 活动主题 | 数据根 `active-theme/` | 数据根 `theme/` | 和“库中选中主题”独立；应用失败可能已写入期望值但未显示 |
| 状态/暂停 | `state.json`、`paused` | `state.json` 的 session 及 `operation-state.plist` 等 | 适配器各自解释，前端只接收归一化快照 |
| 恢复/并发 | 启动结果 token、备份与锁等脚本机制 | theme-backup、切换锁、operation ack、导入暂存/回滚记录 | 保留现有机制，核心内存队列不能代替跨进程锁 |
| 包参数 | manifest formatVersion 1，palette.accent | 磁盘 theme schemaVersion 1，colors.accent；包仍用 palette | 显式映射；Safe CSS/许可证/原始媒体一并保留 |
| 版本/诊断 | managerApiVersion/themeSchemaVersion/stateSchemaVersion/注入器/Node/Codex | 相应状态字段及 GUI 更新配置 | 协议、应用、引擎、数据版本各自表达，不能合并成单一 version |

参数约束基线：appearance 为 auto/light/dark；焦点 0..1；位置 -1..1；zoom 1..2；positionMode 为 locked/free；safeArea 为 auto/left/right/center/none；taskMode 为 auto/ambient/banner/full/off；bubbleOpacity 缺省 0、surfaceOpacity 缺省 0.8；accent 可清除。framingEnabled、缺失位置字段和旧版本推断需要兼容读取，不能因一次查看预览改变取景语义。

P1 的主题详情保留“存储参数”和“预览有效参数”的区别。旧列表缺字段、条目无效、目录不可读应返回警告/失败，不伪装为正常空库。Mac `SavedThemeLibrary.swift` 将 gothic-void-crusade/preset-gothic-void-crusade 视为逻辑别名，优先保留当前活动项，其次带 preset 前缀项；新仓储须保留这项显示去重和活动关联规则，不能直接重命名磁盘 ID。P2 编辑只提交明确修改字段，保留兼容字段；完整写入规则及未知字段策略在 P2 实现前确定。

## 4. P1 的架构决定

- UI：React/TypeScript/Vite；离线静态产物；三个页面沿用 Windows 布局。P1 只打通控制台最小闭环，不先搭完所有空页面。
- 进程：原生壳 ↔ Node 业务进程使用 UTF-8 NDJSON；前端通过原生桥接发 JSON 对象。日志不写协议 stdout。
- Node：先兼容仓库现有 Node 22。当前 Windows 固定 22.23.1，Mac prepare-node-runtime 固定 22.22.2；不因 P0 同步升级。前端工具必须选择兼容该范围的固定版本。
- Windows：保留现有 WPF/.NET Framework 构建入口；P1 选定兼容的 WebView2 SDK、loader 与版本锁定方式。便携版须有明确的运行时缺失提示/安装路径，不能假定所有 Windows 机器已安装。
- macOS：AppKit + WKWebView，macOS 13+、x64/arm64；继续使用当前签名与内置 Node 打包。Windows 上不能代替验证 Mac 编译或 WKWebView 行为。
- 静态资源：前端只加载随包资源；主题媒体经宿主映射的受限 URL，外部网页用系统浏览器。不将媒体路径和脚本参数暴露成通用前端执行接口。
- 首批主题应用：只能引用已列出的主题及其 revision，不允许 UI 提交任意目录或原始 shell 参数；适配器重读完整配置后调用旧业务链。
- 无副作用的重启预检不足时，先禁止该冷路径并返回明确 unsupported/confirmationRequired，直到完成适配；不得乐观调用可能重启的脚本。P1 完成前必须补齐该路径，不能靠永久禁用算闭环验收通过。

P1 需要实测后才能关闭的技术问题：两端 WebView 媒体资源映射/封面读取、Windows SDK/运行时打包、Mac 无重启预检和实际渲染验证适配、Node 退出后未完成操作的恢复。P0 确定处理边界，不把这些标记成已实现。

## 5. 首个闭环的执行清单

1. 建立 contracts 的运行时校验、UI 类型化客户端、Node 消息调度入口。公共 API 以 [bridge v1](manager-bridge-v1.md) 为准。
2. 实现平台只读仓储：列表、主题详情、资源句柄、版本/能力/状态。先解决 Mac 旧列表丢参数和 Windows 分类映射。
3. 两个壳加载同一页面并接入只读接口；保留旧构建入口，不切换默认发布包。
4. 提取/包装既有应用编排，补齐重启预检、确认绑定、配置 revision、串行操作及实际 renderer 结果。
5. UI 显示真实状态、任务进度和未确认结果；重开页面从快照恢复，选中预览不应用。

完成验收：同一静态前端分别列出旧主题、展示匹配参数的预览、在允许的情况下应用并核验结果；需要重启时先确认，拒绝后不重启；状态/事件丢失或业务进程退出不导致重复应用。所有未接入能力明确不可用，不产生虚假成功。

## 6. 本轮工作记录

- 工作：P0 基线与桥接设计；作者为主代理；旧业务和数据的唯一写入者仍为现有实现，本轮没有新增运行入口。
- 验收范围：功能归属、关键数据差异、首批接口和 P1 边界有可追溯源码依据；不包含运行验收。
- 检查：主代理源码静态核对；独立检查者 p0_check 对照两端源码审阅，并在修订后复核通过。首次发现的内容版本身份不足、持久登记/过期重放歧义、锁前复核竞态三项设计问题已修订，最终结论为可作为 P1 实施基线。检查为只读请求并核对工作区改动，非工具强制只读；未运行测试、构建、类型检查或 GUI。此结论仅覆盖设计，不证明契约和平台行为已实现。
- 任务记录限制：CatPaw doctor 报告 CHORE-009 两处 stage 枚举错误，以及 CHORE-009/CHORE-177 缺失完成证据。不能伪造旧证据或自动将旧完成状态改为通过；暂以本文保存工作事实。建立正式高风险实施 Work 前需处理看板，具体历史修正另行核对授权。
- 下一步：P1 从契约校验和只读后端入口开始；实际副作用接入需满足上述确认、状态与恢复条件。
