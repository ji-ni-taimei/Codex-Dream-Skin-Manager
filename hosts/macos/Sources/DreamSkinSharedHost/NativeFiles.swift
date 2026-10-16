import AppKit
import CoreFoundation
import CryptoKit
import UniformTypeIdentifiers

final class NativeFiles {
    private let backend: NativeBackend, directory: URL
    private let post: ([String: Any]) -> Void
    private let desktop: NativeDesktop
    private var pending: [String: ([String: Any]) -> Void] = [:]
    private var requests = Set<String>()
    private var recentRequests: [String] = []
    private var busy = false, closed = false
    init(backend: NativeBackend, directory: URL, desktop: NativeDesktop, post: @escaping ([String: Any]) -> Void) {
        self.backend = backend; self.directory = directory; self.desktop = desktop; self.post = post
    }
    func receive(_ message: [String: Any]) -> Bool {
        guard message["kind"] as? String == "native.response" else { return false }
        if let id = message["requestId"] as? String, let callback = pending.removeValue(forKey: id) { callback(message) }
        return true
    }
    private func request(_ method: String, _ parameters: [String: Any], completion: @escaping ([String: Any]) -> Void) throws {
        guard !closed else { throw HostError.disconnected }
        let id = "native:" + UUID().uuidString.lowercased()
        pending[id] = completion
        do { try backend.sendNative(["protocol": managerProtocol, "kind": "native.request", "requestId": id, "method": method, "params": parameters]) }
        catch { pending.removeValue(forKey: id); throw error }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1200) { [weak self] in
            guard let self, let callback = self.pending.removeValue(forKey: id) else { return }
            callback(["ok": false, "error": self.error("TIMEOUT", "Native file processing timed out; no automatic retry will occur.")])
        }
    }
    private func error(_ code: String, _ text: String) -> [String: Any] { ["code": code, "message": text, "retryable": false] }
    private func reply(_ id: String, result: [String: Any]? = nil, failure: [String: Any]? = nil) {
        busy = false
        guard !closed else { return }
        var response: [String: Any] = ["protocol": managerProtocol, "kind": "response", "requestId": id, "ok": failure == nil]
        if let failure { response["error"] = failure } else { response["result"] = result ?? [:] }
        post(response)
    }
    func handle(_ message: [String: Any]) -> Bool {
        guard let method = message["method"] as? String, ["files.select", "files.saveOriginal", "files.playOriginal", "files.selectPackages", "files.exportPackage", "updates.openRelease", "updates.quit", "desktop.get", "desktop.open", "desktop.language", "desktop.login", "desktop.intents", "desktop.notifyUpdate"].contains(method) else { return false }
        guard !closed, message["protocol"] as? String == managerProtocol, message["kind"] as? String == "request",
              let id = message["requestId"] as? String, matches(id, "\\A(?!native:)[A-Za-z0-9:_-]{1,128}\\z"),
              let parameters = message["params"] as? [String: Any], Set(message.keys) == Set(["protocol", "kind", "requestId", "method", "params"]) else { return true }
        guard requests.insert(id).inserted else { postFailure(id, "INVALID_REQUEST", "Repeated native request."); return true }
        recentRequests.append(id)
        if recentRequests.count > 1024 { requests.remove(recentRequests.removeFirst()) }
        guard !busy else { postFailure(id, "BUSY", "A native file action is already open."); return true }; busy = true
        do {
            if method.hasPrefix("desktop.") {
                try request("desktop.authorize", ["method": method, "parameters": parameters]) { [weak self] response in
                    guard let self, !self.closed else { return }
                    guard response["ok"] as? Bool == true, let authorized = response["result"] as? [String: Any] else { self.reply(id, failure: response["error"] as? [String: Any] ?? self.error("IO_ERROR", "Desktop action was not authorized.")); return }
                    self.desktop.execute(method, parameters: parameters, authorized: authorized) { [weak self] result, error in
                        guard let self, !self.closed else { return }
                        if error != nil { self.reply(id, failure: self.error("IO_ERROR", "系统操作未完成，请核对系统设置或目录。")) }
                        else { self.reply(id, result: result) }
                    }
                }
            } else if method == "updates.openRelease" || method == "updates.quit" {
                let quit = method == "updates.quit", parameter = method == "updates.quit" ? "operationId" : "handle"
                guard Set(parameters.keys) == Set([parameter]), parameters[parameter] is String else { throw HostError.invalidMessage }
                try request(quit ? "updates.authorizeQuit" : "updates.authorizeOpen", parameters) { [weak self] response in
                    guard let self, !self.closed else { return }
                    guard response["ok"] as? Bool == true, let authorized = response["result"] as? [String: Any] else {
                        self.reply(id, failure: response["error"] as? [String: Any] ?? self.error("IO_ERROR", "Update action was not authorized.")); return
                    }
                    if quit {
                        guard authorized["quit"] as? Bool == true else { self.reply(id, failure: self.error("BUSY", "Update quit conditions changed.")); return }
                        self.reply(id, result: ["quitting": true])
                        DispatchQueue.main.async { [weak self] in guard let self, !self.closed else { return }; NSApp.terminate(nil) }
                    } else {
                        guard let address = authorized["url"] as? String, let url = URL(string: address), url.scheme == "https", url.host == "github.com",
                              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
                              matches(address, "\\Ahttps://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/tag/(gui-v|v)(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\z") else {
                            self.reply(id, failure: self.error("INVALID_REQUEST", "Invalid authorized release page.")); return
                        }
                        self.reply(id, result: ["opened": NSWorkspace.shared.open(url)])
                    }
                }
            } else if method == "files.select" || method == "files.selectPackages" {
                let packages = method == "files.selectPackages"
                guard Set(parameters.keys) == Set(["multiple"]), let value = parameters["multiple"] as? NSNumber,
                      CFGetTypeID(value) == CFBooleanGetTypeID() else { throw HostError.invalidMessage }
                let multiple = value.boolValue
                let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = multiple
                panel.allowedContentTypes = (packages ? ["cdskin", "zip"] : ["png", "apng", "jpg", "jpeg", "webp", "gif", "mp4", "heic", "tif", "tiff"]).compactMap { UTType(filenameExtension: $0) }
                panel.title = packages ? "选择主题包" : "选择主题素材"
                guard panel.runModal() == .OK else { reply(id, result: ["cancelled": true, "sources": [], "failures": []]); return true }
                guard !closed else { return true }
                guard panel.urls.count <= 32 else { reply(id, failure: error("INVALID_REQUEST", "Select at most 32 source files.")); return true }
                try request(packages ? "packages.register" : "sources.register", ["paths": panel.urls.map { $0.path }]) { [weak self] response in self?.finishSelection(id, response) }
            } else {
                guard Set(parameters.keys) == Set(["theme", "revision"]), parameters["theme"] is [String: Any], parameters["revision"] is String else { throw HostError.invalidMessage }
                try request(method == "files.exportPackage" ? "packages.export" : "media.original", parameters) { [weak self] response in self?.finishOriginal(id, method, response) }
            }
        } catch { reply(id, failure: self.error("IO_ERROR", "The native file action could not complete.")) }
        return true
    }
    private func postFailure(_ id: String, _ code: String, _ message: String) {
        post(["protocol": managerProtocol, "kind": "response", "requestId": id, "ok": false, "error": error(code, message)])
    }
    private func finishSelection(_ id: String, _ response: [String: Any]) {
        if response["ok"] as? Bool == true, let result = response["result"] as? [String: Any] { reply(id, result: result) }
        else { reply(id, failure: response["error"] as? [String: Any] ?? error("IO_ERROR", "Source selection failed.")) }
    }
    private func finishOriginal(_ id: String, _ method: String, _ response: [String: Any]) {
        guard response["ok"] as? Bool == true, let descriptor = response["result"] as? [String: Any] else {
            reply(id, failure: response["error"] as? [String: Any] ?? error("IO_ERROR", "Original media is unavailable.")); return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self, !self.closed else { return }
            let result = Result { () throws -> (Data, String) in
                let packageExport = method == "files.exportPackage"
                guard let ext = descriptor["extension"] as? String, (packageExport ? ext == ".cdskin" : matches(ext, "\\A\\.(png|apng|jpe?g|webp|gif|mp4|heic|heif|tiff?)\\z")),
                      let name = descriptor["fileName"] as? String, matches(name, "\\A[a-f0-9]{48}" + NSRegularExpression.escapedPattern(for: ext) + "\\z"),
                      let expected = descriptor["byteLength"] as? Int, expected > 0, expected <= (packageExport ? 160 : 128) * 1024 * 1024,
                      let hash = descriptor["sha256"] as? String else { throw HostError.invalidResource }
                let source = self.directory.appendingPathComponent(name); try safeFile(source, within: self.directory)
                guard try source.resourceValues(forKeys: [.fileSizeKey]).fileSize == expected else { throw HostError.invalidResource }
                let bytes = try Data(contentsOf: source)
                guard bytes.count == expected, SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == hash else { throw HostError.invalidResource }
                return (bytes, ext)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.closed else { return }
                do {
                    let (bytes, ext) = try result.get()
                    try self.request("files.release", ["fileName": descriptor["fileName"]!]) { _ in }
                    if method == "files.playOriginal" {
                        let file = self.directory.appendingPathComponent(UUID().uuidString + ext)
                        try bytes.write(to: file, options: .withoutOverwriting); try safeFile(file, within: self.directory)
                        guard NSWorkspace.shared.open(file) else { throw HostError.invalidResource }
                        self.reply(id, result: ["opened": true])
                    } else {
                        let panel = NSSavePanel(); panel.nameFieldStringValue = (method == "files.exportPackage" ? "theme" : "original") + ext
                        panel.allowedContentTypes = UTType(filenameExtension: String(ext.dropFirst())).map { [$0] } ?? []
                        panel.title = method == "files.exportPackage" ? "导出主题包" : "保存原始素材"
                        guard panel.runModal() == .OK, let target = panel.url else { self.reply(id, result: ["cancelled": true, "saved": false]); return }
                        guard !self.closed else { return }
                        let parent = target.deletingLastPathComponent().standardizedFileURL
                        guard parent.resolvingSymlinksInPath() == parent, try parent.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw HostError.invalidResource }
                        if FileManager.default.fileExists(atPath: target.path) { try safeFile(target, within: parent) }
                        try bytes.write(to: target, options: .atomic)
                        self.reply(id, result: ["cancelled": false, "saved": true])
                    }
                } catch { self.reply(id, failure: self.error("IO_ERROR", "Original media could not be saved or opened.")) }
            }
        }
    }
    func close() { closed = true; pending.removeAll() }
}
