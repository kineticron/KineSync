const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getDotnetExecutable } = require("./dotnetExecutable");
const { resolvePackagedNativePath } = require("./nativeRuntimePaths");

const SEEK_HELPER_PROJECT_DIR = path.join(
  __dirname,
  "..",
  "native",
  "spotify-seek-helper",
);
const SEEK_HELPER_DLL_PATH = resolvePackagedNativePath(path.join(
  SEEK_HELPER_PROJECT_DIR,
  "bin",
  "Release",
  "net9.0-windows10.0.19041.0",
  "spotify-seek-helper.dll",
));
let seekHelperBuildPromise = null;

class PlaybackProcessError extends Error {
  constructor(message, beforeDispatch) {
    super(message);
    this.beforeDispatch = beforeDispatch;
  }
}

function runPlaybackProcess(executable, args, options, timeoutMs, isPredispatchExit = () => false) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, { ...options, windowsHide: true });
    } catch (error) {
      reject(new PlaybackProcessError(error.message, true));
      return;
    }

    let stderr = "";
    let stdout = "";
    let started = false;
    let processError;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // The process can have dispatched before the timer fired. Retain the
      // serialized slot until close, even if killing it emits an error.
      try { child.kill(); } catch { /* Wait for close. */ }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("spawn", () => { started = true; });
    child.on("error", (error) => { processError = error; });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new PlaybackProcessError(
          `${executable} timed out after ${timeoutMs}ms; playback outcome unknown.`, false,
        ));
        return;
      }
      if (processError) {
        reject(new PlaybackProcessError(processError.message, !started));
        return;
      }
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const message = stderr.trim() || stdout.trim() || `${executable} exited with code ${code}`;
      reject(new PlaybackProcessError(message, isPredispatchExit(code, message)));
    });
  });
}

function runPowerShell(script, timeoutMs = 6000, useSta = false, isPredispatchExit) {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass"];
  if (useSta) args.push("-Sta");
  args.push("-Command", script);
  return runPlaybackProcess("powershell.exe", args, {}, timeoutMs, isPredispatchExit);
}

function runDotnetCommand(args, timeoutMs, isPredispatchExit) {
  // Electron's runtime helper lives outside app.asar.
  const cwd = args[0] === "build" ? SEEK_HELPER_PROJECT_DIR : path.dirname(SEEK_HELPER_DLL_PATH);
  return runPlaybackProcess(getDotnetExecutable(), args, { cwd }, timeoutMs, isPredispatchExit);
}

function ensureSeekHelperBuilt() {
  if (fs.existsSync(SEEK_HELPER_DLL_PATH)) {
    return Promise.resolve();
  }
  if (!seekHelperBuildPromise) {
    seekHelperBuildPromise = runDotnetCommand(
      ["build", "-c", "Release"],
      90_000,
    ).finally(() => {
      seekHelperBuildPromise = null;
    });
  }
  return seekHelperBuildPromise.then(() => {
    if (!fs.existsSync(SEEK_HELPER_DLL_PATH)) {
      throw new Error(
        "Seek helper build completed but output DLL was not found.",
      );
    }
  });
}

function assertIntentCurrent(expiresAtMs) {
  if (Date.now() >= expiresAtMs) throw new Error("Playback intent expired before dispatch.");
}

async function prepareBeforeIntentDeadline(expiresAtMs, prepare) {
  assertIntentCurrent(expiresAtMs);
  const controller = new AbortController();
  const expiration = new Error("Playback intent expired before dispatch.");
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(expiration);
      controller.abort(expiration);
    }, Math.max(0, expiresAtMs - Date.now()));
  });
  try {
    const result = await Promise.race([deadline, prepare(controller.signal)]);
    assertIntentCurrent(expiresAtMs);
    return result;
  } finally {
    clearTimeout(timer);
    // A lookup can settle after expiry before the deadline timer gets to run.
    if (Date.now() >= expiresAtMs) controller.abort(expiration);
  }
}

async function runNativeSeek(targetPositionMs, expiresAtMs) {
  const safeTarget = Number.isFinite(targetPositionMs)
    ? Math.max(0, Math.floor(targetPositionMs))
    : 0;
  // The shared build may finish for a future intent. Only this wait expires.
  const helperAvailable = await prepareBeforeIntentDeadline(expiresAtMs, async () => {
    try {
      await ensureSeekHelperBuilt();
      return true;
    } catch {
      return false;
    }
  });
  assertIntentCurrent(expiresAtMs);
  if (helperAvailable) {
    try {
      await runDotnetCommand(
        [SEEK_HELPER_DLL_PATH, "seek-before", String(safeTarget), String(expiresAtMs)],
        8000,
        (code, message) => code === 2 || (code === 1 && message === "Unsupported command 'seek-before'."),
      );
      return;
    } catch (error) {
      if (!error.beforeDispatch) throw error;
    }
  }

  assertIntentCurrent(expiresAtMs);
  await runPowerShell(buildLegacySeekScript(safeTarget, expiresAtMs), 8000, true, code => code === 2);
}

