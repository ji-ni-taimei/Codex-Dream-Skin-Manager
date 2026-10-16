// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DreamSkinSharedHost",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "DreamSkinSharedHost", targets: ["DreamSkinSharedHost"])],
    targets: [.executableTarget(name: "DreamSkinSharedHost")]
)
