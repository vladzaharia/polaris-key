import PolarisKeyCore

extension PacksClient: UpdateContentSource {
    public func installReleases(_ targets: [PackTarget]) async throws -> Bool {
        try await ensureReleases(targets).contains { $0.activation == "restart" }
    }

    public func bootPackLists() async throws -> (required: [String], essential: [String]) {
        try await bootOptions()
    }

    public func bootFetchStage(send: @escaping @Sendable (BootEvent) -> Void) async throws
        -> (result: BootEvent.FetchResult, installed: [String])
    {
        let answer = try await bootFetch(send: send)
        return (answer.result, answer.installed)
    }
}
