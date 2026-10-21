using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DreamSkin.SharedHost
{
    // One private renderer serves all frame requests. No Codex connection or Shell handler is needed.
    internal sealed class VideoPreviewDecoder : IDisposable
    {
        private WebView2 view;
        private readonly Panel parent;
        private readonly CoreWebView2Environment environment;
        private readonly Dictionary<string, TaskCompletionSource<string>> pending = new Dictionary<string, TaskCompletionSource<string>>();
        private Task ready;
        private bool closed, resetRequired;

        internal VideoPreviewDecoder(CoreWebView2Environment environment, Panel parent)
        {
            this.environment = environment;
            this.parent = parent;
            view = CreateView();
            parent.Children.Add(view);
        }

        internal Task<BitmapSource> LoadAsync(string path, int maximumWidth)
        {
            return parent.Dispatcher.InvokeAsync(() => LoadOnUiAsync(path, maximumWidth)).Task.Unwrap();
        }

        private static WebView2 CreateView() => new WebView2 { Width = 1, Height = 1, Visibility = Visibility.Hidden,
            IsHitTestVisible = false, HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top };

        private async Task UntilAsync(Task operation, Task deadline, WebView2 owner)
        {
            if (await Task.WhenAny(operation, deadline) != operation)
            {
                if (!closed && view == owner) resetRequired = true;
                // Native calls cannot be cancelled; observe a late failure without holding a decode slot.
                _ = operation.ContinueWith(task => { var error = task.Exception; },
                    TaskContinuationOptions.OnlyOnFaulted);
                throw new IOException("Video preview timed out.");
            }
            await operation;
        }

        private async Task<T> UntilAsync<T>(Task<T> operation, Task deadline, WebView2 owner)
        {
            await UntilAsync((Task)operation, deadline, owner);
            return await operation;
        }

        private async Task InitializeAsync()
        {
            var currentView = view;
            await currentView.EnsureCoreWebView2Async(environment);
            if (closed || view != currentView) throw new ObjectDisposedException(nameof(VideoPreviewDecoder));
            var web = currentView.CoreWebView2;
            web.Settings.AreDevToolsEnabled = false; web.Settings.AreDefaultContextMenusEnabled = false;
            web.Settings.AreHostObjectsAllowed = false; web.Settings.IsStatusBarEnabled = false;
            web.NavigationStarting += (s, e) => { if (e.Uri != "about:blank") e.Cancel = true; };
            web.FrameNavigationStarting += (s, e) => e.Cancel = true;
            web.NewWindowRequested += (s, e) => e.Handled = true;
            web.DownloadStarting += (s, e) => e.Cancel = true;
            web.PermissionRequested += (s, e) => e.State = CoreWebView2PermissionState.Deny;
            web.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            web.WebResourceRequested += (s, e) => {
                if (!e.Request.Uri.StartsWith("blob:", StringComparison.Ordinal))
                    e.Response = environment.CreateWebResourceResponse(new MemoryStream(), 403, "Blocked", "");
            };
            web.ProcessFailed += (s, e) => {
                if (view != currentView || closed) return;
                resetRequired = true;
                foreach (var job in pending.Values) job.TrySetException(new IOException("Video preview renderer stopped."));
            };
            web.WebMessageReceived += (s, e) => {
                if (closed || view != currentView || e.Source != "about:blank") return;
                try {
                    var json = e.WebMessageAsJson;
                    if (json.Length > 12 * 1024 * 1024) throw new IOException("Video preview exceeds its size limit.");
                    var message = JObject.Parse(json);
                    if (!pending.TryGetValue((string)message["id"] ?? "", out var job)) return;
                    if (message["data"]?.Type == JTokenType.String) job.TrySetResult((string)message["data"]);
                    else {
                        var reason = (string)message["error"] ?? "unknown";
                        // Reasons originate in the fixed private page, not in media metadata.
                        if (reason.Length < 64) PreviewImageLoader.ReportFailure("webview-" + reason, new IOException());
                        job.TrySetException(new IOException("WebView2 video preview failed."));
                    }
                } catch (Exception error) { PreviewImageLoader.ReportFailure("webview-message", error); }
            };
            var navigation = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler<CoreWebView2NavigationCompletedEventArgs> completed = null;
            completed = (s, e) => { web.NavigationCompleted -= completed; navigation.TrySetResult(e.IsSuccess); };
            web.NavigationCompleted += completed;
            web.NavigateToString("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; media-src blob:\"><body></body>");
            try {
                if (await Task.WhenAny(navigation.Task, Task.Delay(10000)) != navigation.Task || !await navigation.Task)
                    throw new IOException("Video preview page did not initialize.");
            } finally { web.NavigationCompleted -= completed; }
        }

        private async Task<BitmapSource> LoadOnUiAsync(string path, int maximumWidth)
        {
            if (closed) return null;
            if (resetRequired)
            {
                var previous = view; view = CreateView();
                parent.Children.Remove(previous); previous.Dispose(); parent.Children.Add(view);
                ready = null; resetRequired = false;
            }
            var currentView = view;
            if (ready == null) ready = InitializeAsync();
            var initializing = ready;
            try { await UntilAsync(initializing, Task.Delay(10000), currentView); }
            catch { if (ready == initializing) resetRequired = true; throw; }
            if (closed) return null;
            if (view != currentView || resetRequired) throw new IOException("Video preview renderer stopped during initialization.");
            var id = "frame" + Guid.NewGuid().ToString("N");
            var job = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending.Add(id, job);
            var literal = JsonConvert.SerializeObject(id);
            var web = currentView.CoreWebView2;
            // One deadline covers script setup, CDP file binding, and frame extraction together.
            var deadline = Task.Delay(12000);
            try {
                await UntilAsync(web.ExecuteScriptAsync(@"(() => {
                    const id = " + literal + @", size = " + maximumWidth + @";
                    const input = document.createElement('input'); input.type = 'file'; input.id = id; input.hidden = true;
                    const video = document.createElement('video'); video.muted = true; video.preload = 'auto';
                    document.body.append(input, video);
                    let url, timer, settled = false;
                    const cleanup = () => {
                        clearTimeout(timer); video.onloadeddata = video.onerror = null;
                        video.pause(); video.removeAttribute('src'); video.load(); input.remove(); video.remove();
                        if (url) URL.revokeObjectURL(url); delete window[id];
                    };
                    const finish = (data, error) => {
                        if (settled) return; settled = true; cleanup();
                        window.chrome.webview.postMessage({ id, data, error });
                    };
                    window[id] = { cleanup, start() {
                        const file = input.files[0];
                        if (!file || file.size < 1 || file.size > 128 * 1024 * 1024) return finish(null, 'invalid-file');
                        video.onerror = () => finish(null, 'decode-error-' + (video.error?.code || 0));
                        // loadeddata supplies a decoded frame even while this private view is not being painted.
                        video.onloadeddata = () => {
                            try {
                                if (!video.videoWidth || !video.videoHeight) throw new Error('empty-frame');
                                const scale = Math.min(1, size / Math.max(video.videoWidth, video.videoHeight));
                                const canvas = document.createElement('canvas');
                                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                                finish(canvas.toDataURL('image/png'), null);
                            } catch { finish(null, 'frame-extraction-failed'); }
                        };
                        url = URL.createObjectURL(file); video.src = url;
                    }};
                    timer = setTimeout(() => finish(null, 'decode-timeout'), 10000);
                })()"), deadline, currentView);
                var document = JObject.Parse(await UntilAsync(web.CallDevToolsProtocolMethodAsync("DOM.getDocument", "{}"), deadline, currentView));
                var node = JObject.Parse(await UntilAsync(web.CallDevToolsProtocolMethodAsync("DOM.querySelector",
                    JsonConvert.SerializeObject(new { nodeId = (int)document["root"]["nodeId"], selector = "#" + id })), deadline, currentView));
                // Native CDP binds the authorized file without exposing its path to either web page.
                await UntilAsync(web.CallDevToolsProtocolMethodAsync("DOM.setFileInputFiles",
                    JsonConvert.SerializeObject(new { nodeId = (int)node["nodeId"], files = new[] { path } })), deadline, currentView);
                await UntilAsync(web.ExecuteScriptAsync("window[" + literal + "]?.start()"), deadline, currentView);
                var data = await UntilAsync(job.Task, deadline, currentView);
                const string prefix = "data:image/png;base64,";
                if (!data.StartsWith(prefix, StringComparison.Ordinal)) throw new IOException("Invalid video preview result.");
                var bytes = Convert.FromBase64String(data.Substring(prefix.Length));
                if (bytes.Length > 8 * 1024 * 1024) throw new IOException("Video preview exceeds its size limit.");
                using (var stream = new MemoryStream(bytes)) {
                    var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad;
                    bitmap.StreamSource = stream; bitmap.EndInit();
                    if (bitmap.PixelWidth > maximumWidth || bitmap.PixelHeight > maximumWidth) throw new IOException("Invalid video preview dimensions.");
                    bitmap.Freeze(); return bitmap;
                }
            } finally {
                pending.Remove(id);
                if (!closed && view == currentView) {
                    try { await UntilAsync(web.ExecuteScriptAsync("window[" + literal + "]?.cleanup()"), Task.Delay(1000), currentView); }
                    catch { if (!closed && view == currentView) resetRequired = true; }
                }
            }
        }

        public void Dispose()
        {
            closed = true;
            foreach (var job in pending.Values) job.TrySetCanceled();
            view.Dispose();
        }
    }
}
