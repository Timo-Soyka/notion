// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Heft",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Heft",
            path: "Sources/Heft",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("PDFKit"),
                .linkedFramework("Quartz"),
                .linkedFramework("AVKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("ImageIO"),
                .linkedFramework("Vision"),
                .linkedFramework("UniformTypeIdentifiers")
            ]
        )
    ]
)
