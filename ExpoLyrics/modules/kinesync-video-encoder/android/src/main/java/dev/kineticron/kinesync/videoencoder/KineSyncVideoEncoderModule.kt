package dev.kineticron.kinesync.videoencoder

import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array
import java.io.File

/**
 * Turns RGBA frames drawn by the app into an H.264 MP4 with Android's own
 * encoder (MediaCodec) and muxer. Frames are added one at a time, so a
 * slow phone only takes longer; it never drops frames. No audio track.
 */
class KineSyncVideoEncoderModule : Module() {
  private var session: Session? = null

  override fun definition() = ModuleDefinition {
    Name("KineSyncVideoEncoder")

    Function("start") { path: String, width: Int, height: Int, fps: Int, bitRate: Int ->
      session?.release(deleteFile = true)
      session = null
      val started = try {
        Session(path, width, height, fps, bitRate)
      } catch (error: Exception) {
        throw CodedException("ERR_ENCODER_START", "This phone could not start a video encoder: ${error.message}", error)
      }
      session = started
    }

    Function("addFrame") { pixels: Uint8Array ->
      val current = session ?: throw CodedException("ERR_NOT_STARTED", "No video is being made.", null)
      try {
        current.addFrame(pixels)
      } catch (error: Exception) {
        current.release(deleteFile = true)
        session = null
        throw CodedException("ERR_ENCODER_FRAME", "The video encoder stopped: ${error.message}", error)
      }
    }

    Function("finish") {
      val current = session ?: throw CodedException("ERR_NOT_STARTED", "No video is being made.", null)
      session = null
      try {
        current.finish()
      } catch (error: Exception) {
        current.release(deleteFile = true)
        throw CodedException("ERR_ENCODER_FINISH", "The video could not be finished: ${error.message}", error)
      }
      current.path
    }

    Function("cancel") {
      session?.release(deleteFile = true)
      session = null
    }

    OnDestroy {
      session?.release(deleteFile = true)
      session = null
    }
  }
}

private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
private const val TIMEOUT_US = 10_000L

private class Session(val path: String, private val width: Int, private val height: Int, private val fps: Int, bitRate: Int) {
  private val codec = MediaCodec.createEncoderByType(MIME)
  private val muxer: MediaMuxer
  private val info = MediaCodec.BufferInfo()
  private val rgba = ByteArray(width * height * 4)
  private var track = -1
  private var muxing = false
  private var frames = 0L
  private var released = false

  init {
    val format = MediaFormat.createVideoFormat(MIME, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
      setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    codec.start()
    val file = File(path)
    file.parentFile?.mkdirs()
    file.delete()
    muxer = MediaMuxer(path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
  }

  private fun presentationUs(frame: Long) = frame * 1_000_000L / fps

  fun addFrame(pixels: Uint8Array) {
    val size = width * height * 4
    require(pixels.byteLength >= size) { "Frame is ${pixels.byteLength} bytes, expected $size." }
    pixels.read(rgba, 0, size)
    val index = nextInputBuffer()
    val image = codec.getInputImage(index) ?: error("No input image from the encoder.")
    writeYuv(image)
    codec.queueInputBuffer(index, 0, width * height * 3 / 2, presentationUs(frames), 0)
    frames += 1
    drain(endOfStream = false)
  }

  fun finish() {
    check(frames > 0) { "No frames were added." }
    val index = nextInputBuffer()
    codec.queueInputBuffer(index, 0, 0, presentationUs(frames), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
    drain(endOfStream = true)
    release(deleteFile = false)
  }

  private fun nextInputBuffer(): Int {
    repeat(500) {
      val index = codec.dequeueInputBuffer(TIMEOUT_US)
      if (index >= 0) return index
      drain(endOfStream = false)
    }
    error("The encoder did not take a frame.")
  }

  /** RGBA (Skia) to the encoder's YUV 4:2:0 layout, whatever its strides (BT.601, limited range). */
  private fun writeYuv(image: Image) {
    val planes = image.planes
    val yPlane = planes[0]
    val uPlane = planes[1]
    val vPlane = planes[2]
    val yBuffer = yPlane.buffer
    val uBuffer = uPlane.buffer
    val vBuffer = vPlane.buffer
    for (y in 0 until height) {
      val row = y * width * 4
      val yRow = y * yPlane.rowStride
      val chroma = y % 2 == 0
      val uRow = (y / 2) * uPlane.rowStride
      val vRow = (y / 2) * vPlane.rowStride
      for (x in 0 until width) {
        val p = row + x * 4
        val r = rgba[p].toInt() and 0xFF
        val g = rgba[p + 1].toInt() and 0xFF
        val b = rgba[p + 2].toInt() and 0xFF
        yBuffer.put(yRow + x * yPlane.pixelStride, (((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).toByte())
        if (chroma && x % 2 == 0) {
          uBuffer.put(uRow + (x / 2) * uPlane.pixelStride, (((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128).toByte())
          vBuffer.put(vRow + (x / 2) * vPlane.pixelStride, (((112 * r - 94 * g - 18 * b + 128) shr 8) + 128).toByte())
        }
      }
    }
  }

  private fun drain(endOfStream: Boolean) {
    var idle = 0
    while (true) {
      val index = codec.dequeueOutputBuffer(info, if (endOfStream) TIMEOUT_US else 0L)
      when {
        index == MediaCodec.INFO_TRY_AGAIN_LATER -> {
          if (!endOfStream) return
          idle += 1
          if (idle > 300) error("The encoder did not finish.")
        }
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          check(!muxing) { "The video format changed twice." }
          track = muxer.addTrack(codec.outputFormat)
          muxer.start()
          muxing = true
        }
        index >= 0 -> {
          val buffer = codec.getOutputBuffer(index) ?: error("No output from the encoder.")
          if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
          if (info.size > 0 && muxing) {
            buffer.position(info.offset)
            buffer.limit(info.offset + info.size)
            muxer.writeSampleData(track, buffer, info)
          }
          codec.releaseOutputBuffer(index, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
        }
      }
    }
  }

  fun release(deleteFile: Boolean) {
    if (released) return
    released = true
    try { codec.stop() } catch (_: Exception) {}
    try { codec.release() } catch (_: Exception) {}
    try { if (muxing) muxer.stop() } catch (_: Exception) {}
    try { muxer.release() } catch (_: Exception) {}
    if (deleteFile) File(path).delete()
  }
}
