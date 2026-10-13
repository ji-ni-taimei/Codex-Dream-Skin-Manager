# 管理器桥接契约 v1（P0 设计基线）

状态：规范草案，尚无实现；协议标识 `dreamskin.manager/1`。本文定义 P1 的最小公共边界，P2/P3 扩展命令时继续维护本文件。它不替代旧 managerApiVersion 或磁盘 schemaVersion。

## 1. 消息与会话

前端调用宿主受限桥接；宿主与 Node 业务进程用 UTF-8 NDJSON，一行一个 JSON 对象。宿主只转发允许的命令，Node 再验证类型和业务条件。宿主调用系统能力使用独立内部协议，不接受前端直接伪造的内部消息。

请求：

```json
{"protocol":"dreamskin.manager/1","kind":"request","requestId":"r1","method":"themes.list","params":{}}
```

成功响应：

```json
{"protocol":"dreamskin.manager/1","kind":"response","requestId":"r1","ok":true,"result":{"revision":"catalog-opaque","themes":[],"warnings":[]}}
```

失败响应：

```json
{"protocol":"dreamskin.manager/1","kind":"response","requestId":"r1","ok":false,"error":{"code":"BACKEND_UNAVAILABLE","message":"主题服务暂不可用","retryable":true}}
```

约束：请求 ID 在连接内唯一；响应只能有 result 或 error；未知方法、版本、不合法参数必须拒绝。握手先于其他命令，返回 backendSessionId、能力、平台与版本；业务进程重启后会话 ID 变化，旧资源和确认 token 失效。错误 message 用于诊断，UI 依赖 code 选择文案，不解析中英文异常字符串控制流程。

握手前及接收时限制单行 1 MiB，拒绝无限缓存和过长消息；列表用分页限制单条大小，默认 100 条、最大 200 条。媒体内容不嵌入消息。所有字符串、数组、字段长度还需运行时校验；平台日志输出不得混入 NDJSON。具体操作超时由后端按操作配置，超时不自动重试副作用。

## 2. 首批方法

| 方法 | 参数 | 结果 | 副作用 |
| --- | --- | --- | --- |
| `system.hello` | `{}` | 会话 ID、platform、versions、capabilities | 无业务写入 |
| `status.get` | `{}` | ManagerSnapshot | 读取/探测，不启动 Codex，不修复状态文件 |
| `themes.list` | `{cursor?, limit?}` | `{revision, themes, nextCursor?, warnings}` | 无业务写入；目录错误不转换为空成功 |
| `themes.get` | `{theme: ThemeRef}` | ThemeDetails | 无业务写入；无效/删除条目返回明确错误 |
| `media.resolve` | `{theme: ThemeRef, revision, variant: "thumbnail" | "preview"}` | `{resourceId, url, mimeType, expiresAt}` | 可创建派生缓存，不修改原始素材/主题 |
| `skin.apply` | `{operationId, theme: ThemeRef, expectedRevision}` | OperationSnapshot | 提交一次应用意图，可能先进入 awaitingConfirmation |
| `operations.get` | `{operationId}` | OperationSnapshot | 查询，不自动继续或重放 |
| `operations.confirm` | `{operationId, confirmationId, accepted}` | OperationSnapshot | 同意才继续对应动作，拒绝则取消尚未执行部分 |
| `events.subscribe` | `{}` | `{subscriptionId, sequence, snapshot, activeOperations}` | 注册本连接事件；快照与序号在同一时点取得 |
| `events.unsubscribe` | `{subscriptionId}` | `{}` | 释放订阅 |

初始能力只声明已完成适配的方法。P2 的创建、编辑、另存、删除、导入导出，P3 的暂停/继续/重置/恢复，P4 的社区/更新/维护不在本批可调用集合内，不提前返回假的成功结果。

capabilities 是“实现支持情况”；快照中的 availability 是“当前是否可执行及原因”，两者不能混用。支持 apply 不意味着当前可以绕过重启确认。

## 3. 主题与媒体模型

ThemeRef：`{source: "preset" | "saved", id: string}`。source/id 是本机仓储中的身份，不保证不同机器同名主题内容相同；不得由客户端提供 themeDirectory/imagePath 替代引用。

ThemeSummary 包含：ref、name、storageCategory、displayCategories、tags、mediaKind（image/animatedImage/video）、catalogOrder、addedAt/modifiedAt（未知用 null）、revision。Mac 顺序需使用 GUI 预设 catalog 顺序，不用旧列表的目录字母序冒充 Windows 目录顺序。日期字段的来源保持明确，不把 birthtime 当作跨平台一致的导入时间。

