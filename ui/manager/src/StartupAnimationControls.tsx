import { useEffect, useRef, useState } from "react";
import type { StartupAnimationSettings, StartupAnimationUpdate, ThemeDetails } from "../../../contracts/manager.mjs";
import type { ManagerClient } from "./client";
import { useMessage, useText } from "./desktop";
import { errorMessage } from "./ui-message";
import type { UiMessage } from "./ui-message";

export function StartupAnimationControls({ client, theme, busy }: { client: ManagerClient; theme: ThemeDetails | null; busy: boolean }) {
  const tr = useText(), msg = useMessage();
  const [settings, setSettings] = useState<StartupAnimationSettings | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState<UiMessage>("");
  const current = useRef(client), writing = useRef(false);
  current.current = client;
  useEffect(() => {
    let active = true;
    setSettings(null); setError("");
    void client.call("startup.get", {}).then(value => { if (active) setSettings(value); })
      .catch(error => { if (active) setError(errorMessage(error, "启动动画设置未能读取。")); });
    return () => { active = false; };
  }, [client]);
  async function update(params: StartupAnimationUpdate) {
    if (writing.current || busy || !settings) return;
    writing.current = true; setSaving(true); setError("");
    try {
      const value = await client.call("startup.update", params);
      if (current.current === client) setSettings(value);
    } catch (error) { if (current.current === client) setError(errorMessage(error, "启动动画设置未能保存。")); }
    finally { writing.current = false; if (current.current === client) setSaving(false); }
  }
  const selected = !!theme && settings?.theme?.source === theme.ref.source && settings.theme.id === theme.ref.id;
  const locked = busy || saving || !settings;
  return <section aria-label={tr("启动动画")}>
    <h3>{tr("启动动画")}</h3>
    <label><input type="checkbox" checked={settings?.enabled ?? false} disabled={locked}
      onChange={event => void update({ enabled: event.target.checked })} />{tr("启用启动动画")}</label>
    {settings && <p className="muted">{tr("当前动画")}：{settings.themeName ?? tr("内置默认动画")}</p>}
    <div className="dashboard-actions">
      <button disabled={locked || theme?.mediaKind !== "video" || selected} title={theme?.mediaKind !== "video" ? tr("请选择视频主题") : undefined}
        onClick={() => { if (theme) void update({ theme: theme.ref, expectedRevision: theme.revision }); }}>{tr(selected ? "已设为启动动画" : "设为启动动画")}</button>
      <button disabled={locked || !settings?.theme} onClick={() => void update({ theme: null })}>{tr("恢复默认动画")}</button>
    </div>
    <p className="muted">{tr("仅在启动 Codex 时播放，切换皮肤不会播放。")}</p>
    {settings?.theme && <p className="muted">{tr("视频主题被删除或不可用时，使用内置默认动画。")}</p>}
    {error && <p className="notice" role="status">{msg(error)}</p>}
  </section>;
}
