using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DreamSkin.SharedHost
{
    internal sealed class ManagerWindow : Window
    {
        private const string Page = "https://manager.dreamskin.invalid/index.html";
        private readonly WebView2 view = new WebView2();
        private readonly string root, sessionRoot, mediaDirectory;
        private readonly Dictionary<string, JObject> resources = new Dictionary<string, JObject>();
        private NativeBackend backend;
        private NativeFiles nativeFiles;
        internal readonly NativeDesktop Desktop;
        private string backendSession;
        private long eventSequence;
        private bool closed;
        internal ManagerWindow(string applicationRoot)
        {
            root = applicationRoot; Title = "Codex Dream Skin Manager"; Width = Math.Min(1400, SystemParameters.WorkArea.Width); Height = Math.Min(830, SystemParameters.WorkArea.Height); MinWidth = 820; MinHeight = 600;
            Desktop = new NativeDesktop(this);
            sessionRoot = Path.Combine(Path.GetTempPath(), "DreamSkin-manager-" + Guid.NewGuid().ToString("N"));
            mediaDirectory = Path.Combine(sessionRoot, "media"); Directory.CreateDirectory(mediaDirectory);
            Content = view; Loaded += async (sender, args) => {
                try
                {
                    var ui = Path.Combine(root, "ui", "manager"); SafeFiles.Check(Path.Combine(ui, "index.html"), root);
                    var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(sessionRoot, "webview"));
                    if (closed) return;
                    await view.EnsureCoreWebView2Async(environment); if (closed) return;
                    var web = view.CoreWebView2;
                    web.Settings.AreDevToolsEnabled = false; web.Settings.AreDefaultContextMenusEnabled = false;
                    web.Settings.AreHostObjectsAllowed = false; web.Settings.IsStatusBarEnabled = false;
                    web.SetVirtualHostNameToFolderMapping("manager.dreamskin.invalid", ui, CoreWebView2HostResourceAccessKind.DenyCors);
                    web.NavigationStarting += (s, e) => { if (e.Uri != Page) e.Cancel = true; };
                    web.FrameNavigationStarting += (s, e) => e.Cancel = true;
                    web.NewWindowRequested += (s, e) => e.Handled = true;
                    web.DownloadStarting += (s, e) => e.Cancel = true;
                    web.PermissionRequested += (s, e) => e.State = CoreWebView2PermissionState.Deny;
                    web.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                    web.WebResourceRequested += ResourceRequested;
                    StartBackend();
                    web.WebMessageReceived += async (s, e) => {
                        if (closed || e.Source != Page) return;
                        var current = backend; var files = nativeFiles;
                        try {
                            var request = NativeBackend.Parse(e.WebMessageAsJson);
                            if ((string)request["protocol"] == NativeBackend.Protocol && (string)request["kind"] == "host.reconnect") { StartBackend(); web.Reload(); return; }
                            if (backend == null || (backendSession == null && (string)request["method"] != "system.hello")) return;
                            if (current == null || files == null) return;
                            if (!await files.Handle(request) && backend == current) await current.Send(e.WebMessageAsJson);
                        } catch { if (backend == current) Disconnect(); }
                    };
                    web.Navigate(Page);
                }
                catch { if (!closed) Content = new System.Windows.Controls.TextBlock { Text = "无法打开管理器。请检查完整资源包和 WebView2 Runtime。", Margin = new Thickness(30), TextWrapping = TextWrapping.Wrap }; }
            };
            Closed += (sender, args) => {
                closed = true; Desktop.Close(); nativeFiles?.Close(); backend?.Dispose(); resources.Clear(); view.Dispose();
                // Only the random session directory allocated by this window is eligible for cleanup.
                try { foreach (var file in Directory.GetFiles(mediaDirectory)) File.Delete(file); Directory.Delete(mediaDirectory); } catch { }
                // WebView2 may still own profile files; defer their removal rather than deleting a live profile tree.
            };
        }
        private void StartBackend()
        {
            var previous = backend; backend = null;
            nativeFiles?.Close(); previous?.Dispose();
            resources.Clear(); backendSession = null; eventSequence = 0;
            var current = new NativeBackend(root, mediaDirectory); backend = current;
            nativeFiles = new NativeFiles(current, this, mediaDirectory, value => {
                if (!closed && backend == current) view.CoreWebView2.PostWebMessageAsJson(value.ToString(Formatting.None));
            }, Desktop);
            current.Message += value => Dispatcher.InvokeAsync(() => { if (backend != current) return; try { Receive(value); } catch { Disconnect(); } });
            current.Disconnected += () => Dispatcher.InvokeAsync(() => { if (backend == current) Disconnect(); });
            current.Start();
        }
        private void Disconnect()
        {
            var previous = backend; backend = null;
            previous?.Dispose(); nativeFiles?.Close();
            resources.Clear(); backendSession = null; eventSequence = 0;
            if (!closed && view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsJson("{\"protocol\":\"dreamskin.manager/1\",\"kind\":\"host.disconnected\"}");
        }
        private void Receive(JObject value)
        {
            if (closed) return;
            if (nativeFiles?.Receive(value) == true) return;
            var kind = (string)value["kind"];
            if (kind == "resource.release")
            {
                var id = (string)value["resourceId"] ?? "";
                if ((string)value["backendSessionId"] != backendSession || !Regex.IsMatch(id, "\\A[a-f0-9]{48}\\z")) { Disconnect(); return; }
                resources.Remove(id); return;
            }
            if (kind == "resource.register")
            {
                var id = (string)value["resourceId"] ?? "";
                var file = (string)value["fileName"] ?? "";
                if ((string)value["backendSessionId"] != backendSession || !Regex.IsMatch(id, "\\A[a-f0-9]{48}\\z") ||
                    !Regex.IsMatch(file, "\\A" + id + "\\.(jpg|jpeg|png|apng|webp|gif|mp4|heic|heif|tif|tiff)\\z") ||
                    !Regex.IsMatch((string)value["sha256"] ?? "", "\\A[a-f0-9]{64}\\z") ||
                    !DateTimeOffset.TryParse((string)value["expiresAt"], out var expiry) || expiry <= DateTimeOffset.UtcNow || expiry > DateTimeOffset.UtcNow.AddMinutes(6) ||
                    ((string)value["variant"] != "thumbnail" && (string)value["variant"] != "preview")) { Disconnect(); return; }
                foreach (var key in new List<string>(resources.Keys))
                    if (DateTimeOffset.Parse((string)resources[key]["expiresAt"]) <= DateTimeOffset.UtcNow) resources.Remove(key);
                if (resources.Count < 64) resources[id] = value;
                return;
            }
            if (kind == "event")
            {
                var sequence = value["sequence"];
                if (backendSession == null || (string)value["backendSessionId"] != backendSession || sequence?.Type != JTokenType.Integer ||
                    (long)sequence <= eventSequence || (long)sequence > 9007199254740991L) return;
                var name = (string)value["event"];
                if (!new HashSet<string> { "status.changed", "operation.changed", "status.invalidated", "session.closing" }.Contains(name) ||
                    // Read snapshot through JObject: a JSON null is a mismatch here, not a throw.
                    (name == "status.changed" && ((string)(value["snapshot"] as JObject)?["backendSessionId"] != backendSession)) ||
                    (name == "operation.changed" && !(value["operation"] is JObject))) { Disconnect(); return; }
                eventSequence = (long)sequence;
                view.CoreWebView2.PostWebMessageAsJson(value.ToString(Formatting.None)); return;
            }
            if (kind != "response") { Disconnect(); return; }
            // A JSON null result arrives as JValue, not as null: indexing it throws
            // and the catch above would drop the whole backend connection.
            var session = (string)(value["result"] as JObject)?["backendSessionId"];
            if (session != null) { if (backendSession != null && backendSession != session) resources.Clear(); backendSession = session; }
            view.CoreWebView2.PostWebMessageAsJson(value.ToString(Formatting.None));
        }
        private async void ResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            var deferral = e.GetDeferral();
            try
            {
                var uri = new Uri(e.Request.Uri);
                if (e.Request.Method != "GET" || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)) throw new IOException();
                if (uri.Scheme == "https" && uri.Host == "manager.dreamskin.invalid" && uri.Port == 443)
                {
                    var relative = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
                    if (relative.Contains("\\") || relative.Contains(":")) throw new IOException();
                    var file = Path.GetFullPath(Path.Combine(root, "ui", "manager", relative));
                    SafeFiles.Check(file, Path.Combine(root, "ui", "manager"));
                    if (!new HashSet<string> { ".html", ".js", ".css", ".woff2" }.Contains(Path.GetExtension(file))) throw new IOException();
                    return; // WebView2 virtual-host mapping serves the checked static resource.
                }
                if (uri.Scheme != "https" || uri.Host != "media.dreamskin.invalid" || uri.Port != 443) throw new IOException();
                var id = uri.AbsolutePath.TrimStart('/');
                if (!Regex.IsMatch(id, "\\A[a-f0-9]{48}\\z") || !resources.TryGetValue(id, out var resource) ||
                    DateTimeOffset.Parse((string)resource["expiresAt"]) <= DateTimeOffset.UtcNow) throw new IOException();
                var source = Path.Combine(mediaDirectory, (string)resource["fileName"]); SafeFiles.Check(source, mediaDirectory);
                using (var handle = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (handle.Length < 1 || handle.Length > 128L * 1024 * 1024) throw new IOException();
                    using (var hash = SHA256.Create())
                        if (BitConverter.ToString(hash.ComputeHash(handle)).Replace("-", "").ToLowerInvariant() != (string)resource["sha256"]) throw new IOException();
                    var image = await PreviewImageLoader.LoadAsync(source, (string)resource["variant"] == "thumbnail" ? 400 : 1200);
                    if (closed) return;
                    if (!resources.TryGetValue(id, out var current) || current != resource ||
                        DateTimeOffset.Parse((string)resource["expiresAt"]) <= DateTimeOffset.UtcNow) throw new IOException();
                    if (image == null) throw new IOException();
                    var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(image));
                    var stream = new MemoryStream(); encoder.Save(stream); stream.Position = 0;
                    e.Response = view.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", "Content-Type: image/png\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nAccess-Control-Allow-Origin: https://manager.dreamskin.invalid\r\nContent-Security-Policy: default-src 'none'");
                }
            }
            catch { if (!closed) e.Response = view.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes("Preview unavailable")), 404, "Unavailable", "Content-Type: text/plain\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff"); }
            finally { deferral.Complete(); }
        }
    }
}
