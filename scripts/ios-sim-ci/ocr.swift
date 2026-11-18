import Foundation
import Vision
import AppKit

func fail(_ stage: String, _ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data("ocr \(stage): \(message)\n".utf8))
  exit(code)
}

guard CommandLine.arguments.count == 2 else {
  fail("arguments", "usage: ocr screenshot.png", code: 2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url) else {
  fail("read", "cannot read screenshot: \(url.path)", code: 3)
}
var rect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
  fail("decode", "cannot decode screenshot: \(url.path)", code: 4)
}
let request = VNRecognizeTextRequest()
// Vision's accurate mode can require a Neural Engine unavailable in macOS VMs.
request.recognitionLevel = .fast
request.usesLanguageCorrection = true
do {
  try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
  let details = error as NSError
  let system = ProcessInfo.processInfo.operatingSystemVersionString
  fail("vision", "fast recognition revision \(request.revision) on \(system), screenshot \(cgImage.width)x\(cgImage.height): \(details.domain) (\(details.code)): \(String(reflecting: error))", code: 5)
}
let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
do {
  let data = try JSONSerialization.data(withJSONObject: ["lines": lines], options: [])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
  fail("encode", "cannot encode recognized lines: \(String(reflecting: error))", code: 6)
}
