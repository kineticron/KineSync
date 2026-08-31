const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  LinuxMediaSessionWatcher,
  LinuxMprisProcessWatcher,
  MprisSpotifyClient,
  buildMprisSnapshot,
  detectArtworkMime,
  makeMprisArtworkPortable,
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

test("makeMprisArtworkPortable converts Docker Spotify file artwork to a data URI", async () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
  ]);
  let resolvedPath = "";
  const portable = await makeMprisArtworkPortable(
    "file:///config/.cache/spotify/cover%20art.png",
    {
      stat: async (artworkPath) => {
        resolvedPath = artworkPath;
        return { isFile: () => true, size: png.length };
      },
      readFile: async () => png,
      urlToPath: (url) => decodeURIComponent(url.pathname),
    },
  );

  assert.equal(resolvedPath, "/config/.cache/spotify/cover art.png");
  assert.equal(portable, `data:image/png;base64,${png.toString("base64")}`);
});

test("makeMprisArtworkPortable rejects remote, oversized, and invalid image files", async () => {
  const neverRead = async () => {
    assert.fail("rejected artwork must not be read");
  };
  assert.equal(
    await makeMprisArtworkPortable("file://remote-host/cover.jpg", {
      stat: neverRead,
      readFile: neverRead,
    }),
    "",
  );
  assert.equal(
    await makeMprisArtworkPortable("file:///config/huge.jpg", {
      stat: async () => ({ isFile: () => true, size: 5 * 1024 * 1024 + 1 }),
      readFile: neverRead,
    }),
    "",
  );
  assert.equal(
    await makeMprisArtworkPortable("file:///config/not-an-image.txt", {
      stat: async () => ({ isFile: () => true, size: 4 }),
      readFile: async () => Buffer.from("nope"),
    }),
    "",
  );
  assert.equal(detectArtworkMime(Buffer.from("nope")), "");
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

test("LinuxMediaSessionWatcher emits artwork changes while playback is paused", async () => {
  const snapshots = [];
  let artworkUrl = "data:image/png;base64,first";
  const client = {
    async readSnapshot() {
      return {
        title: "Track",
        artist: "Artist",
        album: "Album",
        artworkUrl,
        durationMs: 100_000,
        positionMs: 2_000,
        isPlaying: false,
      };
    },
    close() {},
  };
  const watcher = new LinuxMediaSessionWatcher(
    (snapshot) => snapshots.push(snapshot),
    undefined,
    { client },
  );
  watcher.running = true;

  await watcher.poll();
  artworkUrl = "data:image/png;base64,second";
  await watcher.poll();
  watcher.stop();

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].artworkUrl, artworkUrl);
});

test("LinuxMprisProcessWatcher forwards framed worker snapshots and stops its child", async () => {
  const snapshots = [];
  const errors = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  let spawnCall = null;
  const watcher = new LinuxMprisProcessWatcher(
    (snapshot) => snapshots.push(snapshot),
    (error) => errors.push(error),
    {
      nodeExecutable: "node-test",
      workerPath: "/test/linuxMpris.js",
      spawnImpl: (...args) => {
        spawnCall = args;
        return child;
      },
    },
  );

  watcher.start();
  assert.equal(spawnCall[0], "node-test");
  assert.deepEqual(spawnCall[1], ["/test/linuxMpris.js", "--snapshot-worker"]);

  child.stdout.write('{"type":"snapshot","snapshot":{"title":"Tra');
  child.stdout.write('ck","artworkUrl":"https://example.test/art.jpg"}}\n');
  child.stdout.write('{"type":"error","message":"temporary failure"}\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(snapshots, [
    { title: "Track", artworkUrl: "https://example.test/art.jpg" },
  ]);
  assert.deepEqual(errors, ["temporary failure"]);

  watcher.stop();
  assert.equal(child.killed, true);
});
