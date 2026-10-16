import { useMessage } from "./desktop";
import { errorMessage, uiMessage } from "./ui-message";
import type { UiMessage } from "./ui-message";
import { useText } from "./desktop";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { MediaResource, ThemeParameters, ThemeSummary } from "../../../contracts/manager.mjs";
import type { ManagerClient } from "./client";
import { emptyParameters, previewLayout, previewParameters } from "./preview-model";
import type { PreviewSize } from "./preview-model";
import { previewKey, resolvePreview } from "./preview-resources";
import type { PreviewTarget } from "./preview-resources";

export function MediaPreview({ client, target, name, parameters = null, visible, thumbnail = false, refresh = 0 }: {
  client: ManagerClient; target: PreviewTarget; name: string; parameters?: ThemeParameters | null; mediaKind?: ThemeSummary["mediaKind"] | "unknown";
  visible: boolean; thumbnail?: boolean; refresh?: number;
}) {
  const tr = useText(), msg = useMessage();
  const container = useRef<HTMLDivElement>(null);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [viewport, setViewport] = useState<PreviewSize>({ width: 0, height: 0 });
  const [image, setImage] = useState<PreviewSize>({ width: 0, height: 0 });
  const [resource, setResource] = useState<MediaResource | null>(null), [error, setError] = useState<UiMessage>("");
  const [attempt, retry] = useState(0);
  // Library thumbnails load for every mounted card, including offscreen cards.
  // Scrolling or hiding the window must not discard an already decoded image.
  const key = previewKey(target), active = thumbnail || visible;
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const appearance = () => setSystemDark(media.matches);
    media.addEventListener("change", appearance);
    return () => media.removeEventListener("change", appearance);
  }, []);
  useEffect(() => {
    const element = container.current; if (!element || !active) return;
    const measure = () => { const bounds = element.getBoundingClientRect(); setViewport({ width: bounds.width, height: bounds.height }); };
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    // The serialized key binds every target field; parameter drafts never requery media.
    setResource(null); setImage({ width: 0, height: 0 }); setError("");
    if (!active) return;
    const abort = new AbortController();
    void resolvePreview(client, target, abort.signal).then(value => { if (!abort.signal.aborted) setResource(value); }, error => {
      if (!abort.signal.aborted) setError(errorMessage(error, "此素材暂不支持预览。"));
    });
    return () => abort.abort();
  }, [client, key, active, attempt, refresh]);
  useEffect(() => {
    if (!resource || !active || error) return;
    // Expiry limits future native reads; it does not invalidate a decoded image.
    // Keep completed thumbnails instead of periodically reloading the whole list.
    if (thumbnail && image.width > 0 && image.height > 0) return;
    const delay = Date.parse(resource.expiresAt) - Date.now() - 10000;
    if (!Number.isFinite(delay)) return;
    const timer = window.setTimeout(() => retry(value => value + 1), Math.max(1000, delay));
    return () => window.clearTimeout(timer);
  }, [resource, active, error, thumbnail, image.width, image.height]);
  const params = previewParameters(parameters ?? emptyParameters), layout = previewLayout(image, viewport, params);
  const dark = params.appearance === "dark" || params.appearance === "auto" && systemDark;
  const rgb = dark ? "24, 28, 34" : "248, 249, 251";
  const style = { "--preview-surface": `rgba(${rgb},${params.surfaceOpacity})`, "--preview-bubble": `rgba(${rgb},${params.bubbleOpacity})`,
    "--preview-accent": params.accent ?? (dark ? "#E9CB7B" : "#80602C") } as CSSProperties;
  const mode = params.taskMode === "auto" ? "ambient" : params.taskMode ?? "ambient";
  return <div className={`media-preview ${thumbnail ? "thumbnail-preview" : "full-preview"}`}>
    <div ref={container} className={`preview media-canvas ${!thumbnail ? "with-illustration" : ""} ${dark ? "preview-dark" : "preview-light"}`}
      data-safe-area={params.safeArea} data-task-mode={!thumbnail ? mode : "full"} style={style}>
      {resource && !error ? <img key={resource.resourceId} className="preview-media" src={resource.url} alt={name} draggable={false}
        onLoad={event => { const element = event.currentTarget; if (element.naturalWidth > 0 && element.naturalHeight > 0) setImage({ width: element.naturalWidth, height: element.naturalHeight }); else setError(uiMessage("当前素材无法获得预览尺寸。")); }}
        onError={() => setError(uiMessage("此素材暂时无法显示预览，请重试或继续查看主题信息。"))}
        style={layout ? { width: layout.width, height: layout.height, left: layout.x, top: layout.y } : { visibility: "hidden" }} /> :
        <div className="placeholder" title={error ? msg(error) : undefined}><span>{error ? thumbnail ? tr("预览不可用") : msg(error) : active ? tr("正在准备预览…") : tr("等待预览")}</span>
          {error && !thumbnail && <button type="button" onClick={() => retry(value => value + 1)}>{tr("重试预览")}</button>}</div>}
      {resource && !error && !thumbnail && <div className="preview-workspace" aria-hidden="true">
        <div className="preview-sidebar"><span /><span /><span /></div>
        <div className="preview-conversation"><div className="preview-bubble" /><div className="preview-composer" /></div>
      </div>}
    </div>
  </div>;
}
