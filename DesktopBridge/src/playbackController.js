const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getDotnetExecutable } = require("./dotnetExecutable");

function escapePowerShellSingleQuotes(value) {
  return String(value ?? "").replace(/'/g, "''");
}

const SEEK_HELPER_PROJECT_DIR = path.join(
  __dirname,
  "..",
  "native",
  "spotify-seek-helper",
);
const SEEK_HELPER_DLL_PATH = path.join(
  SEEK_HELPER_PROJECT_DIR,
  "bin",
  "Release",
  "net9.0-windows10.0.19041.0",
  "spotify-seek-helper.dll",
);
let seekHelperBuildPromise = null;

function runPowerShell(script, timeoutMs = 6000, useSta = false) {
  return new Promise((resolve, reject) => {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass"];
    if (useSta) {
      args.push("-Sta");
    }
    args.push("-Command", script);
    const child = spawn("powershell.exe", args, {
      windowsHide: true,
    });

    let stderr = "";
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`Playback command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            stdout.trim() ||
            `PowerShell exited with code ${code}`,
        ),
      );
    });
  });
}

function runDotnetCommand(args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn(getDotnetExecutable(), args, {
      cwd: SEEK_HELPER_PROJECT_DIR,
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`dotnet command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `dotnet exited with code ${code}`,
        ),
      );
    });
  });
}