function buildLegacySeekScript(positionMs, expiresAtMs) {
  return `
$ErrorActionPreference = 'Stop'
$managerType = [Type]::GetType('Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows, ContentType=WindowsRuntime')
function Wait-WinRtResult($op, $timeoutMs) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ([int]$op.Status -eq 0) {
    if ($timer.ElapsedMilliseconds -ge $timeoutMs) {
      throw 'WinRT operation timeout'
    }
    Start-Sleep -Milliseconds 5
  }
  if ([int]$op.Status -ne 1) { throw "WinRT operation failed: $($op.Status)" }
  return $op.GetResults()
}

try {
  if (-not $managerType) { throw 'No media session available for seek' }
  $manager = Wait-WinRtResult ($managerType::RequestAsync()) 2500
  $spotifySessions = @($manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -like '*Spotify*' })
  $session = if ($spotifySessions.Count -gt 0) { $spotifySessions[0] } else { $manager.GetCurrentSession() }
  if (-not $session) { throw 'No media session available for seek' }
  $controls = ($session.GetPlaybackInfo()).Controls
  if (-not $controls.IsPlaybackPositionEnabled) { throw 'Seek is not enabled for current media session' }
  if (([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds() -ge ${expiresAtMs}) {
    throw 'Playback intent expired before dispatch'
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
$ok = Wait-WinRtResult ($session.TryChangePlaybackPositionAsync([Int64]${positionMs * 10000})) 3000
if (-not $ok) { throw 'Seek command rejected by session' }
exit 0
`;
}

const RESYNC_PAUSE_MS = 80;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildResyncScript() {
  return `
$ErrorActionPreference = 'Stop'
if (-not ([System.Management.Automation.PSTypeName]'MediaKey.NativeMethods').Type) {
  Add-Type -Namespace MediaKey -Name NativeMethods -MemberDefinition @'
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
}
function Send-MediaKey([byte]$vk) {
  [MediaKey.NativeMethods]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [MediaKey.NativeMethods]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}
Send-MediaKey 0xB3
Start-Sleep -Milliseconds ${RESYNC_PAUSE_MS}
Send-MediaKey 0xB3
exit 0
`;
}

function buildMediaKeyScript(action) {
  const vk =
    action === "toggle"
      ? 0xb3
      : action === "next"
        ? 0xb0
        : action === "previous"
          ? 0xb1
          : null;
  if (vk === null) {
    throw new Error(`Unsupported media key action: ${action}`);
  }
  return `
$ErrorActionPreference = 'Stop'
if (-not ([System.Management.Automation.PSTypeName]'MediaKey.NativeMethods').Type) {
  Add-Type -Namespace MediaKey -Name NativeMethods -MemberDefinition @'
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
}
[MediaKey.NativeMethods]::keybd_event([byte]${vk}, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[MediaKey.NativeMethods]::keybd_event([byte]${vk}, 0, 2, [UIntPtr]::Zero)
exit 0
`;
}

async function findSpotifySeekDevice(accessToken, signal, expiresAtMs) {
  let deviceId = "";

  try {
    const playerResponse = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (playerResponse.ok) {
      const state = await playerResponse.json();
      deviceId = String(state?.device?.id || "");
    }
  } catch {
    // Fall through to device list lookup.
  }

  // Check the clock as well as the signal in case the deadline timer is still pending.
  signal.throwIfAborted();
  assertIntentCurrent(expiresAtMs);
  if (!deviceId) {
    const devicesResponse = await fetch(
      "https://api.spotify.com/v1/me/player/devices",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      },
    );
    if (devicesResponse.ok) {
      const payload = await devicesResponse.json();
      const devices = Array.isArray(payload?.devices) ? payload.devices : [];
      const activeDevice = devices.find((device) => device?.is_active);
      const computerDevice = devices.find(
        (device) => String(device?.type || "").toLowerCase() === "computer",
      );
      const unrestrictedDevice = devices.find((device) => !device?.is_restricted);
      deviceId = String(
        activeDevice?.id || computerDevice?.id || unrestrictedDevice?.id || "",
      );
    }
  }

  return deviceId;
}

async function seekViaSpotifyApi(safeTarget, accessToken, expiresAtMs) {
  const deviceId = await prepareBeforeIntentDeadline(
    expiresAtMs, (signal) => findSpotifySeekDevice(accessToken, signal, expiresAtMs),
  );
  const query = deviceId
    ? `/seek?position_ms=${safeTarget}&device_id=${encodeURIComponent(deviceId)}`
    : `/seek?position_ms=${safeTarget}`;
  assertIntentCurrent(expiresAtMs);
  return spotifyApiRequest("PUT", query, accessToken);
}

