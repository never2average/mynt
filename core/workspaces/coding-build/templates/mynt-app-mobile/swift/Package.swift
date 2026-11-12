// swift-tools-version:5.9
// The SwiftUI starter. The generated Swift SDK sits next to it in MyntSDK/ (scaffold_app.py copies it and
// fills in __MYNT_SDK_PACKAGE__ with its module name). Open this folder in Xcode to run it on iOS.
import PackageDescription

let package = Package(
    name: "MyntStarter",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.executable(name: "MyntStarter", targets: ["MyntStarter"])],
    dependencies: [.package(path: "MyntSDK")],
    targets: [
        .executableTarget(
            name: "MyntStarter",
            dependencies: [.product(name: "__MYNT_SDK_PACKAGE__", package: "MyntSDK")]
        ),
    ]
)
