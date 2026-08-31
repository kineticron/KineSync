const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const { fileURLToPath } = require("node:url");

const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";
const DEFAULT_PLAYER_PREFIX = "org.mpris.MediaPlayer2.spotify";
const DEFAULT_POLL_INTERVAL_MS = 750;
const MAX_INLINE_ARTWORK_BYTES = 5 * 1024 * 1024;
const MAX_WORKER_MESSAGE_CHARS = 8 * 1024 * 1024;
const WORKER_RESTART_DELAY_MS = 1_000;

function detectArtworkMime(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return "";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))
  ) {
    return "image/gif";
  }
  return "";
}

async function makeMprisArtworkPortable(
  artworkUrl,
  {
    readFile = fs.readFile,
    stat = fs.stat,
    urlToPath = fileURLToPath,
  } = {},
) {
  const raw = String(artworkUrl || "").trim();
  if (!raw || !raw.toLowerCase().startsWith("file:")) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    // A remote file host would make this an unintended filesystem/network path.
    if (parsed.protocol !== "file:" || (parsed.hostname && parsed.hostname !== "localhost")) {
      return "";
    }
    const artworkPath = urlToPath(parsed);
    const fileInfo = await stat(artworkPath);
    if (!fileInfo.isFile() || fileInfo.size <= 0 || fileInfo.size > MAX_INLINE_ARTWORK_BYTES) {
      return "";
    }
    const contents = await readFile(artworkPath);
    if (contents.length > MAX_INLINE_ARTWORK_BYTES) {
      return "";
    }
    const mime = detectArtworkMime(contents);
    return mime ? `data:${mime};base64,${contents.toString("base64")}` : "";
  } catch {
    // Spotify can evict its cached cover between the MPRIS read and this read.
    // The detector's remote artwork resolver remains available as a fallback.
    return "";
  }
}

function unwrapVariant(value) {
  let current = value;
  while (
    Array.isArray(current) &&
    current.length === 2 &&
    (typeof current[0] === "string"
      ? /^[ybnqiuxtdhsogav(){}]+$/.test(current[0])
      : Array.isArray(current[0]) &&
        current[0].length > 0 &&
        current[0].every(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.type === "string",
        ))
  ) {
    current = current[1];
    if (Array.isArray(current) && current.length === 1) {
      current = current[0];
    }
  }
  return current;
}

function metadataValue(metadata, key, fallback = "") {
  if (!metadata || typeof metadata !== "object") {
    return fallback;
  }
  let rawValue;
  if (metadata instanceof Map) {
    rawValue = metadata.get(key);
  } else if (Array.isArray(metadata)) {
    const entry = metadata.find(
      (candidate) =>
        Array.isArray(candidate) && String(candidate[0] || "") === key,
    );
    rawValue = entry?.[1];
  } else {
    rawValue = metadata[key];
  }
  const value = unwrapVariant(rawValue);
  return value === undefined || value === null ? fallback : value;
}

function firstText(value) {
  const unwrapped = unwrapVariant(value);
  if (Array.isArray(unwrapped)) {
    return unwrapped.map((entry) => String(unwrapVariant(entry) || "")).filter(Boolean).join(", ");
  }
  return String(unwrapped || "");
}

function microsecondsToMilliseconds(value) {
  const numeric = Number(unwrapVariant(value));
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric / 1000)) : 0;
}

function buildMprisSnapshot({ metadata, playbackStatus, positionUs, capturedAtMs = Date.now() }) {
  const title = firstText(metadataValue(metadata, "xesam:title"));
  const artist = firstText(metadataValue(metadata, "xesam:artist"));
  const album = firstText(metadataValue(metadata, "xesam:album"));
  const artworkUrl = firstText(metadataValue(metadata, "mpris:artUrl"));
  const durationMs = microsecondsToMilliseconds(
    metadataValue(metadata, "mpris:length", 0),
  );
  const positionMs = microsecondsToMilliseconds(positionUs);

  return {
    title,
    artist,
    album,
    artworkUrl,
    durationMs,
    positionMs,
    rawPositionMs: positionMs,
    isPlaying: String(unwrapVariant(playbackStatus) || "").toLowerCase() === "playing",
    timelineSync: true,
    source: "linux-mpris",
    capturedAtMs,
    positionBasisMs: capturedAtMs,
  };
}

