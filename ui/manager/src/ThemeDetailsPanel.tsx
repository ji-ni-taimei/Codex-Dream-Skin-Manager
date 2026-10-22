import { useText } from "./desktop";
import { useState } from "react";
import type { ReactNode } from "react";
import type { HelloResult, ManagerSnapshot, RuntimeMethod, ThemeDetails, ThemeSummary } from "../../../contracts/manager.mjs";
import { ManagerClient } from "./client";
import { MediaPreview } from "./MediaPreview";
import { previewParameters } from "./preview-model";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { StartupAnimationControls } from "./StartupAnimationControls";

export function ThemeDetailsPanel({ client, hello, theme, selectedPreview = null, activeTheme = null, snapshot, loading, visible, busy, draftDirty, canApply, onApply, onOriginal, onEdit, onControl, onRefresh, children }: {
  client: ManagerClient | null; hello: HelloResult | null; theme: ThemeDetails | null; loading: boolean; visible: boolean;
  busy: boolean; draftDirty: boolean; canApply: boolean; onApply(): void;
  onOriginal(action: "files.saveOriginal" | "files.playOriginal" | "files.exportPackage"): void; onEdit?: () => void; children?: ReactNode;
  selectedPreview?: ThemeSummary | null; activeTheme?: ThemeDetails | null; snapshot?: ManagerSnapshot | null; onControl?(method: RuntimeMethod): void; onRefresh?(): void;
}) {
  const tr = useText();
  const [mediaMenu, setMediaMenu] = useState(false);
  const selectedTheme = theme ?? selectedPreview, shown = selectedTheme ?? activeTheme;
  const runtimeAllowed = (action: "pause" | "resume" | "reset" | "restore") => !busy && (action === "pause"
    ? !!hello?.capabilities.methods.includes("skin.pause")
    : !draftDirty && !!snapshot?.runtime?.revision && (snapshot.availability[action]?.allowed || action !== "restore" && snapshot.availability[action]?.reasonCode === "BUSY"));
  if (onEdit) return <section className="inspector dashboard-inspector" aria-label={tr("当前皮肤控制")} tabIndex={hello?.platform === "macos" ? 0 : undefined} onKeyDown={event => {
    if ((event.key === "ContextMenu" || event.shiftKey && event.key === "F10") && hello?.platform === "macos" && theme && theme.mediaKind !== "image" && hello.capabilities.methods.includes("files.playOriginal")) { event.preventDefault(); setMediaMenu(true); }
  }} onContextMenu={event => {
    if (hello?.platform === "macos" && theme?.mediaKind !== "image" && theme && hello.capabilities.methods.includes("files.playOriginal")) { event.preventDefault(); setMediaMenu(true); }
  }}>
    {shown && client ? <MediaPreview key={`${selectedTheme ? "library" : "active"}:${shown.revision}`} client={client}
      target={selectedTheme ? { kind: "theme", theme: selectedTheme.ref, revision: selectedTheme.revision, variant: "preview" } : { kind: "active", revision: shown.revision }}
      name={shown.name} parameters={theme ? previewParameters(theme.storedParameters) : selectedTheme ? null : activeTheme ? previewParameters(activeTheme.storedParameters) : null} mediaKind={shown.mediaKind} visible={visible} />
      : <div className="preview placeholder">{loading ? tr("正在读取详情…") : tr("尚无可预览的当前皮肤")}</div>}
    <div className="detail-body"><p className="eyebrow">{tr("当前主题")}</p><h2>{activeTheme?.name ?? tr(snapshot?.desired.theme ? "状态暂不可用" : "未运行")}</h2>
      <button className="primary" disabled={busy || draftDirty || loading || (selectedTheme ? !theme || !canApply : !runtimeAllowed("resume"))} onClick={onApply}>{tr("应用皮肤")}</button>
      <div className="dashboard-actions">
        <button disabled={busy || !theme || !hello?.capabilities.methods.includes("files.saveOriginal")} onClick={() => onOriginal("files.saveOriginal")}>{tr("下载素材")}</button>
        <button disabled={!theme} onClick={onEdit}>{tr("编辑参数")}</button>
        <button disabled={!runtimeAllowed(snapshot?.desired.paused ? "resume" : "pause")} onClick={() => onControl?.(snapshot?.desired.paused ? "skin.resume" : "skin.pause")}>{tr(snapshot?.desired.paused ? "继续" : "暂停")}</button>
        <button disabled={!runtimeAllowed("reset")} onClick={() => onControl?.("skin.reset")}>{tr("重置")}</button>
        <button disabled={busy || !hello} onClick={onRefresh}>{tr("刷新")}</button>
        <button className="danger" disabled={!runtimeAllowed("restore")} onClick={() => onControl?.("skin.restore")}>{tr("恢复原貌")}</button>
      </div>
      {client && hello?.capabilities.methods.includes("startup.update") && <StartupAnimationControls client={client} theme={theme} busy={busy} />}
      {mediaMenu && <ConfirmationDialog title={tr("原始素材")} onCancel={() => setMediaMenu(false)}><button disabled={busy} onClick={() => { setMediaMenu(false); onOriginal("files.playOriginal"); }}>{tr("打开原始素材")}</button><button onClick={() => setMediaMenu(false)}>{tr("关闭")}</button></ConfirmationDialog>}
    </div>
  </section>;
  return <section className="inspector" aria-label={onEdit ? tr("已保存主题与操作") : tr("主题设置与草稿")}>
    {theme && client ? <>
      <div className="detail-body">
        {children}
      </div></> : <div className="empty inspector-empty">{loading ? tr("正在读取详情…") : tr("在控制台选择一个主题，查看素材与参数。")}</div>}
  </section>;
}