function ensureSeekHelperBuilt({ force = false } = {}) {
  if (!force && fs.existsSync(SEEK_HELPER_DLL_PATH)) {
    try {
      const dllStat = fs.statSync(SEEK_HELPER_DLL_PATH);
      const sourceStat = fs.statSync(
        path.join(SEEK_HELPER_PROJECT_DIR, "Program.cs"),
      );
      if (dllStat.mtimeMs >= sourceStat.mtimeMs) {
        return Promise.resolve();
      }
    } catch {
      // Fall through to rebuild when stat checks fail.
    }
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

async function runNativeSeek(targetPositionMs) {
  const safeTarget = Number.isFinite(targetPositionMs)
    ? Math.max(0, Math.floor(targetPositionMs))
    : 0;
  try {
    await ensureSeekHelperBuilt();
    await runDotnetCommand(
      [SEEK_HELPER_DLL_PATH, "seek", String(safeTarget)],
      8000,
    );
    return;
  } catch (dotnetError) {
    const message =
      dotnetError instanceof Error ? dotnetError.message : String(dotnetError);
    const looksLikeOldHelper =
      message.includes("Usage: spotify-seek-helper <targetPositionMs>") ||
      message.includes("Unsupported command");
    if (looksLikeOldHelper) {
      await ensureSeekHelperBuilt({ force: true });
      await runDotnetCommand(
        [SEEK_HELPER_DLL_PATH, "seek", String(safeTarget)],
        8000,
      );
      return;
    }
    try {
      await runPowerShell(buildSessionScript("seek", safeTarget), 8000, true);
      return;
    } catch {
      throw dotnetError;
    }
  }
}

function buildSessionScript(action, positionMs = 0) {
  const safeAction = escapePowerShellSingleQuotes(action);
  const safePositionMs = Number.isFinite(positionMs)
    ? Math.max(0, Math.floor(positionMs))
    : 0;
  const safePositionTicks = safePositionMs * 10_000;
  return `
$ErrorActionPreference = 'Stop'
$managerType = [Type]::GetType('Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows, ContentType=WindowsRuntime')
function Wait-WinRtResult($op, $timeoutMs = 2200) {
  $started = [Environment]::TickCount64
  while ([int]$op.Status -eq 0) {
    if (([Environment]::TickCount64 - $started) -ge $timeoutMs) {
      throw 'WinRT operation timeout'
    }
    Start-Sleep -Milliseconds 5
  }
  if ([int]$op.Status -ne 1) { throw "WinRT operation failed: $($op.Status)" }
  return $op.GetResults()
}
$action = '${safeAction}'
function Send-MediaKey([byte]$vk) {
  if (-not ([System.Management.Automation.PSTypeName]'MediaKey.NativeMethods').Type) {
    Add-Type -Namespace MediaKey -Name NativeMethods -MemberDefinition @'
      [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
      public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
  }
  [MediaKey.NativeMethods]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [MediaKey.NativeMethods]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}
function Get-MediaSession() {
  if (-not $managerType) {
    return $null
  }
  $manager = Wait-WinRtResult ($managerType::RequestAsync()) 2500
  $spotifySessions = @($manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -like '*Spotify*' })
  if ($spotifySessions.Count -gt 0) {
    return $spotifySessions[0]
  }
  return $manager.GetCurrentSession()
}

if ($action -eq 'toggle') {
  try {
    $session = Get-MediaSession
    if ($session) {
      $playbackInfo = $session.TryGetPlaybackInfo()
      if ($playbackInfo -and $playbackInfo.Controls.IsPlayPauseToggleEnabled) {
        $ok = Wait-WinRtResult ($session.TryTogglePlayPauseAsync()) 2200
        if (($ok -is [bool]) -and $ok) { exit 0 }
      }
    }
  } catch {}
  Send-MediaKey 0xB3
  exit 0
}
if ($action -eq 'next') {
  try {
    $session = Get-MediaSession
    if ($session) {
      $playbackInfo = $session.TryGetPlaybackInfo()
      if ($playbackInfo -and $playbackInfo.Controls.IsNextEnabled) {
        $ok = Wait-WinRtResult ($session.TrySkipNextAsync()) 2200
        if (($ok -is [bool]) -and $ok) { exit 0 }
      }
    }
  } catch {}
  Send-MediaKey 0xB0
  exit 0
}
if ($action -eq 'previous') {
  try {
    $session = Get-MediaSession
    if ($session) {
      $playbackInfo = $session.TryGetPlaybackInfo()
      if ($playbackInfo -and $playbackInfo.Controls.IsPreviousEnabled) {
        $ok = Wait-WinRtResult ($session.TrySkipPreviousAsync()) 2200
        if (($ok -is [bool]) -and $ok) { exit 0 }
      }
    }
  } catch {}
  Send-MediaKey 0xB1
  exit 0
}
if ($action -eq 'seek') {
  $session = Get-MediaSession
  if (-not $session) { throw 'No media session available for seek' }
  $playbackInfo = $session.GetPlaybackInfo()
  $controls = $playbackInfo.Controls
  if (-not $controls.IsPlaybackPositionEnabled) { throw 'Seek is not enabled for current media session' }
  $ok = Wait-WinRtResult ($session.TryChangePlaybackPositionAsync([UInt64]${safePositionTicks})) 3000
  if (($ok -is [bool]) -and (-not $ok)) { throw 'Seek command rejected by session' }
  exit 0
}
throw 'Unsupported action'
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

async function seekViaSpotifyApi(targetPositionMs, accessToken) {
  const safeTarget = Number.isFinite(targetPositionMs)
    ? Math.max(0, Math.floor(targetPositionMs))
    : 0;
  let deviceId = "";

  try {
    const playerResponse = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (playerResponse.ok) {
      const state = await playerResponse.json();
      deviceId = String(state?.device?.id || "");
    }
  } catch {
    // Fall through to device list lookup.
  }

  if (!deviceId) {
    const devicesResponse = await fetch(
      "https://api.spotify.com/v1/me/player/devices",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
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

  const query = deviceId
    ? `/seek?position_ms=${safeTarget}&device_id=${encodeURIComponent(deviceId)}`
    : `/seek?position_ms=${safeTarget}`;
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

function createPlaybackController() {
  let getSpotifyAccessToken = null;

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

  return {
    setSpotifyAccessTokenGetter(getter) {
      getSpotifyAccessToken = typeof getter === "function" ? getter : null;
    },
    async togglePlayPause() {
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
    async seek(targetPositionMs) {
      const safeTarget = Number.isFinite(targetPositionMs)
        ? Math.max(0, Math.floor(targetPositionMs))
        : 0;
      let nativeError = null;
      try {
        return await runNativeSeek(safeTarget);
      } catch (error) {
        nativeError =
          error instanceof Error ? error : new Error(String(error || ""));
      }

      const token = await getToken();
      if (!token) {
        throw new Error(
          `${nativeError.message} Sign in to Spotify in the desktop bridge for API seek fallback.`,
        );
      }

      try {
        return await seekViaSpotifyApi(safeTarget, token);
      } catch (apiError) {
        const apiMessage =
          apiError instanceof Error ? apiError.message : String(apiError);
        throw new Error(`${nativeError.message} Spotify API fallback: ${apiMessage}`);
      }
    },
  };
}

module.exports = {
  createPlaybackController,
};
