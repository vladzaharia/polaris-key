// @pkey-feature core.errors
// Linux only (FoundationNetworking): a real localhost redirect, no URLProtocol stub. Server A
// answers 302 to server B; B records every request it sees. The bearer must never reach B, and a
// call that opted out of redirects (`followRedirects: false`) must not reach B at all. The macOS
// tests prove the same policy through a stub; this proves the Linux path against real sockets.

#if os(Linux)
    import Foundation
    import XCTest

    #if canImport(FoundationNetworking)
        import FoundationNetworking
    #endif
    import Glibc

    @testable import PolarisKeyCore

    /// A one-shot-per-connection HTTP/1.1 server on 127.0.0.1, an ephemeral port.
    private final class LocalServer: @unchecked Sendable {
        private let lock = NSLock()
        private var heads: [String] = []
        private let fd: Int32
        let port: Int
        private let respond: @Sendable (String) -> String

        init(respond: @escaping @Sendable (String) -> String) throws {
            self.respond = respond
            let s = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
            guard s >= 0 else { throw NSError(domain: "socket", code: Int(errno)) }
            var yes: Int32 = 1
            setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = 0
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bound == 0, listen(s, 8) == 0 else { throw NSError(domain: "bind", code: Int(errno)) }
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) }
            }
            self.fd = s
            self.port = Int(UInt16(bigEndian: addr.sin_port))
            Thread.detachNewThread { [self] in serve() }
        }

        var requests: [String] {
            lock.lock()
            defer { lock.unlock() }
            return heads
        }

        func stop() { shutdown(fd, Int32(SHUT_RDWR)); close(fd) }

        private func serve() {
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { return }
                var buf = [UInt8](repeating: 0, count: 8192)
                let n = read(c, &buf, buf.count)
                if n > 0 {
                    let head = String(decoding: buf[0..<n], as: UTF8.self)
                    lock.lock()
                    heads.append(head)
                    lock.unlock()
                    let out = Array(respond(head).utf8)
                    _ = write(c, out, out.count)
                }
                close(c)
            }
        }
    }

    private func reply(_ status: String, location: String? = nil, body: String = "") -> String {
        "HTTP/1.1 \(status)\r\n" + (location.map { "Location: \($0)\r\n" } ?? "")
            + "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
    }

    final class LinuxRedirectTests: XCTestCase {
        private func run(follow: Bool) async throws -> (target: LocalServer, outcome: String) {
            let target = try LocalServer { _ in reply("200 OK", body: "ok") }
            let targetURL = "http://127.0.0.1:\(target.port)/steal"
            let origin = try LocalServer { _ in reply("302 Found", location: targetURL) }
            defer { origin.stop() }
            let transport = URLSessionTransport(session: URLSessionTransport.makeSession())
            var outcome = "error"
            do {
                let res = try await transport.send(
                    PolarisRequest(
                        url: URL(string: "http://127.0.0.1:\(origin.port)/a")!, method: "GET",
                        headers: ["Authorization": "Bearer test-token-not-a-secret"],
                        timeoutSeconds: 10, followRedirects: follow))
                outcome = "status \(res.status)"
            } catch {}
            XCTAssertFalse(origin.requests.isEmpty, "the origin was never reached")
            return (target, outcome)
        }

        func testRedirectedCallNeverHandsTheBearerToTheOtherPort() async throws {
            let (target, _) = try await run(follow: true)
            defer { target.stop() }
            for head in target.requests {
                XCTAssertFalse(head.lowercased().contains("authorization:"), "bearer reached the redirect target")
            }
        }

        func testNoFollowCallDoesNotReachTheOtherPort() async throws {
            let (target, outcome) = try await run(follow: false)
            defer { target.stop() }
            XCTAssertTrue(target.requests.isEmpty, "a no-follow call was redirected (\(outcome))")
        }
    }
#endif
