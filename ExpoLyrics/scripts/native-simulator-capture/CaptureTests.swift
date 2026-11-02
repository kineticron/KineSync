// CI-only native screen capture. Never redraw, rotate, resize, or re-encode a capture.
import XCTest

final class CaptureTests: XCTestCase {
    func testCaptureMailbox() throws {
        let files = FileManager.default
        let root = files.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("kinesync-capture", isDirectory: true)
        try files.createDirectory(at: root, withIntermediateDirectories: true)
        let session = UUID().uuidString
        func write(_ value: [String: Any], _ name: String) throws {
            try JSONSerialization.data(withJSONObject: value).write(to: root.appendingPathComponent(name), options: .atomic)
        }
        try write(["session": session], "ready.json")
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
                // pngRepresentation is produced by XCTest's native screenshot API.
                // A portrait result for a landscape request is rejected by the host.
                let screenshot = XCUIScreen.main.screenshot()
                try screenshot.pngRepresentation.write(to: root.appendingPathComponent("\(id).png"), options: .atomic)
                try write(request, "\(id).json")
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        XCTFail("Native capture owner outlived the host run")
    }
}
