// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MiuKbMac",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "MiuKbMac",
            path: "Sources/MiuKbMac"
        )
    ]
)