function callbackToPromise(register) {
  return new Promise((resolve, reject) => {
    register((error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });
}

class MprisSpotifyClient {
  constructor({ dbusModule, busAddress, playerPrefix = process.env.MPRIS_PLAYER || DEFAULT_PLAYER_PREFIX } = {}) {
    this.dbusModule = dbusModule || null;
    this.busAddress = busAddress || process.env.DBUS_SESSION_BUS_ADDRESS || "";
    this.playerPrefix = String(playerPrefix || DEFAULT_PLAYER_PREFIX);
    this.bus = null;
    this.playerName = "";
    this.playerInterface = null;
  }

  loadDbusModule() {
    if (!this.dbusModule) {
      // Loaded lazily so Windows installs never initialize a D-Bus dependency.
      // eslint-disable-next-line global-require
      this.dbusModule = require("@homebridge/dbus-native");
    }
    return this.dbusModule;
  }

  ensureBus() {
    if (this.bus) {
      return this.bus;
    }
    if (!this.busAddress) {
      throw new Error(
        "DBUS_SESSION_BUS_ADDRESS is not set; Spotify and DesktopBridge must share a D-Bus session.",
      );
    }
    const dbus = this.loadDbusModule();
    this.bus = dbus.sessionBus({ busAddress: this.busAddress });
    this.bus.connection.on("error", () => {
      this.playerName = "";
      this.playerInterface = null;
    });
    return this.bus;
  }

  async findPlayerName() {
    const bus = this.ensureBus();
    const names = await callbackToPromise((callback) => bus.listNames(callback));
    const candidates = Array.isArray(names) ? names : [];
    return (
      candidates.find((name) => String(name) === this.playerPrefix) ||
      candidates.find((name) => String(name).startsWith(`${this.playerPrefix}.`)) ||
      ""
    );
  }

  async getPlayerInterface() {
    const playerName = await this.findPlayerName();
    if (!playerName) {
      this.playerName = "";
      this.playerInterface = null;
      throw new Error(`Spotify MPRIS service not found (${this.playerPrefix}).`);
    }
    if (this.playerInterface && this.playerName === playerName) {
      return this.playerInterface;
    }
    this.playerName = playerName;
    this.playerInterface = await callbackToPromise((callback) =>
      this.ensureBus()
        .getService(playerName)
        .getInterface(MPRIS_PATH, MPRIS_PLAYER_INTERFACE, callback),
    );
    return this.playerInterface;
  }

  async readProperty(name) {
    const player = await this.getPlayerInterface();
    const getter = player?.[name];
    if (typeof getter !== "function") {
      throw new Error(`Spotify MPRIS property is unavailable: ${name}`);
    }
    return callbackToPromise((callback) => getter(callback));
  }

  async readSnapshot() {
    const [metadata, playbackStatus, positionUs] = await Promise.all([
      this.readProperty("Metadata"),
      this.readProperty("PlaybackStatus"),
      this.readProperty("Position"),
    ]);
    const snapshot = buildMprisSnapshot({ metadata, playbackStatus, positionUs });
    snapshot.artworkUrl = await makeMprisArtworkPortable(snapshot.artworkUrl);
    return snapshot;
  }

  async call(method, ...args) {
    const player = await this.getPlayerInterface();
    const fn = player?.[method];
    if (typeof fn !== "function") {
      throw new Error(`Spotify MPRIS method is unavailable: ${method}`);
    }
    // dbus-native generates proxy methods that dispatch through
    // `this.$callMethod`; preserve the interface receiver when invoking them.
    return callbackToPromise((callback) => fn.call(player, ...args, callback));
  }

  async seekTo(positionMs) {
    const metadata = await this.readProperty("Metadata");
    const trackId = firstText(metadataValue(metadata, "mpris:trackid"));
    if (!trackId) {
      throw new Error("Spotify MPRIS metadata did not include a track id.");
    }
    const positionUs = Math.max(0, Math.floor(Number(positionMs) || 0)) * 1000;
    return this.call("SetPosition", trackId, positionUs);
  }

  close() {
    this.playerInterface = null;
    this.playerName = "";
    if (this.bus?.connection && typeof this.bus.connection.end === "function") {
      this.bus.connection.end();
    }
    this.bus = null;
  }
}

class LinuxMediaSessionWatcher {
  constructor(onSnapshot, onError, options = {}) {
    this.onSnapshot = onSnapshot;
    this.onError = onError;
    this.pollIntervalMs = Math.max(
      250,
      Number(options.pollIntervalMs || process.env.MPRIS_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS),
    );
    this.client = options.client || new MprisSpotifyClient(options);
    this.running = false;
    this.timer = null;
    this.pollInFlight = false;
    this.lastError = "";
    this.lastSnapshotSignature = "";
  }

  reportError(error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown MPRIS error");
    if (message === this.lastError) {
      return;
    }
    this.lastError = message;
    if (typeof this.onError === "function") {
      this.onError(message);
    }
  }

  async poll() {
    if (!this.running || this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const snapshot = await this.client.readSnapshot();
      this.lastError = "";
      const signature = crypto
        .createHash("sha1")
        .update(
          JSON.stringify({
            title: snapshot.title,
            artist: snapshot.artist,
            album: snapshot.album,
            artworkUrl: snapshot.artworkUrl,
            durationMs: snapshot.durationMs,
            positionMs: snapshot.positionMs,
            isPlaying: snapshot.isPlaying,
          }),
        )
        .digest("hex");
      if (signature !== this.lastSnapshotSignature) {
        this.lastSnapshotSignature = signature;
        if (typeof this.onSnapshot === "function") {
          this.onSnapshot(snapshot);
        }
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.pollInFlight = false;
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.client.close();
  }
}

class LinuxMprisProcessWatcher {
  constructor(onSnapshot, onError, options = {}) {
    this.onSnapshot = onSnapshot;
    this.onError = onError;
    this.spawnImpl = options.spawnImpl || spawn;
    this.nodeExecutable =
      options.nodeExecutable || process.env.KINESYNC_NODE_EXECUTABLE || "node";
    this.workerPath = options.workerPath || __filename;
    this.restartDelayMs = Math.max(
      100,
      Number(options.restartDelayMs || WORKER_RESTART_DELAY_MS),
    );
    this.running = false;
    this.child = null;
    this.restartTimer = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.lastError = "";
  }

  reportError(error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown MPRIS worker error");
    if (!message || message === this.lastError) {
      return;
    }
    this.lastError = message;
    if (typeof this.onError === "function") {
      this.onError(message);
    }
  }

  handleLine(line) {
    if (!line) {
      return;
    }
    let packet;
    try {
      packet = JSON.parse(line);
    } catch {
      this.reportError("MPRIS worker returned invalid JSON.");
      return;
    }
    if (packet?.type === "snapshot" && packet.snapshot) {
      this.lastError = "";
      if (typeof this.onSnapshot === "function") {
        this.onSnapshot(packet.snapshot);
      }
      return;
    }
    if (packet?.type === "error") {
      this.reportError(packet.message);
    }
  }

  handleStdout(chunk, child) {
    if (!this.running || child !== this.child) {
      return;
    }
    this.stdoutBuffer += String(chunk);
    if (this.stdoutBuffer.length > MAX_WORKER_MESSAGE_CHARS) {
      this.reportError("MPRIS worker message exceeded the artwork size limit.");
      child.kill();
      return;
    }
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  scheduleRestart() {
    if (!this.running || this.restartTimer) {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, this.restartDelayMs);
  }

  launch() {
    if (!this.running || this.child) {
      return;
    }
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    let child;
    try {
      child = this.spawnImpl(
        this.nodeExecutable,
        [this.workerPath, "--snapshot-worker"],
        {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      this.reportError(error);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    child.stdout?.on("data", (chunk) => this.handleStdout(chunk, child));
    child.stderr?.on("data", (chunk) => {
      if (child !== this.child) return;
      this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-2_048);
    });
    child.once("error", (error) => {
      if (child !== this.child) return;
      this.reportError(error);
    });
    child.once("close", (code) => {
      if (child !== this.child) return;
      this.child = null;
      if (this.running && code !== 0) {
        this.reportError(
          this.stderrBuffer.trim() || `MPRIS worker exited with code ${code}.`,
        );
      }
      this.scheduleRestart();
    });
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.launch();
  }

  stop() {
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    if (child) {
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.kill();
    }
  }
}

function runSnapshotWorker() {
  let lastArtworkKey = "";
  let outputBlocked = false;
  const writePacket = (packet) => {
    if (outputBlocked) {
      return;
    }
    outputBlocked = !process.stdout.write(`${JSON.stringify(packet)}\n`);
    if (outputBlocked) {
      process.stdout.once("drain", () => {
        outputBlocked = false;
      });
    }
  };
  const watcher = new LinuxMediaSessionWatcher(
    (snapshot) => {
      const artworkUrl = String(snapshot?.artworkUrl || "");
      const artworkKey = `${snapshot?.title || ""}\u0000${snapshot?.artist || ""}\u0000${artworkUrl}`;
      const outgoing = { ...snapshot };
      if (!artworkUrl || artworkKey === lastArtworkKey) {
        delete outgoing.artworkUrl;
      } else {
        lastArtworkKey = artworkKey;
      }
      writePacket({ type: "snapshot", snapshot: outgoing });
    },
    (message) => writePacket({ type: "error", message }),
  );
  const stop = () => {
    watcher.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  watcher.start();
}

module.exports = {
  LinuxMediaSessionWatcher,
  LinuxMprisProcessWatcher,
  MprisSpotifyClient,
  buildMprisSnapshot,
  detectArtworkMime,
  makeMprisArtworkPortable,
  microsecondsToMilliseconds,
  unwrapVariant,
};

if (require.main === module && process.argv.includes("--snapshot-worker")) {
  runSnapshotWorker();
}
