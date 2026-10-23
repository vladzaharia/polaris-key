// Fixture for tools/api-check.test.ts (rule 1, Swift).
public struct FixtureClient {
    public func get(key: String) -> String { key }
    public func getConfig(key: String) -> String { key }
    public nonisolated func helper() {}
    public func extra() async {}
    public var status: String { "ok" }
    public let kind = "x"
    func internalByDefault() {}
    internal func explicitInternal() {}
    private func secret() {}
    fileprivate var hidden = 1
    public func _underscore() {}
    public init() {}
    public func withBody() {
        func nested() {}
        nested()
    }
}

public struct Other {
    public func notScanned() {}
}
