const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const supervisorPath = path.join(
  __dirname,
  "..",
  "docker",
  "root",
  "usr",
  "local",
  "bin",
  "start-kinesync",
);

test("Spotify window probe reads all xwininfo output under pipefail", () => {
  const supervisor = fs.readFileSync(supervisorPath, "utf8");
  const functionBody = supervisor.match(
    /spotify_window_exists\(\) \{([\s\S]*?)\n  \}/,
  )?.[1];
  const commands = functionBody
    ?.split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  assert.ok(functionBody, "spotify_window_exists function is present");
  assert.match(commands, /xwininfo -root -tree/);
  assert.doesNotMatch(commands, /grep\s+-q/);
  assert.match(commands, /grep\s+'"Spotify"'\s+>\/dev\/null/);
});

test("Spotify is minimized only after a persisted login is detected", () => {
  const supervisor = fs.readFileSync(supervisorPath, "utf8");

  assert.match(supervisor, /spotify_is_logged_in\(\)/);
  assert.match(supervisor, /spotify\/Users/);
  assert.match(supervisor, /-name '\*-user'/);
  assert.match(
    supervisor,
    /spotify_minimized" -eq 0 \] && spotify_is_logged_in/,
  );
  assert.match(supervisor, /wmctrl[\s\S]*-b add,hidden/);
  assert.match(supervisor, /trap stop_children EXIT INT TERM\s+start_bridge\s+start_spotify/);
});