revision 为适配器生成的不透明内容版本，至少覆盖本次操作依赖的配置、媒体和 CSS；不使用仅文件 mtime 判断内容未变。列表分页 cursor 绑定 catalog revision，库变化后拒绝旧 cursor 并要求从首页刷新。

ThemeDetails 包含 Summary、存储参数、有效预览参数、媒体尺寸/格式、警告和可操作性。存储参数保留缺省信息：缺失 focusX/focusY 用 null 表示自动，不用 0.5 替代；显式 0.5 与自动不同。取景同样保留显式/缺省信息。前端预览可使用有效参数，但不能据此回写完整主题文件。

media.resolve 返回 URL 由宿主为当前会话映射，资源 ID 只引用已经校验过的本地素材/缓存；不接受任意 URL、路径或相对路径穿越。资源服务必须限制根目录、符号链接及 reparse point，设置正确 MIME，并拒绝通过媒体入口加载可执行页面。URL 过期/会话切换后重新 resolve。缓存未就绪或格式不支持需返回明确原因；不把原始视频当成可随意加载的 HTML 内容。

## 4. 状态模型与旧接口映射

ManagerSnapshot：

```text
backendSessionId, sequence, observedAt
desired: { theme: ThemeRef | null, revision: string | null, paused: boolean | null }
engine: { health: healthy | stopped | stale | degraded | mismatch | unknown,
          runtimeSessionId: string | null }
renderer: { status: applied | removed | unknown | unavailable,
            theme: ThemeRef | null, revision: string | null,
            runtimeSessionId: string | null, verifiedAt: string | null }
operationIds: string[]
availability: { apply: { allowed: boolean, reasonCode: string | null } }
diagnostics: { code, message }[]
```

这里的 nullable 表示“不知道”，不是 false。observedAt 只说明读取时间，verifiedAt 必须来自实际渲染验证，不能用状态文件更新时间填充。desired.revision 是提交的内容版本，renderer.revision 是当前会话实际验证的内容版本；原始库 revision 与注入器 expectedRevision 可以采用不同算法，但适配器必须保存并校验两者的映射。同 ID 编辑后，旧内容的 applied 不能作为新操作成功证据；无法得到内容版本时 revision 为 null，不能宣称匹配当前目标。

| 旧数据 | 映射约束 |
| --- | --- |
| Windows activeThemeId、isPaused | desired；身份由仓储解析，无法解析时保留诊断并返回 null |
| Windows statusKind/isRunning | engine 的输入；原始未知值归 unknown，不吞掉诊断 |
| Windows rendererStatus/rendererMessage | 只有当前会话与目标匹配的探测结果才能映射 applied/removed；不从 isRunning 推断 |
| Mac session/injectorAlive | engine/desired 的输入，不是 renderer 证据 |
| Mac appliedThemeId/cdpOk | 只作历史/连接诊断；不能仅凭这些字段设置 verifiedAt 或 applied |
| Mac operation/operationMessage | 作为旧引擎操作提示，不冒充有新 operationId 的完整操作账本 |

需要补齐的 Mac renderer 适配在 P1 实现：核验目标会话、目标主题和实际效果后才能报告应用成功。若只能拿到旧状态，返回 unknown/未确认，不能把 P1 实际应用验收标为通过。

## 5. 应用、确认与幂等

operationId 采用 `backendSessionId:UUID`，由客户端在握手后生成并在调用前保留，页面重建后能查询。只有 skin.apply 可以接受当前会话前缀的首次 ID；其他接口的未知 ID 一律 OPERATION_UNKNOWN。已知 ID 同参数返回原操作，同 ID 不同参数报 OPERATION_CONFLICT。未知旧会话 ID 不得执行，即使客户端认为它是首次请求也要求明确重新发起。

后端必须在返回操作已接受或调用任何业务副作用之前，原子持久化 ID、规范化请求摘要、预期 revision 和 queued 状态；持久化失败则不执行。同 ID 并发请求通过互斥完成一次登记，不能启动两个脚本。记录位于平台数据根新增的 manager-operations 目录，不改旧 schema。同一会话内不删除 ID/请求摘要；详细日志可裁剪，但保留去重墓碑。跨会话已知 ID 只查询/对账，不自动继续旧确认或重放；清理后的旧 ID 因会话前缀失效而拒绝，不能重新当作新请求。具体日志保留上限在 P1 定义，达到上限可拒绝新操作，不能为腾空间破坏去重边界。

