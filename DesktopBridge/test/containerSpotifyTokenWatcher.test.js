const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SESSION_EXPRESSION,
  parseSessionEvaluation,
} = require("../src/containerSpotifyTokenWatcher");

test("container Spotify session evaluation accepts a valid in-memory token", () => {
  const expiresAt = Date.now() + 60 * 60 * 1000;
  assert.deepEqual(
    parseSessionEvaluation({
      result: {
        result: {
          value: { accessToken: "a-valid-container-token-value", expiresAt },
        },
      },
    }),
    { accessToken: "a-valid-container-token-value", expiresAt },
  );
  assert.match(SESSION_EXPRESSION, /Spicetify\?\.Platform/);
  assert.match(SESSION_EXPRESSION, /AuthorizationAPI/);
  assert.doesNotMatch(SESSION_EXPRESSION, /localStorage|sessionStorage|cookie/);
});

test("container Spotify session evaluation rejects expired tokens", () => {
  assert.equal(
    parseSessionEvaluation({
      result: {
        result: {
          value: {
            accessToken: "an-expired-container-token",
            expiresAt: Date.now() - 1,
          },
        },
      },
    }),
    null,
  );
});
