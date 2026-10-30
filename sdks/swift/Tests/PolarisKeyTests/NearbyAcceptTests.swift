// @pkey-feature identity.nearby
// CC-15.S2: the approver's accept gate on a real loopback socket (WIRE-CONTRACT-V5 §15.6.1 rule 2): the same
// listener and address rule as mode a, with the approver's pool, and a session whose transport is up keeps its
// socket past the 30 s pre-auth clock while it waits for the person's pick.

import Foundation
import PolarisKeyPlatform
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

#if canImport(Network)
    import Network

    final class NearbyAcceptTests: XCTestCase {
        private func listener(preAuth: TimeInterval) -> BonjourListener {
            BonjourListener(
                limiter: UnauthenticatedLimiter.approver(), policy: BonjourDialPolicy(allowLoopback: true),
                preAuthSeconds: preAuth)
        }

        private func dial(_ port: UInt16) async throws -> NWPipe {
            try await BonjourPipes.dial(
                .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!),
                options: BonjourDialOptions(policy: BonjourDialPolicy(allowLoopback: true), timeout: 5))
        }

        func testAnEstablishedSocketOutlivesThePreAuthClockAndAnUnestablishedOneDoesNot() async throws {
            let l = listener(preAuth: 0.4)
            let served = NBox<[NWPipe]>([])
            let port = try await l.start(
                advert: BonjourAdvert(instance: "p1-aaaaaaaaaaaaaaaa", txt: ["v=1", "m=v", "h=0123456789abcdef"]),
                onPipe: { pipe in served.mutate { $0.append(pipe) } })
            defer { l.stop() }
            let c1 = try await dial(port)
            let c2 = try await dial(port)
            // The listener allows one waiting socket per source address; both come from 127.0.0.1, so the
            // second is refused at accept and closed with no read.
            try await Task.sleep(nanoseconds: 150_000_000)
            XCTAssertEqual(served.value.count, 1)
            let kept = try XCTUnwrap(served.value.first)
            kept.markEstablished()
            try await Task.sleep(nanoseconds: 700_000_000)
            // Past the pre-auth clock: the established socket is still ours.
            do {
                try await kept.write(Data("x".utf8))
            } catch { XCTFail("an established socket was closed by the pre-auth clock: \(error)") }
            await c1.close()
            await c2.close()
        }

        private final class SpyNet: NearbyApproverNetwork, @unchecked Sendable {
            let inner = SystemNearbyApproverNetwork(allowLoopback: true)
            let handles = NBox<[SystemNearbyApproverNetwork.Handle]>([])
            func open(
                instance: String, txt: [String], onPipe: @escaping @Sendable (any NearbyInboundPipe) -> Void
            ) async throws -> any NearbyAdvertHandle {
                let h = try await inner.open(instance: instance, txt: txt, onPipe: onPipe)
                handles.mutate { $0.append(h as! SystemNearbyApproverNetwork.Handle) }
                return h
            }
        }

        /// The whole approver over real loopback sockets: the system network, the real listener and a bare D.
        func testTheApproverOverRealLoopbackSocketsRunsAVouchToApproved() async throws {
            let approvals = NBox<[NearbyApproval]>([])
            let net = SpyNet()
            let approver = try await NearbyApprover.start(
                source: NearbyApproverSource(slug: nearbySlug, signedIn: { true }, nearbyServed: { true }),
                handler: { a in approvals.mutate { $0.append(a) } },
                options: NearbyApproverOptions(prompt: true, label: "Ana's Mac", platform: "macos"), network: net)
            let port = try XCTUnwrap(net.handles.value.first).port
            let pipe = try await dial(port)
            let d = try await RawD.over(LanPipe(pipe: pipe), label: "Ben's Switch")
            await nearbyUntil("hello") { d.hello != nil }
            XCTAssertEqual(d.hello?.label, "Ana's Mac")
            await d.startSas()
            await nearbyUntil("prompt") { approvals.value.count == 1 }
            let a = approvals.value[0]
            async let picked = a.pick(PeerSAS.display(d.code!))
            try await d.showAndRequest()
            guard case .request(let req) = try await picked else { return XCTFail("no request") }
            let keys = try await d.keys.ensure()
            XCTAssertEqual(req.signKey, keys.signKey)
            let out = try await a.finish(
                VouchApproveAnswer(http: 200, body: #"{"status":"approved","deviceLabel":null}"#, discoveryNearby: true)
            )
            XCTAssertEqual(out, .sent(.approved))
            await nearbyUntil("result") { d.records.count == 1 }
            XCTAssertEqual(PeerVouch.parseResult(d.records[0].body), .status(.approved))
            await approver.stop()
            await nearbyUntil("closed") { d.closed != nil }
        }

        /// D's system network resolves a host and port advert, races its addresses and dials: the approver on
        /// the other side of a real loopback socket sees a session and lists D's HELLO.
        func testTheRequestersSystemNetworkResolvesAndDialsARealListener() async throws {
            let approvals = NBox<[NearbyApproval]>([])
            let spy = SpyNet()
            let approver = try await NearbyApprover.start(
                source: NearbyApproverSource(slug: nearbySlug, signedIn: { true }, nearbyServed: { true }),
                handler: { a in approvals.mutate { $0.append(a) } },
                options: NearbyApproverOptions(prompt: true, label: "Ana's Mac", platform: "macos"), network: spy)
            let port = try XCTUnwrap(spy.handles.value.first).port
            let net = SystemNearbyRequesterNetwork(allowLoopback: true)
            let ad = NearbyAdvert(
                instance: "p1-cccccccccccccccc", txt: ["v=1", "m=v"],
                endpoint: BonjourEndpoint(
                    name: "p1-cccccccccccccccc",
                    network: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)))
            let targets = try await net.resolve(ad)
            XCTAssertEqual(targets.count, 1)
            let pipe = try await nearbyDialRace(targets, timer: nearbySystemTimer) { try await net.dial($0) }
            let d = try await RawD.over(pipe, label: "Ben's Switch")
            await nearbyUntil("hello") { d.hello != nil }
            XCTAssertEqual(d.hello?.label, "Ana's Mac")
            await d.startSas()
            await nearbyUntil("prompt") { approvals.value.count == 1 }
            XCTAssertEqual(approvals.value[0].label, "Ben's Switch")
            await approver.stop()
        }

        func testAnUnestablishedSocketIsClosedWhenThePreAuthClockRuns() async throws {
            let l = listener(preAuth: 0.3)
            let served = NBox<[NWPipe]>([])
            let port = try await l.start(onPipe: { pipe in served.mutate { $0.append(pipe) } })
            defer { l.stop() }
            let c = try await dial(port)
            try await Task.sleep(nanoseconds: 100_000_000)
            let pipe = try XCTUnwrap(served.value.first)
            try await Task.sleep(nanoseconds: 600_000_000)
            do {
                try await pipe.write(Data("x".utf8))
                XCTFail("an unestablished socket survived the pre-auth clock")
            } catch {}
            await c.close()
        }
    }
#endif
