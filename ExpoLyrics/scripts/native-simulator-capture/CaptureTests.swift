// CI-only native screen capture. Never redraw, rotate, resize, or re-encode a capture.
import XCTest

final class CaptureTests: XCTestCase {
    func testCaptureMailbox() throws {
        let files = FileManager.default
        let environment = ProcessInfo.processInfo.environment
        NSLog("KINESYNC_CAPTURE body entered pid=%d home=%@ caches=%@", ProcessInfo.processInfo.processIdentifier,
              NSHomeDirectory(), files.urls(for: .cachesDirectory, in: .userDomainMask)[0].path)
        NSLog("KINESYNC_CAPTURE HOME=%@ CFFIXED_USER_HOME=%@", environment["HOME"] ?? "<unset>",
              environment["CFFIXED_USER_HOME"] ?? "<unset>")
        guard let mailbox = environment["KINESYNC_CAPTURE_MAILBOX"], mailbox.hasPrefix("/"),
              let session = environment["KINESYNC_CAPTURE_SESSION"], UUID(uuidString: session) != nil else {
            XCTFail("Missing explicit native capture transport configuration"); return
        }
        let root = URL(fileURLWithPath: mailbox, isDirectory: true)
        NSLog("KINESYNC_CAPTURE mailbox=%@ session=%@", mailbox, session)
        try files.createDirectory(at: root, withIntermediateDirectories: true)
        func write(_ value: [String: Any], _ name: String) throws {
            try JSONSerialization.data(withJSONObject: value).write(to: root.appendingPathComponent(name), options: .atomic)
        }
        try write(["session": session, "mailbox": mailbox, "home": NSHomeDirectory(),
                   "pid": ProcessInfo.processInfo.processIdentifier], "ready.json")
        NSLog("KINESYNC_CAPTURE ready published")
        let deadline = Date().addingTimeInterval(40 * 60)
        while Date() < deadline {
            let requestURL = root.appendingPathComponent("request.json")
            if files.fileExists(atPath: requestURL.path) {
                let request = try JSONSerialization.jsonObject(with: Data(contentsOf: requestURL)) as! [String: String]
                try files.removeItem(at: requestURL)
                guard request["session"] == session, let id = request["id"],
                      UUID(uuidString: id) != nil, request["run"] != nil,
                      request["stage"] != nil, request["token"] != nil else {
                    XCTFail("Invalid native capture ownership"); return
                }
                let app = XCUIApplication(bundleIdentifier: "dev.kineticron.KineSync")
                let window = app.windows.firstMatch
                let frame = window.frame
                let deviceOrientation = XCUIDevice.shared.orientation
                let landscape = deviceOrientation == .landscapeLeft || deviceOrientation == .landscapeRight
                var response = request
                response["observedUDID"] = environment["SIMULATOR_UDID"] ?? ""
                response["bundle"] = "dev.kineticron.KineSync"
                response["foreground"] = app.state == .runningForeground ? "true" : "false"
                response["deviceOrientation"] = landscape ? "landscape" : deviceOrientation == .portrait ? "portrait" : "unknown"
                response["windowWidth"] = String(Double(frame.width))
                response["windowHeight"] = String(Double(frame.height))
                response["captureSource"] = request["orientation"] == "landscape" ? "XCUIWindow" : "XCUIScreen"
                if request["phase"] == "before" {
                    // Preserve physical-screen output as diagnostics; never transform it.
                    let screenScreenshot = XCUIScreen.main.screenshot()
                    if request["orientation"] == "landscape" {
                        try screenScreenshot.pngRepresentation.write(to: root.appendingPathComponent("\(id)-xctest.png"), options: .atomic)
                    }
                    // Public XCTest window capture, not an app redraw or host pixel conversion.
                    let screenshot = request["orientation"] == "landscape" ? window.screenshot() : screenScreenshot
                    try screenshot.pngRepresentation.write(to: root.appendingPathComponent("\(id).png"), options: .atomic)
                }
                try write(response, "\(id).json")
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        XCTFail("Native capture owner outlived the host run")
    }
}
