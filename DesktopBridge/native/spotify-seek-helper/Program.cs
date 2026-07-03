using Windows.Foundation;
using Windows.Media.Control;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

// Sized for Expo fullscreen album art (~520pt max) at ~1.2x density without oversized payloads.
const uint ArtworkMaxEdgePixels = 640;
const float ArtworkJpegQuality = 0.82f;

static int Fail(string message)
{
    Console.Error.WriteLine(message);
    return 1;
}

static async Task<GlobalSystemMediaTransportControlsSession?> GetPreferredSessionAsync()
{
    GlobalSystemMediaTransportControlsSessionManager manager;
    try
    {
        manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Failed to get media session manager: {ex.Message}");
        return null;
    }

    var spotifySessions = manager.GetSessions()
        .Where(s =>
            s.SourceAppUserModelId.Contains("spotify", StringComparison.OrdinalIgnoreCase))
        .ToList();

    if (spotifySessions.Count > 0)
    {
        var playingSession = spotifySessions.FirstOrDefault(session =>
        {
            var info = session.GetPlaybackInfo();
            return info.PlaybackStatus
                == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        });
        return playingSession ?? spotifySessions[0];
    }

    return manager.GetCurrentSession();
}

static async Task<int> RunSeekAsync(long targetMs)
{
    var session = await GetPreferredSessionAsync();
    if (session is null)
    {
        return Fail("No media session available.");
    }

    var playbackInfo = session.GetPlaybackInfo();
    if (!playbackInfo.Controls.IsPlaybackPositionEnabled)
    {
        return Fail("Seek is not enabled for current media session.");
    }

    var targetTicks = TimeSpan.FromMilliseconds(targetMs).Ticks;

    bool seekOk;
    try
    {
        seekOk = await session.TryChangePlaybackPositionAsync(targetTicks);
    }
    catch (Exception ex)
    {
        return Fail($"Seek call failed: {ex.Message}");
    }

    if (!seekOk)
    {
        return Fail("Session rejected seek operation.");
    }

    Console.WriteLine("ok");
    return 0;
}

static async Task<int> RunDiagnoseAsync()
{
    GlobalSystemMediaTransportControlsSessionManager manager;
    try
    {
        manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
    }
    catch (Exception ex)
    {
        return Fail($"Failed to get media session manager: {ex.Message}");
    }

    var sessions = manager.GetSessions().ToList();
    if (sessions.Count == 0)
    {
        Console.WriteLine("[]");
        return 0;
    }

    Console.WriteLine("[");
    for (var i = 0; i < sessions.Count; i++)
    {
        var session = sessions[i];
        var info = session.GetPlaybackInfo();
        var timeline = session.GetTimelineProperties();
        GlobalSystemMediaTransportControlsSessionMediaProperties? mediaProps = null;
        try
        {
            mediaProps = await session.TryGetMediaPropertiesAsync();
        }
        catch
        {
            // Title is optional for diagnostics.
        }

        var entry = System.Text.Json.JsonSerializer.Serialize(new
        {
            aumid = session.SourceAppUserModelId,
            title = mediaProps?.Title ?? "",
            artist = mediaProps?.Artist ?? "",
            seekEnabled = info.Controls.IsPlaybackPositionEnabled,
            playbackStatus = info.PlaybackStatus.ToString(),
            positionMs = (long)Math.Max(0, timeline.Position.TotalMilliseconds),
            durationMs = (long)Math.Max(
                0,
                (timeline.EndTime - timeline.StartTime).TotalMilliseconds),
            isPreferredSpotify = session.SourceAppUserModelId
                .Contains("spotify", StringComparison.OrdinalIgnoreCase),
        });
        var suffix = i < sessions.Count - 1 ? "," : "";
        Console.WriteLine($"  {entry}{suffix}");
    }
    Console.WriteLine("]");
    return 0;
}

static async Task<int> RunArtworkAsync()
{
    var session = await GetPreferredSessionAsync();
    if (session is null)
    {
        return Fail("No media session available.");
    }

    GlobalSystemMediaTransportControlsSessionMediaProperties mediaProps;
    try
    {
        mediaProps = await session.TryGetMediaPropertiesAsync();
    }
    catch (Exception ex)
    {
        return Fail($"Failed to get media properties: {ex.Message}");
    }

    var thumbnail = mediaProps?.Thumbnail;
    if (thumbnail is null)
    {
        Console.WriteLine(string.Empty);
        return 0;
    }

    try
    {
        using var stream = await thumbnail.OpenReadAsync();
        if (stream.Size == 0)
        {
            Console.WriteLine(string.Empty);
            return 0;
        }

        var optimizedBytes = await TryEncodeOptimizedJpegAsync(stream);
        if (optimizedBytes is null || optimizedBytes.Length == 0)
        {
            // Fallback: use original bytes when resize/encode fails.
            optimizedBytes = await ReadAllBytesAsync(stream);
        }

        if (optimizedBytes.Length == 0)
        {
            Console.WriteLine(string.Empty);
            return 0;
        }

        var contentType = DetectImageMimeType(optimizedBytes);
        var dataUri = $"data:{contentType};base64,{Convert.ToBase64String(optimizedBytes)}";
        Console.WriteLine(dataUri);
        return 0;
    }
    catch (Exception ex)
    {
        return Fail($"Failed to read thumbnail: {ex.Message}");
    }
}