OperationSnapshot 至少包含：id、method、state、stage、theme、expectedRevision、committedRevision、verifiedRendererRevision、startedAt、updatedAt、confirmation、effects、error、最终 snapshot。state 为 queued/running/awaitingConfirmation/succeeded/failed/cancelled/indeterminate。

effects 分别表达 themeCommitted、rendererApplied、codexRestarted（均为 true/false/null），避免部分提交伪装为全成功或完全未发生。succeeded 要求本次提交内容版本与目标运行会话的渲染核验通过；runtimeSessionId 是平台适配器基于已核验浏览器/进程身份生成的不透明标识，与业务进程 backendSessionId 不同。操作结果保存目标 runtimeSessionId；旧会话验证不得用于新会话成功声明。保存成功但未显示只能返回未完成/失败或 indeterminate，并说明已发生的影响。

执行顺序：

1. 校验身份、revision、能力、请求 ID；查询真实状态，取得写操作互斥。排队期间不长时间持有旧脚本锁。
2. 无副作用预检目标配置、媒体及启动条件。涉及重启时创建确认请求，释放短期锁；等待确认期间不得启动该重启路径。
3. confirmation 包含随机 ID、操作 ID、原因、影响说明和到期时间（默认 5 分钟），由后端生成且单次使用。UI 只能转交用户决定。
4. 同意后重新核验 revision 和重启前提，在实际负责写入的锁内再次检查 revision 后执行；环境/目标改变时使确认失效并重新预检。不能用一个布尔 restart=true 长期授权。适配器不能持有不可重入旧锁再启动会重复加锁的脚本：优先将 expectedRevision 检查下沉到旧脚本的同一锁内，或使用其已有受校验 lock-token 机制；具体选型按平台确认。
5. 使用锁内验证的稳定内容快照调用受限平台流程、读取实际结果、刷新状态后完成。实际重启边界再核对进程/会话身份与已确认前提；条件改变则拒绝并重新预检/确认。若连接在热应用中失效，需要重启时重新走确认，不默认升级权限。
6. 拒绝前尚未写入则 cancelled；若主题已经保存但需要恢复，effects 必须反映部分提交。取消不等于回滚已提交结果，不强杀事务脚本。

业务进程崩溃/通信超时后，将无法确定结果的运行操作标为 indeterminate，先核对既有事务、状态与 renderer；不得自动重放应用或重启。持久日志本身不能保证 exactly-once，旧脚本需通过恢复/对账消除不确定性。历史 ID 不在保留范围内时返回 OPERATION_UNKNOWN，并要求用户刷新/明确重新发起，不能透明重试。

P1 不提供通用 cancelRunning；仅允许拒绝等待中的确认。后续增加取消必须定义事务安全点。

## 6. 事件及错误

事件携带 protocol、kind=event、backendSessionId、subscriptionId、sequence、event、payload。event 初始为 status.changed、operation.changed、themes.changed；sequence 在单个后端会话递增。订阅返回的快照与后续事件不能出现中间遗漏；实现可用串行调度/缓冲保证。页面发现序号断档或会话变化时重新订阅取快照，已缓存的旧会话事件丢弃，不用事件推断写操作需要重试。

首批错误码：PROTOCOL_UNSUPPORTED、INVALID_REQUEST、METHOD_UNSUPPORTED、BACKEND_UNAVAILABLE、THEME_NOT_FOUND、THEME_INVALID、THEME_CHANGED、CATALOG_CHANGED、MEDIA_UNSUPPORTED、RESOURCE_EXPIRED、BUSY、CONFIRMATION_EXPIRED、OPERATION_CONFLICT、OPERATION_UNKNOWN、RUNTIME_UNAVAILABLE、RENDERER_UNVERIFIED、IO_ERROR、TIMEOUT。

retryable 只表示条件可能恢复，不授权客户端重试副作用。旧脚本的自由文本错误在适配器分类，不能猜测错误内容并自动重启；无法可靠分类时返回诊断及保守结果。

## 7. P1 实现前检查点

- 契约运行时 schema、消息大小、版本拒绝和资源校验尚待实现；本文件不是已启用的安全边界。
- 两端需要把完整应用编排放入适配器，特别是 Windows UI 现有的恢复/视频分支和 Mac 冷启动重启分支。
- 模拟后端可以用于开发 UI，但真实应用完成声明必须来自相应平台的实际结果，不能用模拟状态代替。
- 不要求前端先订阅才能执行只读请求；副作用状态始终可以通过 operations.get/status.get 恢复。
