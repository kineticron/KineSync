const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sessionPath = path.join(
  __dirname,
  "..",
  "docker",
  "root",
  "usr",
  "local",
  "bin",
  "start-kinesync-session",
);
const launcherPath = path.join(
  __dirname,
  "..",
  "docker",
  "root",
  "usr",
  "local",
  "bin",
  "start-kinesync",
);
const repositoryRoot = path.join(__dirname, "..", "..");

test("Docker uses seamless Xpra windows instead of a VNC desktop", () => {
  const launcher = fs.readFileSync(launcherPath, "utf8");

  assert.match(launcher, /xpra start :100/);
  assert.match(launcher, /--bind-tcp=0\.0\.0\.0:14500/);
  assert.match(launcher, /--compressors=brotli/);
  assert.match(launcher, /--start-child=\/usr\/local\/bin\/start-kinesync-session/);
  assert.doesNotMatch(launcher, /kasm|vnc/i);
});

test("Spotify visibility follows detected tracks and manual show is temporary", () => {
  const session = fs.readFileSync(sessionPath, "utf8");

  assert.match(session, /\.kinesync-spotify-track-active/);
  assert.match(session, /spotify_force_visible_until/);
  assert.match(session, /date \+%s.*30/);
  assert.match(session, /! -f "\$spotify_track_active"/);
  assert.match(session, /spotify_hidden" -eq 0 \]; then hide_spotify/);
  assert.match(session, /xdotool search --onlyvisible --class spotify/);
  assert.match(session, /xdotool windowunmap/);
  assert.match(session, /show_spotify_for_login\(\)/);
  assert.match(session, /xdotool windowmap/);
  assert.match(session, /\.kinesync-show-spotify/);
  assert.match(session, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(session, /--remote-debugging-port=43880/);
  assert.match(session, /spotify_hidden=0/);
  assert.doesNotMatch(session, /spotify_is_logged_in|spotify\/Users/);
  assert.match(session, /trap stop_children EXIT INT TERM\s+\n?start_bridge\s+start_spotify/);
});

test("Desktop Bridge and Spotify start in the same supervised session", () => {
  const session = fs.readFileSync(sessionPath, "utf8");

  assert.match(session, /start_bridge\(\)/);
  assert.match(session, /start_spotify\(\)/);
  assert.match(session, /dbus-launch --sh-syntax/);
  assert.match(session, /while true; do/);
  assert.match(session, /kill -0 "\$bridge_pid"/);
  assert.match(session, /kill -0 "\$spotify_pid"/);
  assert.doesNotMatch(session, /45|no managed window|stop_spotify/);
});

test("the Windows one-line setup is checkout-independent and PowerShell 5 compatible", () => {
  const setup = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "setup-docker.ps1"),
    "utf8",
  );

  assert.match(setup, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(setup, /generator\.GetBytes\(\$bytes\)/);
  assert.doesNotMatch(setup, /RandomNumberGenerator\]::GetBytes\(/);
  assert.match(setup, /LOCALAPPDATA 'KineSync\\Docker'/);
  assert.match(setup, /Xpra-Light-x86_64/);
  assert.match(setup, /--noproxy '\*' --ssl-no-revoke/);
  assert.match(setup, /xpraArchiveSha256/);
  assert.match(setup, /Wait-KineSyncWindowService/);
  assert.match(setup, /xpra id --compressors=brotli/);
  assert.match(setup, /\[switch\]\$BuildLocal/);
  assert.match(setup, /compose\.dev\.yaml/);
  assert.match(setup, /docker container ls --format/);
  assert.doesNotMatch(setup, /docker inspect --format '\{\{\.State\.Running\}\}' \$containerName/);
  assert.doesNotMatch(setup, /KINESYNC_WEB_|localhost:3000|kasm/i);
});

test("Compose exposes only seamless windows and the pairing bridge", () => {
  const compose = fs.readFileSync(
    path.join(repositoryRoot, "compose.yaml"),
    "utf8",
  );

  assert.match(compose, /KINESYNC_UI_PORT:-14500/);
  assert.match(compose, /KINESYNC_BRIDGE_BIND_ADDRESS:-0\.0\.0\.0}:3001:3001/);
  assert.doesNotMatch(compose, /KINESYNC_WEB_|CUSTOM_USER|PASSWORD|3000|3443|vnc|kasm/i);
});