static async Task<byte[]> ReadAllBytesAsync(IRandomAccessStream stream)
{
    stream.Seek(0);
    using var input = stream.GetInputStreamAt(0);
    using var reader = new DataReader(input);
    var loaded = await reader.LoadAsync((uint)stream.Size);
    if (loaded == 0)
    {
        return Array.Empty<byte>();
    }
    var bytes = new byte[loaded];
    reader.ReadBytes(bytes);
    return bytes;
}

static async Task<byte[]?> TryEncodeOptimizedJpegAsync(IRandomAccessStream sourceStream)
{
    sourceStream.Seek(0);
    var decoder = await BitmapDecoder.CreateAsync(sourceStream);
    var srcWidth = Math.Max(1u, decoder.PixelWidth);
    var srcHeight = Math.Max(1u, decoder.PixelHeight);
    var scale = Math.Min(
        1.0,
        Math.Min(
            (double)ArtworkMaxEdgePixels / srcWidth,
            (double)ArtworkMaxEdgePixels / srcHeight));
    var targetWidth = Math.Max(1u, (uint)Math.Round(srcWidth * scale));
    var targetHeight = Math.Max(1u, (uint)Math.Round(srcHeight * scale));

    var pixelProvider = await decoder.GetPixelDataAsync(
        BitmapPixelFormat.Bgra8,
        BitmapAlphaMode.Premultiplied,
        new BitmapTransform
        {
            ScaledWidth = targetWidth,
            ScaledHeight = targetHeight,
            InterpolationMode = BitmapInterpolationMode.Fant
        },
        ExifOrientationMode.RespectExifOrientation,
        ColorManagementMode.DoNotColorManage);

    var encodingOptions = new BitmapPropertySet();
    encodingOptions.Add(
        "ImageQuality",
        new BitmapTypedValue(ArtworkJpegQuality, PropertyType.Single));

    using var output = new InMemoryRandomAccessStream();
    var encoder = await BitmapEncoder.CreateAsync(
        BitmapEncoder.JpegEncoderId,
        output,
        encodingOptions);
    encoder.SetPixelData(
        BitmapPixelFormat.Bgra8,
        BitmapAlphaMode.Premultiplied,
        targetWidth,
        targetHeight,
        decoder.DpiX,
        decoder.DpiY,
        pixelProvider.DetachPixelData());
    await encoder.FlushAsync();

    output.Seek(0);
    using var outputReader = new DataReader(output.GetInputStreamAt(0));
    var written = await outputReader.LoadAsync((uint)output.Size);
    if (written == 0)
    {
        return null;
    }
    var encoded = new byte[written];
    outputReader.ReadBytes(encoded);
    return encoded;
}

static string DetectImageMimeType(byte[] bytes)
{
    if (bytes.Length >= 8 &&
        bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47 &&
        bytes[4] == 0x0D && bytes[5] == 0x0A && bytes[6] == 0x1A && bytes[7] == 0x0A)
    {
        return "image/png";
    }
    if (bytes.Length >= 3 &&
        bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF)
    {
        return "image/jpeg";
    }
    if (bytes.Length >= 6 &&
        bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 &&
        bytes[3] == 0x38 && (bytes[4] == 0x37 || bytes[4] == 0x39) && bytes[5] == 0x61)
    {
        return "image/gif";
    }
    if (bytes.Length >= 12 &&
        bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 &&
        bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50)
    {
        return "image/webp";
    }
    return "image/jpeg";
}

if (args.Length == 1 && double.TryParse(args[0], out var legacyTargetMsDouble))
{
    var targetMs = Math.Max(0, (long)Math.Floor(legacyTargetMsDouble));
    return await RunSeekAsync(targetMs);
}

if (args.Length == 0)
{
    return Fail("Usage: spotify-seek-helper <targetPositionMs> | seek <targetPositionMs> | artwork | diagnose");
}

var command = args[0].Trim().ToLowerInvariant();
if (command == "seek")
{
    if (args.Length < 2 || !double.TryParse(args[1], out var targetMsDouble))
    {
        return Fail("Usage: spotify-seek-helper seek <targetPositionMs>");
    }
    var targetMs = Math.Max(0, (long)Math.Floor(targetMsDouble));
    return await RunSeekAsync(targetMs);
}

if (command == "artwork")
{
    return await RunArtworkAsync();
}

if (command == "diagnose")
{
    return await RunDiagnoseAsync();
}

return Fail($"Unsupported command '{args[0]}'.");
