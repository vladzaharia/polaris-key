// The Swift live-peer driver's entry: read JSON lines from stdin, answer on stdout (see Wire.swift).

import Foundation

let driver = Driver()
do {
    try await driver.start()
} catch {
    log("the driver could not start: \(error)")
    exit(1)
}
send(["ready": true, "driver": "swift"])

func answer(_ m: JSON) async {
    let seq: Any = m["seq"] ?? NSNull()
    func reply(_ ok: Bool, _ body: JSON) { send(["seq": seq, "ok": ok].merging(body) { $1 }) }
    do {
        switch string(m, "cmd") {
        case "show": reply(true, try await driver.show(m))
        case "join": reply(true, try await driver.join(m))
        case "list": reply(true, try await driver.list())
        case "open": reply(true, try await driver.open(m))
        case "send": reply(true, try await driver.sendBytes(m))
        case "recv": reply(true, await driver.recv())
        case "forget": reply(true, try await driver.forget(m))
        case "events": reply(true, driver.events())
        case "quit":
            reply(true, [:])
            await driver.shutdown()
            exit(0)
        default: reply(false, ["error": errorJSON(message: "unknown command \(string(m, "cmd") ?? "")")])
        }
    } catch {
        let r = error as? Refusal
        reply(false, (r?.extra ?? [:]).merging(["error": Driver.errorOf(error)]) { $1 })
    }
}

// stdin is read on its own thread: a blocking read must not hold the executor the commands run on.
await Task.detached {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: data)) as? JSON
        else {
            continue
        }
        switch string(m, "mdns") {
        case "up":
            if let a = m["advert"] as? JSON, let i = string(a, "instance"), let p = a["port"] as? Int,
                let t = a["txt"] as? [String]
            {
                driver.broker.remoteUp(instance: i, port: UInt16(p), txt: t)
            }
        case "down":
            if let i = string(m, "instance") { driver.broker.remoteDown(i) }
        default:
            Task { await answer(m) }
        }
    }
}.value
await driver.shutdown()
exit(0)
