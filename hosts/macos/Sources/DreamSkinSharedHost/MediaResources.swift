import AppKit
import AVFoundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import WebKit

struct MediaRegistration {
    let fileName: String, digest: String, expiry: Date, width: Int
}
final class MediaResources: NSObject, WKURLSchemeHandler {
    private let directory: URL
    private var resources: [String: MediaRegistration] = [:]
    private var active = Set<ObjectIdentifier>()
    private let decoding = DispatchQueue(label: "dreamskin.manager.preview", qos: .userInitiated)
    private let dates = ISO8601DateFormatter()
    init(directory: URL) {
        self.directory = directory; super.init()
        dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }
    func register(_ message: [String: Any], session: String?) throws {
        guard let session, message["backendSessionId"] as? String == session,
              let id = message["resourceId"] as? String, matches(id, "\\A[a-f0-9]{48}\\z"),
              let file = message["fileName"] as? String, matches(file, "\\A" + id + "\\.(jpg|jpeg|png|apng|webp|gif|mp4|heic|heif|tif|tiff)\\z"),
              let digest = message["sha256"] as? String, matches(digest, "\\A[a-f0-9]{64}\\z"),
              let timestamp = message["expiresAt"] as? String, let expiry = dates.date(from: timestamp),
              expiry > Date(), expiry < Date().addingTimeInterval(360),
              let variant = message["variant"] as? String, ["thumbnail", "preview"].contains(variant) else { throw HostError.invalidMessage }
        resources = resources.filter { $0.value.expiry > Date() }
        guard resources.count < 64 else { throw HostError.invalidResource }
        resources[id] = MediaRegistration(fileName: file, digest: digest, expiry: expiry, width: variant == "thumbnail" ? 400 : 1200)
    }
    func clear() { resources.removeAll(); active.removeAll() }
    func release(_ message: [String: Any], session: String?) throws {
        guard let session, message["backendSessionId"] as? String == session,
              let id = message["resourceId"] as? String, matches(id, "\\A[a-f0-9]{48}\\z") else { throw HostError.invalidMessage }
        resources.removeValue(forKey: id)
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url, urlSchemeTask.request.httpMethod == "GET",
              url.scheme == "dreamskin-media", url.host == "resource", url.query == nil, url.fragment == nil,
              matches(url.path, "\\A/[a-f0-9]{48}\\z"),
              let registration = resources[String(url.path.dropFirst())], registration.expiry > Date() else {
            urlSchemeTask.didFailWithError(HostError.invalidResource); return
        }
        // Hold the inode before accepting asynchronous work. Core may unlink its
        // cache path during eviction; a queued/video decode still needs a path.
        let source = directory.appendingPathComponent(registration.fileName)
        let retained = directory.appendingPathComponent(".decode-" + UUID().uuidString).appendingPathExtension(source.pathExtension)
        do {
            try safeFile(source, within: directory)
            try FileManager.default.linkItem(at: source, to: retained)
            try safeFile(retained, within: directory)
        } catch {
            if (try? safeFile(retained, within: directory)) != nil { try? FileManager.default.removeItem(at: retained) }
            urlSchemeTask.didFailWithError(HostError.invalidResource); return
        }
        let snapshot = MediaRegistration(fileName: retained.lastPathComponent, digest: registration.digest, expiry: registration.expiry, width: registration.width)
        active.insert(taskID)
        decoding.async { [self] in
            let result = Result { () throws -> Data in
                defer { try? FileManager.default.removeItem(at: retained) }
                return try render(snapshot)
            }
            DispatchQueue.main.async { [self] in
                guard active.remove(taskID) != nil else { return }
                switch result {
                case .success(let bytes):
                    guard registration.expiry > Date(), let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": "image/png", "Content-Length": String(bytes.count), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"]) else { urlSchemeTask.didFailWithError(HostError.invalidResource); return }
                    urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(bytes); urlSchemeTask.didFinish()
                case .failure: urlSchemeTask.didFailWithError(HostError.invalidResource)
                }
            }
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { active.remove(ObjectIdentifier(urlSchemeTask)) }
    private func render(_ registration: MediaRegistration) throws -> Data {
        let file = directory.appendingPathComponent(registration.fileName)
        try safeFile(file, within: directory)
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        let size = try handle.seekToEnd()
        guard size > 0, size <= 128 * 1024 * 1024 else { throw HostError.invalidResource }
        try handle.seek(toOffset: 0)
        guard let bytes = try handle.read(upToCount: Int(size)), bytes.count == Int(size),
              SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == registration.digest else { throw HostError.invalidResource }
        try safeFile(file, within: directory)
        let image: CGImage
        if file.pathExtension == "mp4" {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: CGFloat(registration.width), height: CGFloat(registration.width))
            image = try generator.copyCGImage(at: .zero, actualTime: nil)
            // Check again after the path-based video decoder. Changed bytes never reach the page.
            let check = try FileHandle(forReadingFrom: file); defer { try? check.close() }
            guard try check.seekToEnd() == size else { throw HostError.invalidResource }
            try check.seek(toOffset: 0)
            guard try check.read(upToCount: Int(size)) == bytes else { throw HostError.invalidResource }
        } else {
            guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: registration.width] as CFDictionary) else { throw HostError.invalidResource }
            image = thumbnail
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { throw HostError.invalidResource }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw HostError.invalidResource }
        return output as Data
    }
}
