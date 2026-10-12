import PolarisKey
import PolarisKeyUI
import PolarisKeyUpdate
import SwiftUI

@main
struct SizeApp: App {
    @State private var client: PolarisKeyClient? = try? PolarisKeyClient(
        options: PolarisKeyClientOptions(
            productSlug: "size", version: "1.0.0", pinnedKeys: [:],
            pinnedReleaseKeys: [:]))
    var body: some Scene {
        WindowGroup {
            if let client {
                Text("Hello").polarisKey(client)
                    .task { _ = try? await client.update.decide() }
            }
        }
    }
}
