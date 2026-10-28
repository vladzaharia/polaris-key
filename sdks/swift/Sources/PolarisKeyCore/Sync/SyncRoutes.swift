// Cloud Sync setting routes and the `user` block rules (U-07.1). A port of Python's
// `cloud_sync/routes.py`, itself a port of `packages/shared-catalog/src/cloudSync.ts`
// (`syncedSettings`, `settingRoute`, `userSettingIssues`, `mergeMembersOverLimit`). The corpus pins
// it: `sync-scenarios.json`'s `settingCases`. Entries are `JSONValue` objects, as a catalog
// document carries them. Python's `None` (absent or `null`) is "no value" here too.

import Foundation

public let userSettingSyncScopes = ["user", "platform", "local"]
public let userSettingConflicts = ["lastWrite", "max", "min", "merge"]
public let cloudSyncMaxMergeMembers = SYNC_MAX_MERGE_MEMBERS
public let cloudSyncEncryptionModes = ["e2e", "server"]

private let userBlockMembers: Set<String> = ["sync", "conflict", "listed"]

public enum SettingRouteKind: String, Sendable, Equatable {
    case synced, local, locked, refused
}

/// How the client treats one declared catalog key. A key with no route is an OPEN setting.
public struct SettingRoute: Sendable, Equatable {
    public var key: String
    public var route: SettingRouteKind
    /// Synced only.
    public var scope: SyncScope?
    public var policy: SyncPolicy?
    public var listed: Bool?
    /// The entry's `schema`, present (even as `null`) when the entry has one.
    public var schema: JSONValue?
    /// The catalog's mode, on every route when the catalog carries its `cloudSync` block.
    public var encryption: SyncEncryption?

    public init(
        key: String, route: SettingRouteKind, scope: SyncScope? = nil, policy: SyncPolicy? = nil,
        listed: Bool? = nil, schema: JSONValue? = nil, encryption: SyncEncryption? = nil
    ) {
        self.key = key
        self.route = route
        self.scope = scope
        self.policy = policy
        self.listed = listed
        self.schema = schema
        self.encryption = encryption
    }

    /// The corpus's route form.
    public var json: JSONValue {
        var o: [String: JSONValue] = ["key": .string(key), "route": .string(route.rawValue)]
        if let scope { o["scope"] = .string(scope.rawValue) }
        if let policy { o["policy"] = .string(policy.rawValue) }
        if let listed { o["listed"] = .bool(listed) }
        if let schema { o["schema"] = schema }
        if let encryption { o["encryption"] = .string(encryption.rawValue) }
        return .object(o)
    }
}

/// One problem with a `user` block. Only `severity == .error` blocks.
public struct UserSettingIssue: Sendable, Equatable {
    public enum Severity: String, Sendable { case error, warning }
    public var code: String
    public var severity: Severity
    public var at: String
    public var message: String
}

/// The value of a member that is present and not `null` (Python `dict.get(...) is not None`).
private func member(_ o: [String: JSONValue], _ key: String) -> JSONValue? {
    guard let v = o[key], v != .null else { return nil }
    return v
}

private func oneOf(_ v: JSONValue?, _ values: [String]) -> Bool {
    if case .string(let s)? = v { return values.contains(s) }
    return false
}

/// A catalog's effective mode: its declaration, else `e2e`.
public func cloudSyncEncryption(_ catalog: JSONValue) -> SyncEncryption {
    if case .object(let block)? = catalog.objectValue?["cloudSync"],
        block["encryption"] == .string("server")
    {
        return .server
    }
    return .e2e
}

/// Whether a `config` entry is Editable: no `managementDefault` locks it.
public func isEditable(_ entry: JSONValue) -> Bool {
    let d = entry.objectValue?["managementDefault"]
    return d != .string("enforced") && d != .string("hidden")
}

/// One entry's route.
public func settingRoute(_ entry: JSONValue) -> SettingRoute {
    let e = entry.objectValue ?? [:]
    let key = e["key"]?.stringValue ?? ""
    if e["kind"] != .string("config") { return SettingRoute(key: key, route: .refused) }
    if !isEditable(entry) { return SettingRoute(key: key, route: .locked) }
    let user = member(e, "user")?.objectValue ?? [:]
    let sync = member(user, "sync")?.stringValue ?? "user"
    if sync == "local" { return SettingRoute(key: key, route: .local) }
    return SettingRoute(
        key: key, route: .synced, scope: SyncScope(rawValue: sync) ?? .user,
        policy: member(user, "conflict")?.stringValue.flatMap(SyncPolicy.init(rawValue:)) ?? .lastWrite,
        listed: member(user, "listed")?.boolValue ?? true, schema: e["schema"])
}

