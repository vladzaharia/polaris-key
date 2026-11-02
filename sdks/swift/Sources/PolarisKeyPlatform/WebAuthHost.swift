// The system browser sheet of a native redirect sign-in, on the Godot binary entry (I-48.17).
// `ASWebAuthenticationSession` shown on the key window; the redirect comes back to the app as an event.
//
// Ops (the input is UTF-8 JSON of at most 4 KiB; the reply is one status byte: 1 ok, 0 nothing to do,
// 3 bad input, 5 not available on this platform, 6 the sheet could not be shown, 7 a session is already open):
//
//   auth_open    {"url","callback_scheme","prefers_ephemeral","issuer_host"}   show the sheet
//   auth_cancel                                                              close it; no event follows
//
// Events (kind, UTF-8 JSON payload): auth_done {"url"} · auth_fail {"reason":"cancelled"|"failed"}.
// `cancelled` is the person closing the sheet; the caller may open the page again.
//
// What this refuses before anything is shown: a URL that is not https, has userinfo, a fragment or a
// non-default port, or whose host is not `issuer_host`; a callback scheme that is malformed or one the web
// owns. What it hands back: only a URL whose scheme is the registered one. One session at a time.
// The callback URL carries a one-time code; it is passed on in the event and nowhere else (no log).

import Foundation

#if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
    import AuthenticationServices
#endif
#if os(macOS)
    import AppKit
#elseif os(iOS) || os(visionOS)
    import UIKit
#endif

/// How a sheet ended.
public enum WebAuthEnd: Sendable, Equatable {
    case callback(String)
    case cancelled
    case failed
}

/// `ASWebAuthenticationSession` behind a seam (a stub in tests: `swift test` has no window).
public protocol WebAuthPresenting: Sendable {
    /// Show the sheet. False when it could not be shown (`completion` is then never called). `completion`
    /// is called once, on any thread, unless `cancel()` was called first.
    func present(
        url: URL, callbackScheme: String, ephemeral: Bool, completion: @escaping @Sendable (WebAuthEnd) -> Void
    ) -> Bool
    func cancel()
}

public final class WebAuthHost: @unchecked Sendable {
    public static let maxControlBytes = 4096
    public static let maxCallbackBytes = 4096
    static let reservedSchemes: Set<String> = ["http", "https", "javascript", "data", "file"]

    static let ok: UInt8 = 1
    static let none: UInt8 = 0
    static let badInput: UInt8 = 3
    static let unavailable: UInt8 = 5
    static let failed: UInt8 = 6
    static let busy: UInt8 = 7

    private let sink: PlatformEventSink
    private let presenter: any WebAuthPresenting
    private let lock = NSLock()
    private var generation = 0
    private var open = false

    public init(sink: PlatformEventSink, presenter: any WebAuthPresenting = SystemWebAuthPresenter()) {
        self.sink = sink
        self.presenter = presenter
    }

    public func register(into ops: inout [String: PlatformBinaryOp]) {
        ops["auth_open"] = { [self] in authOpen($0) }
        ops["auth_cancel"] = { [self] _ in authCancel() }
    }

    // MARK: Checks

    /// The authorize URL: https, the issuer's host, no userinfo, no fragment, the default port.
    static func checkedURL(_ text: String, issuerHost: String) -> URL? {
        guard text.utf8.count <= maxControlBytes, let parts = URLComponents(string: text),
            parts.scheme?.lowercased() == "https", parts.user == nil, parts.password == nil,
            parts.fragment == nil, parts.port == nil || parts.port == 443,
            let host = parts.host?.lowercased(), !host.isEmpty, host == issuerHost,
            !text.unicodeScalars.contains(where: {
                $0.properties.isWhitespace || $0 == "\\" || $0.value < 0x20 || $0.value == 0x7f
            }),
            let url = parts.url
        else { return nil }
        return url
    }

    static func checkedHost(_ text: String) -> String? {
        let host = text.lowercased()
        guard !host.isEmpty, host.utf8.count <= 253,
            host.utf8.allSatisfy({
                ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2e || $0 == 0x2d
            })
        else { return nil }
        return host
    }

    static func checkedScheme(_ text: String) -> String? {
        guard !text.isEmpty, text.utf8.count <= 64, text == text.lowercased(),
            let first = text.unicodeScalars.first, first.value >= 0x61, first.value <= 0x7a,
            text.utf8.allSatisfy({
                ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2b || $0 == 0x2e || $0 == 0x2d
            }), !reservedSchemes.contains(text)
        else { return nil }
        return text
    }

