import AppKit
import ServiceManagement
import UserNotifications

final class NativeDesktop: NSObject, UNUserNotificationCenterDelegate {
    var navigate: ((String, String) -> Void)?
    var languageChanged: (() -> Void)?
    private var intents: [[String: Any]] = []
    private var notified = Set<String>()
    private let defaults = UserDefaults.standard
    private let state = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/CodexDreamSkinStudio", isDirectory: true)
    func enqueue(_ page: String, section: String = "none", link: String? = nil) {
        if intents.count >= 8 { intents.removeFirst() }
        intents.append(["id": UUID().uuidString, "page": page, "section": section, "link": link as Any? ?? NSNull()])
    }
    static func communityLink(_ address: String) throws -> String {
        guard matches(address, "\\Adreamskin://apply\\?version=ver_[a-z0-9]{8,64}\\z") else { throw HostError.invalidMessage }
        return address
    }
    private var language: String { let value = defaults.string(forKey: "dreamskin.language") ?? "system"; return value == "english" ? "en-US" : value == "chinese" ? "zh-CN" : "system" }
    var usesChinese: Bool { language == "zh-CN" || language == "system" && (Locale.preferredLanguages.first ?? "").lowercased().hasPrefix("zh") }
    func text(_ chinese: String, _ english: String) -> String { usesChinese ? chinese : english }
    func info() -> [String: Any] {
        let login: String
        switch SMAppService.mainApp.status { case .enabled: login = "enabled"; case .requiresApproval: login = "requiresApproval"; case .notRegistered: login = "disabled"; default: login = "unavailable" }
        return ["language": language, "resolvedLanguage": language == "system" ? ((Locale.preferredLanguages.first ?? "").lowercased().hasPrefix("zh") ? "zh-CN" : "en-US") : language,
                "hostVersion": (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"), "login": login]
    }
    func execute(_ method: String, parameters: [String: Any], authorized: [String: Any], completion: @escaping ([String: Any]?, Error?) -> Void) {
        do {
            guard authorized["authorized"] as? Bool == true else { throw HostError.invalidMessage }
            switch method {
            case "desktop.get": completion(info(), nil)
            case "desktop.intents": let result = intents; intents.removeAll(); completion(["intents": result], nil)
            case "desktop.language":
                guard let value = parameters["language"] as? String, ["system", "zh-CN", "en-US"].contains(value) else { throw HostError.invalidMessage }
                defaults.set(value == "zh-CN" ? "chinese" : value == "en-US" ? "english" : "system", forKey: "dreamskin.language")
                languageChanged?()
                completion(info(), nil)
            case "desktop.login":
                guard let enabled = parameters["enabled"] as? Bool else { throw HostError.invalidMessage }
                if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                completion(info(), nil)
            case "desktop.open":
                guard let target = parameters["target"] as? String else { throw HostError.invalidMessage }
                let fixed = ["website": "https://dreamskin.cc", "gallery": "https://dreamskin.cc/gallery", "studio": "https://dreamskin.cc/studio"]
                if let address = fixed[target], let url = URL(string: address) { completion(["opened": NSWorkspace.shared.open(url)], nil) }
                else {
                    guard ["themes", "images", "state"].contains(target) else { throw HostError.invalidMessage }
                    let folder = target == "state" ? state : state.appendingPathComponent(target, isDirectory: true)
                    guard folder.standardizedFileURL == folder.resolvingSymlinksInPath(), try folder.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw HostError.invalidResource }
                    completion(["opened": NSWorkspace.shared.open(folder)], nil)
                }
            case "desktop.notifyUpdate":
                guard let channel = authorized["channel"] as? String, let version = authorized["version"] as? String,
                      matches(version, "\\A(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\z"), notified.insert(channel + ":" + version).inserted else { completion(["delivered": false], nil); return }
                let center = UNUserNotificationCenter.current(); center.delegate = self
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    guard granted, error == nil else { DispatchQueue.main.async { completion(["delivered": false], nil) }; return }
                    let content = UNMutableNotificationContent(); content.title = "Dream Skin"; content.body = self.text("有新版本：", "Update available: ") + version
                    center.add(UNNotificationRequest(identifier: "dreamskin." + channel + "." + version, content: content, trigger: nil)) { error in
                        DispatchQueue.main.async { completion(["delivered": error == nil], nil) }
                    }
                }
            default: throw HostError.invalidMessage
            }
        } catch { completion(nil, error) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { [weak self] in self?.navigate?("settings", "updates"); completionHandler() }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }
}
