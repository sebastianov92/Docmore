// swift-tools-version: 6.0
import PackageDescription

// MeetingKit: the meeting engine of the Docmore macOS app.
// Record (microphone + system audio) -> transcribe on the device (WhisperKit)
// -> queue the transcript for the Docmore server.
let package = Package(
    name: "MeetingKit",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "MeetingKit", targets: ["MeetingKit"]),
        .executable(name: "meetingkit", targets: ["MeetingKitCLI"]),
    ],
    dependencies: [
        // Same version the app pins in mac/project.yml.
        .package(url: "https://github.com/argmaxinc/WhisperKit", exact: "1.1.1"),
    ],
    targets: [
        .target(
            name: "MeetingKit",
            dependencies: [
                "MeetingKitObjC",
                .product(name: "WhisperKit", package: "WhisperKit"),
            ],
            path: "Sources/MeetingKit"
        ),
        // One function: run a block and turn an NSException into an NSError.
        .target(
            name: "MeetingKitObjC",
            path: "Sources/MeetingKitObjC"
        ),
        // The file system is case-insensitive, so the target cannot be named
        // "meetingkit" next to "MeetingKit"; the product (the binary) is.
        .executableTarget(
            name: "MeetingKitCLI",
            dependencies: ["MeetingKit"],
            path: "Sources/MeetingKitCLI"
        ),
        .testTarget(
            name: "MeetingKitTests",
            dependencies: ["MeetingKit"],
            path: "Tests/MeetingKitTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