    /// A callback is passed on only when it is at the registered scheme.
    static func acceptsCallback(_ text: String, scheme: String) -> Bool {
        text.utf8.count <= maxCallbackBytes && URLComponents(string: text)?.scheme?.lowercased() == scheme
    }

    // MARK: Ops

    private func authOpen(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        guard input.count <= Self.maxControlBytes,
            let o = try? JSONSerialization.jsonObject(with: Data(input)) as? [String: Any],
            let host = (o["issuer_host"] as? String).flatMap(Self.checkedHost),
            let url = (o["url"] as? String).flatMap({ Self.checkedURL($0, issuerHost: host) }),
            let scheme = (o["callback_scheme"] as? String).flatMap(Self.checkedScheme)
        else { return [Self.badInput] }
        let ephemeral = (o["prefers_ephemeral"] as? Bool) ?? false
        let mine: Int = lock.withLock {
            if open { return -1 }
            open = true
            generation += 1
            return generation
        }
        if mine < 0 { return [Self.busy] }
        let started = presenter.present(url: url, callbackScheme: scheme, ephemeral: ephemeral) { [self] end in
            finish(mine, end, scheme: scheme)
        }
        if !started {
            lock.withLock { if generation == mine { open = false } }
            return [Self.failed]
        }
        return [Self.ok]
    }

    private func authCancel() -> [UInt8] {
        let was: Bool = lock.withLock {
            let w = open
            open = false
            generation += 1
            return w
        }
        if was { presenter.cancel() }
        return [was ? Self.ok : Self.none]
    }

    private func finish(_ mine: Int, _ end: WebAuthEnd, scheme: String) {
        let current: Bool = lock.withLock {
            guard generation == mine, open else { return false }
            open = false
            return true
        }
        guard current else { return }
        switch end {
        case .callback(let url) where Self.acceptsCallback(url, scheme: scheme):
            emit("auth_done", ["url": url])
        case .cancelled:
            emit("auth_fail", ["reason": "cancelled"])
        default:
            emit("auth_fail", ["reason": "failed"])
        }
    }

    private func emit(_ kind: String, _ payload: [String: String]) {
        guard let d = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        sink.emitBinary(kind, [UInt8](d))
    }
}

#if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))

    /// The real sheet, on the main thread, anchored to the key window.
    public final class SystemWebAuthPresenter: WebAuthPresenting, @unchecked Sendable {
        private let lock = NSLock()
        private nonisolated(unsafe) var holder: Holder?

        public init() {}

        @MainActor private final class Holder: NSObject, ASWebAuthenticationPresentationContextProviding {
            var session: ASWebAuthenticationSession?
            let anchor: ASPresentationAnchor
            init(anchor: ASPresentationAnchor) { self.anchor = anchor }
            func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
        }

        public func present(
            url: URL, callbackScheme: String, ephemeral: Bool, completion: @escaping @Sendable (WebAuthEnd) -> Void
        ) -> Bool {
            let work: @MainActor () -> Bool = { [self] in
                let holder = Holder(anchor: Self.keyAnchor())
                let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) {
                    callback, error in
                    if let callback {
                        completion(.callback(callback.absoluteString))
                    } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                        completion(.cancelled)
                    } else {
                        completion(.failed)
                    }
                }
                session.presentationContextProvider = holder
                session.prefersEphemeralWebBrowserSession = ephemeral
                holder.session = session
                lock.withLock { self.holder = holder }
                guard session.start() else {
                    lock.withLock { self.holder = nil }
                    return false
                }
                return true
            }
            if Thread.isMainThread { return MainActor.assumeIsolated(work) }
            return DispatchQueue.main.sync { MainActor.assumeIsolated(work) }
        }

        public func cancel() {
            let taken: Holder? = lock.withLock {
                defer { holder = nil }
                return holder
            }
            guard let holder = taken else { return }
            let work: @MainActor () -> Void = { holder.session?.cancel() }
            if Thread.isMainThread {
                MainActor.assumeIsolated(work)
            } else {
                DispatchQueue.main.async { MainActor.assumeIsolated(work) }
            }
        }

        @MainActor private static func keyAnchor() -> ASPresentationAnchor {
            #if os(macOS)
                return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
            #else
                let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) { return window }
                if let scene = scenes.first { return ASPresentationAnchor(windowScene: scene) }
                return ASPresentationAnchor()
            #endif
        }
    }

#else

    /// No AuthenticationServices on this platform: the sheet cannot be shown.
    public struct SystemWebAuthPresenter: WebAuthPresenting {
        public init() {}
        public func present(
            url: URL, callbackScheme: String, ephemeral: Bool, completion: @escaping @Sendable (WebAuthEnd) -> Void
        ) -> Bool { false }
        public func cancel() {}
    }

#endif
