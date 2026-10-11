// Optional content-pack integration for the update client. This seam keeps the launch decision
// path independent of the packs engine and its zstd decoder.

public protocol UpdateContentSource: AnyObject, Sendable {
    var configured: Bool { get }
    func contentInput() async throws -> UpdateCheckContent?
    func noteFeedDeltas(_ deltas: FeedDeltas?)
    func recordRevocations(_ revocations: UpdateCheckRevocations) async throws
    func installReleases(_ targets: [PackTarget]) async throws -> Bool
    func bootPackLists() async throws -> (required: [String], essential: [String])
    func bootFetchStage(send: @escaping @Sendable (BootEvent) -> Void) async throws
        -> (result: BootEvent.FetchResult, installed: [String])
}
