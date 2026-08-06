// Runs the injected now-playing reader from lib/spotify-browser.ts against a fake
// Spotify DOM. Guards the fix for the bug where the app grabbed the Spotify id of
// whatever track happened to be rendered instead of the one actually playing.
// Usage: node scripts/verify-spotify-browser-metadata.js

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "lib", "spotify-browser.ts"),
  "utf8",
);
const marker = "export const installBrowserControlScript = String.raw`";
const start = source.indexOf(marker);
assert.ok(start >= 0, "installBrowserControlScript not found");
const bodyStart = start + marker.length;
const bodyEnd = source.indexOf("`;", bodyStart);
assert.ok(bodyEnd > bodyStart, "unterminated installBrowserControlScript");
const script = source.slice(bodyStart, bodyEnd);

function element({ text = "", href = "", children = {} } = {}) {
  const node = {
    tagName: href ? "A" : "DIV",
    textContent: text,
    href,
    getAttribute: (name) => (name === "href" ? href || null : null),
    matches: (selector) => Boolean(href) && selector.includes("/track/"),
    closest: (selector) => (Boolean(href) && selector.includes("/track/") ? node : null),
    querySelector: (selector) => {
      for (const [key, child] of Object.entries(children)) {
        if (selector.includes(key)) return child;
      }
      return null;
    },
    querySelectorAll: (selector) => {
      const hit = node.querySelector(selector);
      return hit ? [hit] : [];
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    parentElement: null,
  };
  return node;
}

function run({ mediaTitle, domTitle, linkTrackId }) {
  const link = element({ text: domTitle, href: `https://open.spotify.com/track/${linkTrackId}` });
  const widget = element({
    children: {
      "context-item-info-title": link,
      "/artist/": element({ text: "Real Artist" }),
    },
  });

  const posted = [];
  const document = {
    body: null,
    visibilityState: "visible",
    addEventListener: () => {},
    querySelector: (selector) => (selector.includes("now-playing-bar") ? widget : null),
    querySelectorAll: () => [],
  };
  const navigator = {
    mediaSession: {
      playbackState: "playing",
      metadata: {
        title: mediaTitle,
        artist: "Real Artist",
        album: "Real Album",
        artwork: [
          { src: "https://i.scdn.co/image/small", sizes: "64x64" },
          { src: "https://i.scdn.co/image/large", sizes: "640x640" },
        ],
      },
    },
  };
  const win = {
    navigator,
    ReactNativeWebView: { postMessage: (payload) => posted.push(JSON.parse(payload)) },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    __spotifyBrowserLabKnownMedia: [],
    __spotifyBrowserLabPositionState: null,
  };

  class MutationObserver {
    observe() {}
  }

  // eslint-disable-next-line no-new-func
  new Function("window", "document", "navigator", "performance", "MutationObserver", script)(
    win,
    document,
    navigator,
    { now: () => 1000 },
    MutationObserver,
  );

  return posted.find((event) => event.type === "metadata") || null;
}

const matching = run({
  mediaTitle: "Real Song",
  domTitle: "Real Song",
  linkTrackId: "1111111111111111111111",
});
assert.ok(matching, "no metadata event emitted");
assert.strictEqual(matching.title, "Real Song");
assert.strictEqual(matching.artist, "Real Artist");
assert.strictEqual(matching.album, "Real Album");
assert.strictEqual(matching.artworkUrl, "https://i.scdn.co/image/large");
assert.strictEqual(matching.spotifyTrackId, "1111111111111111111111");

const stale = run({
  mediaTitle: "Real Song",
  domTitle: "Some Other Song",
  linkTrackId: "2222222222222222222222",
});
assert.ok(stale, "no metadata event emitted for stale DOM");
assert.strictEqual(stale.title, "Real Song");
// The id belongs to a different track than the one playing, so it must be dropped
// and left to catalog search instead of poisoning every lyrics source.
assert.strictEqual(stale.spotifyTrackId, "");

console.log("spotify-browser metadata reader OK");
