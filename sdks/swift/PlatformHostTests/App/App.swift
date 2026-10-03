// The host app for PKPlatformHostTests: an empty SwiftUI app. Its only job is to exist with
// `get-task-allow` (App/Host.entitlements) so storekitd treats the bundle as a development
// install and StoreKit Testing loads products. It links PolarisKeyPlatform, never StoreKitTest.
import PolarisKeyPlatform
import SwiftUI

@main
struct PKPlatformHostApp: App {
    var body: some Scene {
        WindowGroup { Text("PolarisKeyPlatform test host (protocol \(PlatformHost.protocolVersion))") }
    }
}
