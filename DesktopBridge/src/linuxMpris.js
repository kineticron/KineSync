const crypto = require("node:crypto");

const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";
const DEFAULT_PLAYER_PREFIX = "org.mpris.MediaPlayer2.spotify";
const DEFAULT_POLL_INTERVAL_MS = 750;

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
    return buildMprisSnapshot({ metadata, playbackStatus, positionUs });
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

module.exports = {
  LinuxMediaSessionWatcher,
  MprisSpotifyClient,
  buildMprisSnapshot,
  microsecondsToMilliseconds,
  unwrapVariant,
};
