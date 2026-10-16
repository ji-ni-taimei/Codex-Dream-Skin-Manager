using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Win32;
using Newtonsoft.Json.Linq;

namespace DreamSkin.SharedHost
{
    internal sealed class NativeFiles
    {
        private readonly NativeBackend backend;
        private readonly Window owner;
        private readonly string directory;
        private readonly Action<JObject> post;
        private readonly NativeDesktop desktop;
        private readonly Dictionary<string, TaskCompletionSource<JObject>> pending = new Dictionary<string, TaskCompletionSource<JObject>>();
        private readonly HashSet<string> requests = new HashSet<string>();
        private readonly Queue<string> recentRequests = new Queue<string>();
        private bool busy, closed;
        internal NativeFiles(NativeBackend backend, Window owner, string directory, Action<JObject> post, NativeDesktop desktop)
        { this.backend = backend; this.owner = owner; this.directory = directory; this.post = post; this.desktop = desktop; }
        internal bool Receive(JObject value)
        {
            if ((string)value["kind"] != "native.response") return false;
            var id = (string)value["requestId"];
            if (id != null && pending.TryGetValue(id, out var waiter)) { pending.Remove(id); waiter.TrySetResult(value); }
            return true; // A private response can never fall through to the web page.
        }
        private async Task<JObject> Request(string method, JObject parameters)
        {
            if (closed) throw new IOException();
            var id = "native:" + Guid.NewGuid().ToString("N");
            var waiter = new TaskCompletionSource<JObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending.Add(id, waiter);
            try {
                await backend.SendNative(new JObject { ["protocol"] = NativeBackend.Protocol, ["kind"] = "native.request", ["requestId"] = id, ["method"] = method, ["params"] = parameters });
                if (await Task.WhenAny(waiter.Task, Task.Delay(1200000)) != waiter.Task) throw new IOException();
                var response = await waiter.Task;
                if (closed) throw new IOException();
                if ((bool?)response["ok"] != true) throw new NativeActionError(response["error"] as JObject);
                return response["result"] as JObject ?? throw new IOException();
            } finally { pending.Remove(id); }
        }
        internal async Task<bool> Handle(JObject request)
        {
            var method = (string)request["method"];
            if (method != "files.select" && method != "files.saveOriginal" && method != "files.playOriginal" && method != "files.selectPackages" && method != "files.exportPackage" && method != "updates.openRelease" && method != "updates.quit" && !new HashSet<string> { "desktop.get", "desktop.open", "desktop.language", "desktop.login", "desktop.intents", "desktop.notifyUpdate" }.Contains(method)) return false;
            var id = (string)request["requestId"];
            try {
                if (closed || (string)request["protocol"] != NativeBackend.Protocol || (string)request["kind"] != "request" ||
                    !Regex.IsMatch(id ?? "", "\\A(?!native:)[A-Za-z0-9:_-]{1,128}\\z") || !(request["params"] is JObject parameters) || request.Count != 5) throw new IOException();
                if (!requests.Add(id)) throw new NativeActionError(Error("INVALID_REQUEST", "Repeated native request."));
                recentRequests.Enqueue(id);
                if (recentRequests.Count > 1024) requests.Remove(recentRequests.Dequeue());
                if (busy) throw new NativeActionError(Error("BUSY", "A native file action is already open."));
                busy = true;
                try {
                    JObject result;
                    if (method.StartsWith("desktop.", StringComparison.Ordinal)) {
                        var authorized = await Request("desktop.authorize", new JObject { ["method"] = method, ["parameters"] = parameters.DeepClone() });
                        result = desktop.Execute(method, parameters, authorized);
                    } else if (method == "updates.openRelease" || method == "updates.quit") {
                        var quit = method == "updates.quit";
                        var parameter = quit ? "operationId" : "handle";
                        if (parameters.Count != 1 || parameters[parameter]?.Type != JTokenType.String) throw new IOException();
                        var authorized = await Request(quit ? "updates.authorizeQuit" : "updates.authorizeOpen", parameters);
                        if (quit) {
                            if (authorized["quit"]?.Type != JTokenType.Boolean || (bool)authorized["quit"] != true) throw new IOException();
                            result = new JObject { ["quitting"] = true };
                            owner.Dispatcher.BeginInvoke(new Action(() => { if (!closed) owner.Close(); }));
                        } else {
                            var address = (string)authorized["url"];
                            if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host != "github.com" || !uri.IsDefaultPort ||
                                uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.AbsoluteUri != address ||
                                !Regex.IsMatch(uri.AbsolutePath, "\\A/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/tag/(gui-v|v)(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\z")) throw new IOException();
                            Process.Start(new ProcessStartInfo { FileName = address, UseShellExecute = true });
                            result = new JObject { ["opened"] = true };
                        }
                    } else if (method == "files.select" || method == "files.selectPackages") {
                        var packages = method == "files.selectPackages";
                        if (parameters.Count != 1 || parameters["multiple"]?.Type != JTokenType.Boolean) throw new IOException();
                        var dialog = new OpenFileDialog { Multiselect = (bool)parameters["multiple"], CheckFileExists = true,
                            Filter = packages ? "Dream Skin 主题包|*.cdskin" : "图片或视频|*.png;*.apng;*.jpg;*.jpeg;*.webp;*.gif;*.mp4", Title = packages ? "选择主题包" : "选择主题素材" };
                        if (dialog.ShowDialog(owner) != true) result = new JObject { ["cancelled"] = true, ["sources"] = new JArray(), ["failures"] = new JArray() };
                        else {
                            if (closed) return true;
                            if (dialog.FileNames.Length > 32) throw new NativeActionError(Error("INVALID_REQUEST", "Select at most 32 source files."));
                            result = await Request(packages ? "packages.register" : "sources.register", new JObject { ["paths"] = new JArray(dialog.FileNames) });
                        }
                    } else {
                        if (parameters.Count != 2 || !(parameters["theme"] is JObject) || parameters["revision"]?.Type != JTokenType.String) throw new IOException();
                        var packageExport = method == "files.exportPackage";
                        var descriptor = await Request(packageExport ? "packages.export" : "media.original", parameters);
                        var extension = (string)descriptor["extension"];
                        var name = (string)descriptor["fileName"];
                        if (!(packageExport ? extension == ".cdskin" : Regex.IsMatch(extension ?? "", "\\A\\.(png|apng|jpe?g|webp|gif|mp4|heic|heif|tiff?)\\z")) ||
                            !Regex.IsMatch(name ?? "", "\\A[a-f0-9]{48}" + Regex.Escape(extension) + "\\z")) throw new IOException();
                        var file = Path.Combine(directory, name); SafeFiles.Check(file, directory);
                        byte[] bytes;
                        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                            if (stream.Length < 1 || stream.Length > (packageExport ? 160L : 128L) * 1024 * 1024 || stream.Length != (long?)descriptor["byteLength"]) throw new IOException();
                            using (var hash = SHA256.Create()) if (BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant() != (string)descriptor["sha256"]) throw new IOException();
                            stream.Position = 0; bytes = new byte[(int)stream.Length]; var offset = 0;
                            while (offset < bytes.Length) { var count = stream.Read(bytes, offset, bytes.Length - offset); if (count == 0) throw new IOException(); offset += count; }
                        }
                        using (var hash = SHA256.Create()) if (BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant() != (string)descriptor["sha256"]) throw new IOException();
                        await Request("files.release", new JObject { ["fileName"] = name });
                        // Keep an independently verified local copy for the system player.
                        if (method == "files.playOriginal") {
                            var playFile = Path.Combine(directory, Guid.NewGuid().ToString("N") + extension);
                            using (var stream = new FileStream(playFile, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                            SafeFiles.Check(playFile, directory);
                            Process.Start(new ProcessStartInfo { FileName = playFile, UseShellExecute = true });
                            result = new JObject { ["opened"] = true };
                        } else {
                            var dialog = new SaveFileDialog { FileName = (packageExport ? "theme" : "original") + extension, DefaultExt = extension,
                                Filter = (packageExport ? "Dream Skin 主题包|*" : "原始素材|*") + extension, AddExtension = true, OverwritePrompt = true, Title = packageExport ? "导出主题包" : "保存原始素材" };
                            if (dialog.ShowDialog(owner) != true) result = new JObject { ["cancelled"] = true, ["saved"] = false };
                            else { if (closed) return true; Save(dialog.FileName, bytes); result = new JObject { ["cancelled"] = false, ["saved"] = true }; }
                        }
                    }
                    if (!closed) post(new JObject { ["protocol"] = NativeBackend.Protocol, ["kind"] = "response", ["requestId"] = id, ["ok"] = true, ["result"] = result });
                } finally { busy = false; }
            } catch (Exception error) {
                if (!closed) post(new JObject { ["protocol"] = NativeBackend.Protocol, ["kind"] = "response", ["requestId"] = id,
                    ["ok"] = false, ["error"] = error is NativeActionError native ? native.Detail : Error("IO_ERROR", "The native file action could not complete.") });
            }
            return true;
        }
        private static void Save(string target, byte[] bytes)
        {
            var full = Path.GetFullPath(target); var parent = Path.GetDirectoryName(full); SafeFiles.CheckDirectory(parent);
            if (File.Exists(full)) SafeFiles.Check(full, parent);
            var stage = Path.Combine(parent, ".dreamskin-save-" + Guid.NewGuid().ToString("N"));
            try {
                using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                SafeFiles.Check(stage, parent); SafeFiles.CheckDirectory(parent);
                if (File.Exists(full)) { SafeFiles.Check(full, parent); File.Replace(stage, full, null); } else File.Move(stage, full);
            } finally { if (File.Exists(stage)) File.Delete(stage); }
        }
        private static JObject Error(string code, string message) => new JObject { ["code"] = code, ["message"] = message, ["retryable"] = false };
        private sealed class NativeActionError : Exception { internal readonly JObject Detail; internal NativeActionError(JObject detail) { Detail = detail ?? Error("IO_ERROR", "Native request failed."); } }
        internal void Close() { closed = true; foreach (var waiter in pending.Values) waiter.TrySetException(new IOException()); pending.Clear(); }
    }
}
