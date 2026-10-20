import AVFoundation
import CoreMedia
import CoreVideo
import ExpoModulesCore

/**
 Turns BGRA frames drawn by the app into an H.264 MP4 with AVAssetWriter.
 Frames are added one at a time, so a slow phone only takes longer; it never
 drops frames. No audio track. Same JS API as the Android module.
 */
public class KineSyncVideoEncoderModule: Module {
  private var session: VideoSession?

  public func definition() -> ModuleDefinition {
    Name("KineSyncVideoEncoder")

    Function("start") { (path: String, width: Int, height: Int, fps: Int, bitRate: Int) throws in
      self.session?.cancel()
      self.session = nil
      self.session = try VideoSession(path: path, width: width, height: height, fps: fps, bitRate: bitRate)
    }

    Function("addFrame") { (pixels: Uint8Array) throws in
      guard let session = self.session else { throw VideoEncoderError("No video is being made.") }
      do {
        try session.addFrame(pixels.rawPointer, byteLength: pixels.byteLength)
      } catch {
        session.cancel()
        self.session = nil
        throw error
      }
    }

    Function("finish") { () throws -> String in
      guard let session = self.session else { throw VideoEncoderError("No video is being made.") }
      self.session = nil
      try session.finish()
      return session.path
    }

    Function("cancel") {
      self.session?.cancel()
      self.session = nil
    }

    OnDestroy {
      self.session?.cancel()
      self.session = nil
    }
  }
}

struct VideoEncoderError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private final class VideoSession {
  let path: String
  private let width: Int
  private let height: Int
  private let fps: Int32
  private let writer: AVAssetWriter
  private let input: AVAssetWriterInput
  private let adaptor: AVAssetWriterInputPixelBufferAdaptor
  private var frames: Int64 = 0
  private var done = false

  init(path: String, width: Int, height: Int, fps: Int, bitRate: Int) throws {
    self.path = path
    self.width = width
    self.height = height
    self.fps = Int32(fps)
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.removeItem(at: url)
    writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitRate,
        AVVideoMaxKeyFrameIntervalKey: fps,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      ],
    ])
    input.expectsMediaDataInRealTime = false
    adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
    ])
    guard writer.canAdd(input) else { throw VideoEncoderError("This phone could not start a video encoder.") }
    writer.add(input)
    guard writer.startWriting() else {
      throw VideoEncoderError("This phone could not start a video encoder: \(writer.error?.localizedDescription ?? "unknown error")")
    }
    writer.startSession(atSourceTime: .zero)
  }

  func addFrame(_ bytes: UnsafeMutableRawPointer, byteLength: Int) throws {
    let rowBytes = width * 4
    guard byteLength >= rowBytes * height else { throw VideoEncoderError("Frame is \(byteLength) bytes, expected \(rowBytes * height).") }
    // The writer takes frames as fast as it can encode them; wait for room.
    var waited = 0
    while !input.isReadyForMoreMediaData {
      if writer.status == .failed { throw VideoEncoderError("The video encoder stopped: \(writer.error?.localizedDescription ?? "unknown error")") }
      if waited > 5000 { throw VideoEncoderError("The video encoder did not take a frame.") }
      usleep(1000)
      waited += 1
    }
    guard let pool = adaptor.pixelBufferPool else { throw VideoEncoderError("No frame buffer from the video encoder.") }
    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let pixelBuffer = buffer else {
      throw VideoEncoderError("No frame buffer from the video encoder.")
    }
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    if let base = CVPixelBufferGetBaseAddress(pixelBuffer) {
      // Frames arrive as BGRA rows; the buffer may pad each row.
      let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
      for row in 0..<height {
        memcpy(base.advanced(by: row * stride), bytes.advanced(by: row * rowBytes), rowBytes)
      }
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
    guard adaptor.append(pixelBuffer, withPresentationTime: CMTime(value: frames, timescale: fps)) else {
      throw VideoEncoderError("The video encoder stopped: \(writer.error?.localizedDescription ?? "unknown error")")
    }
    frames += 1
  }

  func finish() throws {
    guard frames > 0 else {
      cancel()
      throw VideoEncoderError("No frames were added.")
    }
    done = true
    input.markAsFinished()
    let finished = DispatchSemaphore(value: 0)
    writer.endSession(atSourceTime: CMTime(value: frames, timescale: fps))
    writer.finishWriting { finished.signal() }
    if finished.wait(timeout: .now() + 60) == .timedOut {
      writer.cancelWriting()
      throw VideoEncoderError("The video could not be finished.")
    }
    guard writer.status == .completed else {
      throw VideoEncoderError("The video could not be finished: \(writer.error?.localizedDescription ?? "unknown error")")
    }
  }

  func cancel() {
    if done { return }
    done = true
    if writer.status == .writing { writer.cancelWriting() }
    try? FileManager.default.removeItem(atPath: path)
  }
}
