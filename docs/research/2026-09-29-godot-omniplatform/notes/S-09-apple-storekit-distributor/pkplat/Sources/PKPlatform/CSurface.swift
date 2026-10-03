import Foundation
import os

// The C-callable surface: JSON in, JSON out, one event callback. Every host (Godot GDExtension,
// Unity, MAUI, Tauri) binds these three functions and nothing else.
//
//   char *pkp_call(const char *json);         // sync result, or {"ok":true,"req":N} + a later event
//   void  pkp_free(char *);
//   void  pkp_set_event_callback(void (*)(const char *json));

private let reqCounter = OSAllocatedUnfairLock(initialState: 0)

private func nextReq() -> Int { reqCounter.withLock { $0 += 1; return $0 } }

@_cdecl("pkp_set_event_callback")
public func pkp_set_event_callback(_ cb: PKEventCallback?) {
    EventSink.shared.set(cb)
}

@_cdecl("pkp_free")
public func pkp_free(_ p: UnsafeMutablePointer<CChar>?) { free(p) }

@_cdecl("pkp_call")
public func pkp_call(_ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar> {
    let out = encodeJSON(handle(String(cString: json)))
    return strdup(out)!
}

/// Run `work` off the calling thread and deliver its result as an event tagged with `req`.
/// `work` is `@Sendable` and returns a Sendable `JSONObject`, so nothing non-Sendable crosses.
private func async(_ op: String, _ work: @escaping @Sendable () async -> JSONObject) -> JSONObject {
    let req = nextReq()
    Task.detached {
        var o = await work()
        o["ev"] = .string(op)
        o["req"] = .int(req)
        EventSink.shared.emit(o)
    }
    return ["ok": true, "req": .int(req)]
}

func handle(_ s: String) -> JSONObject {
    guard let q = decodeJSON(s), case .string(let op)? = q["op"] else { return ["ok": false, "error": "bad json"] }
    func str(_ k: String) -> String? { if case .string(let v)? = q[k] { return v }; return nil }
    func dbl(_ k: String, _ d: Double) -> Double {
        switch q[k] { case .double(let v)?: return v; case .int(let v)?: return Double(v); default: return d }
    }
    let onMain = Thread.isMainThread

    switch op {
    case "ping":
        return ["ok": true, "main_thread": .bool(onMain)]
    case "distributor":
        let d = dbl("deadline", 2)
        return async(op) { await readDistributor(deadline: d) }
    case "eligibility_region":
        let d = dbl("deadline", 2)
        return async(op) { await readEligibilityRegion(deadline: d) }
    case "app_transaction":
        let refresh = q["refresh"] == .bool(true)
        return async(op) { await readAppTransaction(refresh: refresh) }
    case "products":
        guard case .array(let a)? = q["ids"] else { return ["ok": false, "error": "ids"] }
        let ids = a.compactMap { v -> String? in if case .string(let s) = v { return s }; return nil }
        return async(op) {
            do { var o = try await StoreService.shared.load(ids); o["ok"] = true; return o } catch {
                return ["ok": false, "error": .string("\(error)")]
            }
        }
    case "purchase":
        guard let pid = str("product") else { return ["ok": false, "error": "product"] }
        let token = str("appAccountToken").flatMap(UUID.init(uuidString:))
        // Hop to the main actor explicitly. If the host calls on the main thread (Godot does),
        // the hop is one run-loop turn; a synchronous MainActor.assumeIsolated would also work
        // there but traps on any other thread.
        return async(op) { await purchase(productID: pid, appAccountToken: token) }
    case "entitlements":
        return async(op) { var o = await StoreService.shared.entitlements(); o["ok"] = true; return o }
    case "listen":
        return async(op) { await StoreService.shared.startListener(); return ["ok": true] }
    case "finish":
        guard let id = str("id").flatMap(UInt64.init) else { return ["ok": false, "error": "id"] }
        return async(op) { ["ok": .bool(await StoreService.shared.finish(id))] }
    case "kc_set":
        return SecureStore.set(
            service: str("service") ?? "pkey:probe", account: str("account") ?? "token", value: str("value") ?? "",
            accessible: str("accessible") ?? "afterFirstUnlock", group: str("group"))
    case "kc_get":
        return SecureStore.get(service: str("service") ?? "pkey:probe", account: str("account") ?? "token", group: str("group"))
    case "kc_delete":
        return SecureStore.delete(service: str("service") ?? "pkey:probe", account: str("account") ?? "token", group: str("group"))
    default:
        return ["ok": false, "error": .string("unknown op \(op)")]
    }
}
