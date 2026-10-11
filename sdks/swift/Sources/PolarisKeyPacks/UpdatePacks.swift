import PolarisKeyUpdate

extension UpdateClient {
    /// The optional packs facet. A client configured with `UpdateClientOptions(content:)` returns
    /// that exact `PacksClient`; otherwise this is an unconfigured facet and pack operations name
    /// `not-configured` as before.
    public nonisolated var packs: PacksClient {
        if let packs = content as? PacksClient { return packs }
        return PacksClient(core: core, releaseKeys: [:])
    }
}
