const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LinuxMediaSessionWatcher,
  MprisSpotifyClient,
  buildMprisSnapshot,
  microsecondsToMilliseconds,
  unwrapVariant,
} = require("../src/linuxMpris");

test("MprisSpotifyClient binds generated control methods to the interface", async () => {
  const client = new MprisSpotifyClient({ busAddress: "unix:path=/test" });
  const player = {
    $callMethod() {},
    PlayPause(callback) {
      assert.equal(this, player);
      callback(null, "sent");
    },
  };
  client.getPlayerInterface = async () => player;

  assert.equal(await client.call("PlayPause"), "sent");
});

test("MprisSpotifyClient seek binds SetPosition and converts milliseconds", async () => {
  const client = new MprisSpotifyClient({ busAddress: "unix:path=/test" });
  const player = {
    $callMethod() {},
    SetPosition(trackId, positionUs, callback) {
      assert.equal(this, player);
      assert.equal(trackId, "/com/spotify/track/test123");
      assert.equal(positionUs, 42_500_000);
      callback(null);
    },
  };
  client.getPlayerInterface = async () => player;
  client.readProperty = async () => ({
    "mpris:trackid": ["o", ["/com/spotify/track/test123"]],
  });

  await client.seekTo(42_500);
});

test("unwrapVariant handles D-Bus scalar and array variants", () => {
  assert.equal(unwrapVariant(["s", ["Playing"]]), "Playing");
  assert.deepEqual(unwrapVariant(["as", [["First Artist", "Second Artist"]]]), [
    "First Artist",
    "Second Artist",
  ]);
  assert.equal(microsecondsToMilliseconds(["x", [12_345_678]]), 12_346);
});

test("buildMprisSnapshot handles dbus-native dictionary and signature objects", () => {
  const signature = (type, child = []) => [{ type, child }];
  const variant = (type, value, child = []) => [signature(type, child), [value]];
  const metadata = [
    ["mpris:trackid", variant("s", "/com/spotify/track/test123")],
    ["mpris:length", variant("t", 158000000)],
    ["mpris:artUrl", variant("s", "https://i.scdn.co/image/test")],
    ["xesam:album", variant("s", "Test Album")],
    [
      "xesam:artist",
      variant("a", ["First Artist", "Second Artist"], signature("s")),
    ],
    ["xesam:title", variant("s", "Test Track")],
  ];

  const snapshot = buildMprisSnapshot({
    metadata,
    playbackStatus: ["s", ["Playing"]],
    positionUs: ["x", [42000000]],
    capturedAtMs: 1234,
  });

  assert.equal(snapshot.title, "Test Track");
  assert.equal(snapshot.artist, "First Artist, Second Artist");
  assert.equal(snapshot.album, "Test Album");
  assert.equal(snapshot.artworkUrl, "https://i.scdn.co/image/test");
  assert.equal(snapshot.durationMs, 158000);
  assert.equal(snapshot.positionMs, 42000);
  assert.equal(snapshot.isPlaying, true);
});

test("buildMprisSnapshot converts Spotify metadata to the native watcher contract", () => {
  const snapshot = buildMprisSnapshot({
    metadata: {
      "xesam:title": ["s", ["Test Track"]],
      "xesam:artist": ["as", [["Artist One", "Artist Two"]]],
      "xesam:album": ["s", ["Test Album"]],
      "mpris:artUrl": ["s", ["https://example.test/art.jpg"]],
      "mpris:length": ["x", [245_500_000]],
    },
    playbackStatus: "Playing",
    positionUs: 12_250_000,
    capturedAtMs: 1234,
  });

  assert.deepEqual(snapshot, {
    title: "Test Track",
    artist: "Artist One, Artist Two",
    album: "Test Album",
    artworkUrl: "https://example.test/art.jpg",
    durationMs: 245_500,
    positionMs: 12_250,
    rawPositionMs: 12_250,
    isPlaying: true,
    timelineSync: true,
    source: "linux-mpris",
    capturedAtMs: 1234,
    positionBasisMs: 1234,
  });
});

test("LinuxMediaSessionWatcher emits changed snapshots and deduplicates errors", async () => {
  const snapshots = [];
  const errors = [];
  let readCount = 0;
  const client = {
    async readSnapshot() {
      readCount += 1;
      if (readCount === 3) {
        throw new Error("Spotify unavailable");
      }
      if (readCount === 4) {
        throw new Error("Spotify unavailable");
      }
      return {
        title: "Track",
        artist: "Artist",
        album: "Album",
        durationMs: 100_000,
        positionMs: readCount === 1 ? 1_000 : 2_000,
        isPlaying: true,
      };
    },
    close() {},
  };
  const watcher = new LinuxMediaSessionWatcher(
    (snapshot) => snapshots.push(snapshot),
    (error) => errors.push(error),
    { client },
  );
  watcher.running = true;

  await watcher.poll();
  await watcher.poll();
  await watcher.poll();
  await watcher.poll();
  watcher.stop();

  assert.equal(snapshots.length, 2);
  assert.deepEqual(errors, ["Spotify unavailable"]);
});