/// One route per declared key, in catalog order. A catalog that carries its `cloudSync` block gets
/// the mode on every route; one that hands over entries only gets the routes alone.
public func syncedSettings(_ catalog: JSONValue) -> [SettingRoute] {
    let o = catalog.objectValue ?? [:]
    let routes = (o["entries"]?.arrayValue ?? []).map(settingRoute)
    guard o["cloudSync"] != nil else { return routes }
    let mode = cloudSyncEncryption(catalog)
    return routes.map { var r = $0; r.encryption = mode; return r }
}

private func schemaTypeIn(_ schema: [String: JSONValue], _ types: [String]) -> Bool {
    switch schema["type"] {
    case .string(let t)?: return types.contains(t)
    case .array(let a)?:
        return !a.isEmpty && a.allSatisfy { if case .string(let s) = $0 { return types.contains(s) } else { return false } }
    default: return false
    }
}

/// Rule 5: a `merge` value merges at most `cloudSyncMaxMergeMembers` top-level members.
public func mergeMembersOverLimit(_ schema: [String: JSONValue]) -> Bool {
    let declared = schema["properties"]?.objectValue?.count ?? 0
    if let mx = syncNumber(schema["maxProperties"]), mx > Double(cloudSyncMaxMergeMembers) { return true }
    return declared > cloudSyncMaxMergeMembers
}

/// Every problem with `entry["user"]` (S-17 §5.3 rules 1-5 and the block's shape), or `[]`.
public func userSettingIssues(_ entry: JSONValue) -> [UserSettingIssue] {
    let e = entry.objectValue ?? [:]
    guard let userValue = e["user"] else { return [] }
    var out: [UserSettingIssue] = []
    func error(_ code: String, _ at: String, _ message: String) {
        out.append(UserSettingIssue(code: code, severity: .error, at: at, message: message))
    }
    guard case .object(let user) = userValue else {
        error(
            "invalid_user_setting", "user",
            "user must be an object with optional sync (user, platform or local), conflict and listed.")
        return out
    }
    for m in syncSortedKeys(user.keys) where !userBlockMembers.contains(m) {
        error(
            "invalid_user_setting", "user.\(m)",
            "user.\(m) is not a synced-setting member (sync, conflict, listed).")
    }
    if user["sync"] == .string("device") {
        error(
            "invalid_user_setting", "user.sync",
            "user.sync device is retired: a reinstall gets a new device id, so the value could not survive it. "
                + "Use local to keep a value on the device.")
    } else if user["sync"] != nil && !oneOf(user["sync"], userSettingSyncScopes) {
        error("invalid_user_setting", "user.sync", "user.sync must be user, platform or local.")
    }
    if let listed = user["listed"], listed.boolValue == nil {
        error("invalid_user_setting", "user.listed", "user.listed must be a boolean.")
    }
    let conflict = member(user, "conflict")
    if conflict == .string("union") {
        error(
            "user_conflict_union", "user.conflict",
            "user.conflict cannot be union; hold a set as an object of booleans with conflict: merge.")
    } else if user["conflict"] != nil && !oneOf(conflict, userSettingConflicts) {
        error("invalid_user_setting", "user.conflict", "user.conflict must be lastWrite, max, min or merge.")
    }
    if e["kind"] != .string("config") {
        error("user_setting_wrong_kind", "user", "user is only valid on config entries.")
    }
    if e["managementDefault"] == .string("enforced") || e["managementDefault"] == .string("hidden") {
        out.append(
            UserSettingIssue(
                code: "user_setting_locked_default", severity: .warning, at: "user",
                message: "user has no effect on a key whose managementDefault is enforced or hidden: "
                    + "the key is locked, so it never syncs."))
    }
    let schema = e["schema"]?.objectValue ?? [:]
    if case .string(let c)? = conflict, c == "max" || c == "min", !schemaTypeIn(schema, ["number", "integer"]) {
        error("user_conflict_type_mismatch", "user.conflict", "user.conflict \(c) needs a number schema.")
    }
    if conflict == .string("merge") {
        if !schemaTypeIn(schema, ["object"]) {
            error(
                "user_conflict_type_mismatch", "user.conflict",
                "user.conflict merge needs an object schema; a set is an object of booleans.")
        } else if mergeMembersOverLimit(schema) {
            error(
                "merge_members_over_limit", "schema",
                "A merged value has at most \(cloudSyncMaxMergeMembers) top-level members "
                    + "(maxProperties and declared properties).")
        }
    }
    return out
}