async function spotifyApiRequest(method, endpoint, accessToken, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    };
    if (body !== null) {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(
      `https://api.spotify.com/v1/me/player${endpoint}`,
      options,
    );
    if (response.status === 204 || response.status === 200) {
      return;
    }
    if (response.status === 401) {
      throw new Error("Spotify access token expired.");
    }
    if (response.status === 403) {
      throw new Error("Spotify Premium required for playback control.");
    }
    throw new Error(`Spotify API HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

function createPlaybackController({ executeWindowsPlayback } = {}) {
  let getSpotifyAccessToken = null;
  const requestedProvider = String(
    process.env.MEDIA_SESSION_PROVIDER || process.platform,
  )
    .trim()
    .toLowerCase();
  const useMpris = requestedProvider === "linux" || requestedProvider === "mpris";
  let mprisClient = null;

  const getMprisClient = () => {
    if (!mprisClient) {
      // eslint-disable-next-line global-require
      const { MprisSpotifyClient } = require("./linuxMpris");
      mprisClient = new MprisSpotifyClient();
    }
    return mprisClient;
  };

  const getToken = async () => {
    if (typeof getSpotifyAccessToken !== "function") {
      return "";
    }
    try {
      return (await getSpotifyAccessToken()) || "";
    } catch {
      return "";
    }
  };

  let commandTail = Promise.resolve();

  async function dispatchCommand(packet, getSnapshot, expiresAtMs) {
    const assertCurrent = () => assertIntentCurrent(expiresAtMs);
    assertCurrent();
    const guardedSeek = packet.type === "playback:seek:guarded";
    const type = guardedSeek ? "playback:seek" : packet.type;
    if (guardedSeek && !packet.expectedPlayback?.trackId) throw new Error("Guarded seek requires a track.");
    const expected = packet.expectedPlayback;
    const checkTarget = () => {
      const snapshot = getSnapshot();
      if (expected && (!snapshot?.trackId ||
          (expected.deviceId && expected.deviceId !== snapshot.activeDeviceId) ||
          (expected.sessionId && expected.sessionId !== snapshot.playbackSessionId) ||
          (expected.trackId && expected.trackId !== snapshot.trackId))) {
        throw new Error("Playback target changed before dispatch.");
      }
      return snapshot;
    };
    const snapshot = checkTarget();
    const desired = type === "playback:playPause" && typeof packet.desiredPlaying === "boolean";
    // Bind scoped API operations to the device that supplied the observation.
    // Legacy commands keep their established provider and fallback behavior.
    if ((expected || desired) && snapshot?.playbackSource === "spotify-api") {
      const deviceId = snapshot.activeDeviceId;
      if (!deviceId) throw new Error("Spotify did not identify the active playback device.");
      const token = await getToken();
      assertCurrent();
      if (!token) throw new Error("Spotify playback authorization is unavailable.");
      if (checkTarget()?.activeDeviceId !== deviceId) throw new Error("Playback target changed before dispatch.");
      const query = `device_id=${encodeURIComponent(deviceId)}`;
      if (type === "playback:next" || type === "playback:previous") {
        return spotifyApiRequest("POST", `/${type.slice(9)}?${query}`, token);
      }
      if (type === "playback:seek") {
        return spotifyApiRequest("PUT", `/seek?position_ms=${packet.positionMs}&${query}`, token);
      }
      if (desired) return spotifyApiRequest("PUT", `/${packet.desiredPlaying ? "play" : "pause"}?${query}`, token);
      if (type === "playback:resync" && snapshot.isPlaying) {
        await spotifyApiRequest("PUT", `/pause?${query}`, token);
        await delay(RESYNC_PAUSE_MS);
        checkTarget();
        return spotifyApiRequest("PUT", `/play?${query}`, token);
      }
      if (type === "playback:resync") return;
    }
    if (expected && useMpris) {
      const player = getMprisClient();
      const deviceId = expected.deviceId;
      if (type === "playback:seek") return player.seekTo(packet.positionMs, deviceId, expected.sessionId, assertCurrent);
      if (type === "playback:next") return player.callOnPlayer(deviceId, "Next", [], assertCurrent);
      if (type === "playback:previous") return player.callOnPlayer(deviceId, "Previous", [], assertCurrent);
      if (desired) return player.callOnPlayer(deviceId, packet.desiredPlaying ? "Play" : "Pause", [], assertCurrent);
      if (type === "playback:resync" && snapshot.isPlaying) {
        await player.callOnPlayer(deviceId, "Pause", [], assertCurrent);
        await delay(RESYNC_PAUSE_MS);
        checkTarget();
        return player.callOnPlayer(deviceId, "Play");
      }
      if (type === "playback:resync") return;
    }
    if ((expected || desired) && !useMpris) {
      if (snapshot?.scopedPlayback === false) {
        throw new Error("Update the Windows media session addon to enable scoped playback commands.");
      }
      if (!expected?.sessionId || typeof executeWindowsPlayback !== "function" || (type === "playback:playPause" && !desired)) {
        throw new Error("Windows scoped playback requires the current native session and an explicit action.");
      }
      const action = desired ? (packet.desiredPlaying ? "play" : "pause") : type.slice(9);
      return executeWindowsPlayback(expected, action, packet.positionMs ?? 0, expiresAtMs);
    }
    if (desired) {
      return getMprisClient().callOnPlayer(undefined, packet.desiredPlaying ? "Play" : "Pause", [], assertCurrent);
    }
    switch (type) {
      case "playback:playPause": return controller.togglePlayPause();
      case "playback:resync": return controller.resyncPlayback();
      case "playback:next": return controller.next();
      case "playback:previous": return controller.previous();
      case "playback:seek": return controller.seek(packet.positionMs, expiresAtMs);
    }
  }

  const controller = {
    setSpotifyAccessTokenGetter(getter) {
      getSpotifyAccessToken = typeof getter === "function" ? getter : null;
    },
    executeCommand(packet, getSnapshot) {
      const expiresAtMs = Math.min(packet.expiresAtMs ?? Infinity, Date.now() + 12_000);
      const result = commandTail.then(() => dispatchCommand(packet, getSnapshot, expiresAtMs));
      commandTail = result.catch(() => {});
      return result;
    },
    async togglePlayPause() {
      if (useMpris) {
        return getMprisClient().call("PlayPause");
      }
      const token = await getToken();
      if (token) {
        try {
          const state = await fetch("https://api.spotify.com/v1/me/player", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (state.ok) {
            const data = await state.json();
            if (data.is_playing) {
              return spotifyApiRequest("PUT", "/pause", token);
            }
            return spotifyApiRequest("PUT", "/play", token);
          }
        } catch {
          // Fall through to media key
        }
      }
      return runPowerShell(buildMediaKeyScript("toggle"), 2500);
    },
    async resyncPlayback() {
      if (useMpris) {
        await getMprisClient().call("PlayPause");
        await delay(RESYNC_PAUSE_MS);
        return getMprisClient().call("PlayPause");
      }
      const token = await getToken();
      if (token) {
        try {
          const state = await fetch("https://api.spotify.com/v1/me/player", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (state.ok) {
            const data = await state.json();
            if (!data.is_playing) {
              return;
            }
            await spotifyApiRequest("PUT", "/pause", token);
            await delay(RESYNC_PAUSE_MS);
            return spotifyApiRequest("PUT", "/play", token);
          }
        } catch {
          // Fall through to media key
        }
      }
      return runPowerShell(buildResyncScript(), 4000);
    },
    async next() {
      if (useMpris) {
        return getMprisClient().call("Next");
      }
      const token = await getToken();
      if (token) {
        try {
          return await spotifyApiRequest("POST", "/next", token);
        } catch {
          // Fall through to media key
        }
      }
      return runPowerShell(buildMediaKeyScript("next"), 2500);
    },
    async previous() {
      if (useMpris) {
        return getMprisClient().call("Previous");
      }
      const token = await getToken();
      if (token) {
        try {
          return await spotifyApiRequest("POST", "/previous", token);
        } catch {
          // Fall through to media key
        }
      }
      return runPowerShell(buildMediaKeyScript("previous"), 2500);
    },
    async seek(targetPositionMs, expiresAtMs = Date.now() + 12_000) {
      const safeTarget = Number.isFinite(targetPositionMs)
        ? Math.max(0, Math.floor(targetPositionMs))
        : 0;
      if (useMpris) {
        return getMprisClient().seekTo(safeTarget, undefined, undefined, () => assertIntentCurrent(expiresAtMs));
      }
      let nativeError = null;
      try {
        return await runNativeSeek(safeTarget, expiresAtMs);
      } catch (error) {
        if (!error.beforeDispatch) throw error;
        nativeError = error;
      }

      const token = await prepareBeforeIntentDeadline(expiresAtMs, getToken);
      if (!token) {
        throw new Error(
          `${nativeError.message} Sign in to Spotify in the desktop bridge for API seek fallback.`,
        );
      }

      try {
        return await seekViaSpotifyApi(safeTarget, token, expiresAtMs);
      } catch (apiError) {
        const apiMessage =
          apiError instanceof Error ? apiError.message : String(apiError);
        throw new Error(`${nativeError.message} Spotify API fallback: ${apiMessage}`);
      }
    },
  };
  return controller;
}

module.exports = {
  createPlaybackController,
};
