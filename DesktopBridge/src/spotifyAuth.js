const { BrowserWindow, session } = require("electron");

const SPOTIFY_LOGIN_URL = "https://accounts.spotify.com/login";
const SPOTIFY_OPEN_URL = "https://open.spotify.com";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const CDP_CAPTURE_TIMEOUT_MS = 45_000;
const PAGE_EXTRACT_DELAY_MS = 8_000;
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const TOKEN_EXTRACT_SCRIPT = `
(function() {
  try {
    // 1. Check for token in Spotify's session/config script tags
    for (const el of document.querySelectorAll('script')) {
      const text = el.textContent || '';
      if (text.includes('accessToken')) {
        const match = text.match(/"accessToken"\\s*:\\s*"([^"]+)"/);
        if (match && match[1] && match[1].length > 20) {
          const expMatch = text.match(/"accessTokenExpirationTimestampMs"\\s*:\\s*(\\d+)/);
          return JSON.stringify({
            accessToken: match[1],
            accessTokenExpirationTimestampMs: expMatch ? Number(expMatch[1]) : 0,
            source: 'script-tag'
          });
        }
      }
    }
    // 2. Check sessionStorage
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      const val = sessionStorage.getItem(key);
      if (val && val.includes('accessToken')) {
        try {
          const obj = JSON.parse(val);
          if (obj.accessToken && obj.accessToken.length > 20) {
            return JSON.stringify({ ...obj, source: 'sessionStorage' });
          }
        } catch {}
      }
    }
    // 3. Check localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key);
      if (val && val.includes('accessToken')) {
        try {
          const obj = JSON.parse(val);
          if (obj.accessToken && obj.accessToken.length > 20) {
            return JSON.stringify({ ...obj, source: 'localStorage' });
          }
        } catch {}
      }
    }
    return JSON.stringify({ error: 'not-found' });
  } catch(e) {
    return JSON.stringify({ error: e.message });
  }
})()
`;

function parseTokenResult(payload) {
  const token = String(
    payload?.accessToken || payload?.access_token || "",
  ).trim();
  if (!token || token.length < 20) return null;
  const expiresMs = Number(payload?.accessTokenExpirationTimestampMs || 0);
  const expiresAt =
    expiresMs > Date.now() ? expiresMs : Date.now() + 3600 * 1000;
  return { token, expiresAt };
}

/**
 * Attaches CDP to webContents and monitors ALL Spotify JSON network responses
 * for an accessToken field. Also sets a timer to try extracting the token from
 * the page's DOM/storage after the page has loaded.
 */
function captureToken(webContents) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const pendingResponses = new Map();

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(cdpTimer);
      clearTimeout(extractTimer);
      try {
        webContents.debugger.detach();
      } catch { /* ok */ }
      resolve(result);
    };

    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(cdpTimer);
      clearTimeout(extractTimer);
      try {
        webContents.debugger.detach();
      } catch { /* ok */ }
      reject(err);
    };

    const tryExtractFromPage = async () => {
      if (resolved) return;
      try {
        const raw = await webContents.executeJavaScript(TOKEN_EXTRACT_SCRIPT);
        const payload = JSON.parse(raw);
        const result = parseTokenResult(payload);
        if (result) {
          finish(result);
          return;
        }
      } catch { /* page not ready or no token */ }
    };

    const extractTimer = setTimeout(() => {
      void tryExtractFromPage();
    }, PAGE_EXTRACT_DELAY_MS);

    const cdpTimer = setTimeout(async () => {
      if (resolved) return;
      await tryExtractFromPage();
      if (!resolved) {
        fail(
          new Error(
            "Timeout: could not capture Spotify access token within 45s.",
          ),
        );
      }
    }, CDP_CAPTURE_TIMEOUT_MS);

    try {
      webContents.debugger.attach("1.3");
    } catch (err) {
      clearTimeout(cdpTimer);
      clearTimeout(extractTimer);
      reject(new Error(`CDP attach failed: ${err.message}`));
      return;
    }

    webContents.debugger.on("detach", (_event, reason) => {
      if (!resolved) {
        void tryExtractFromPage().then(() => {
          if (!resolved) {
            fail(new Error(`CDP debugger detached: ${reason}`));
          }
        });
      }
    });

    webContents.debugger.on("message", async (_event, method, params) => {
      if (resolved) return;

      if (method === "Network.responseReceived") {
        const url = params?.response?.url || "";
        const status = params?.response?.status || 0;
        const contentType = params?.response?.headers?.["content-type"] ||
          params?.response?.headers?.["Content-Type"] || "";
        const isSpotify = url.includes("spotify.com");
        const isJson = contentType.includes("json");
        const isTokenUrl =
          url.includes("access_token") ||
          url.includes("get_access_token") ||
          url.includes("/auth") ||
          url.includes("/token") ||
          url.includes("/bootstrap");
        if (isSpotify && status === 200 && (isJson || isTokenUrl)) {
          pendingResponses.set(params.requestId, url);
        }
      }

      if (method === "Network.loadingFinished" && pendingResponses.has(params.requestId)) {
        const url = pendingResponses.get(params.requestId);
        pendingResponses.delete(params.requestId);
        try {
          const body = await webContents.debugger.sendCommand(
            "Network.getResponseBody",
            { requestId: params.requestId },
          );
          const text = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString("utf8")
            : body.body;
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            return;
          }
          const result = parseTokenResult(payload);
          if (result) {
            finish(result);
          }
        } catch {
          /* response body unavailable — skip */
        }
      }
    });

    webContents.debugger
      .sendCommand("Network.enable")
      .catch((err) => {
        fail(new Error(`CDP Network.enable failed: ${err.message}`));
      });
  });
}

function createSpotifyAuth({ getSpDcCookie, setSpDcCookie }) {
  let accessToken = "";
  let accessTokenExpiresAt = 0;
  let refreshPromise = null;
  let lastError = "";
  let lastForceRefreshAt = 0;
  let interactiveLoginPromise = null;
  let lastInteractiveLoginAt = 0;

  const ensureSessionCookie = async (spDcValue) => {
    if (!spDcValue) return;
    const existing = await session.defaultSession.cookies.get({
      url: "https://open.spotify.com",
      name: "sp_dc",
    });
    if (existing.some((c) => c.value === spDcValue)) return;
    await session.defaultSession.cookies.set({
      url: "https://open.spotify.com",
      name: "sp_dc",
      value: spDcValue,
      domain: ".spotify.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    });
  };

  const exchangeWithHiddenWindow = async (spDcValue) => {
    if (!spDcValue) {
      throw new Error("No sp_dc cookie available.");
    }
    await ensureSessionCookie(spDcValue);
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    win.webContents.setUserAgent(DESKTOP_CHROME_UA);
    try {
      const tokenPromise = captureToken(win.webContents);
      win.loadURL(SPOTIFY_OPEN_URL);
      return await tokenPromise;
    } finally {
      win.destroy();
    }
  };

  return {
    isAuthenticated() {
      return Boolean(getSpDcCookie());
    },

    async getAccessToken(options = {}) {
      const forceRefresh = Boolean(options?.forceRefresh);
      const interactiveOnFailure = Boolean(options?.interactiveOnFailure);
      if (
        !forceRefresh &&
        accessToken &&
        accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS
      ) {
        return accessToken;
      }
      const spDc = getSpDcCookie();
      if (!spDc) {
        if (!interactiveOnFailure) {
          return "";
        }
        // No session cookie: interactive login is the only recovery.
        if (!interactiveLoginPromise) {
          const now = Date.now();
          if (now - lastInteractiveLoginAt < 3000) {
            return "";
          }
          lastInteractiveLoginAt = now;
          interactiveLoginPromise = this.startLogin()
            .catch((err) => {
              throw err;
            })
            .finally(() => {
              interactiveLoginPromise = null;
            });
        }
        await interactiveLoginPromise;
        return this.getAccessToken({ forceRefresh: true, interactiveOnFailure: false });
      }
      if (refreshPromise) {
        return refreshPromise;
      }
      if (forceRefresh) {
        // Prevent stampeding refresh loops if multiple callers force refresh at once.
        const now = Date.now();
        if (now - lastForceRefreshAt < 1500) {
          // Let the next normal cycle handle it; still return any in-flight refresh.
        } else {
          lastForceRefreshAt = now;
        }
        accessToken = "";
        accessTokenExpiresAt = 0;
      }
      refreshPromise = exchangeWithHiddenWindow(spDc)
        .then((result) => {
          accessToken = result.token;
          accessTokenExpiresAt = result.expiresAt;
          lastError = "";
          return accessToken;
        })
        .catch((error) => {
          accessToken = "";
          accessTokenExpiresAt = 0;
          lastError =
            error instanceof Error ? error.message : String(error);
          if (!interactiveOnFailure) {
            throw error;
          }
          // Silent refresh failed: fall back to interactive login (debounced).
          if (!interactiveLoginPromise) {
            const now = Date.now();
            if (now - lastInteractiveLoginAt < 3000) {
              throw error;
            }
            lastInteractiveLoginAt = now;
            interactiveLoginPromise = this.startLogin()
              .catch((err) => {
                throw err;
              })
              .finally(() => {
                interactiveLoginPromise = null;
              });
          }
          return interactiveLoginPromise.then(() =>
            this.getAccessToken({ forceRefresh: true, interactiveOnFailure: false }),
          );
        })
        .finally(() => {
          refreshPromise = null;
        });
      return refreshPromise;
    },

    startLogin() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const authWindow = new BrowserWindow({
          width: 1280,
          height: 720,
          show: true,
          autoHideMenuBar: true,
          title: "Sign in to Spotify",
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });
        authWindow.webContents.setUserAgent(DESKTOP_CHROME_UA);

        let captureStarted = false;
        let capturePromise = null;
        let cookieSaved = false;
        let webPlayerNavigationTriggered = false;
        let cookiePollTimer = null;

        const saveCookie = async () => {
          if (cookieSaved) return;
          try {
            const cookies =
              await authWindow.webContents.session.cookies.get({
                name: "sp_dc",
              });
            const spDcCookie = cookies.find(
              (c) =>
                c.name === "sp_dc" &&
                c.value &&
                c.domain &&
                c.domain.includes("spotify"),
            );
            if (spDcCookie?.value) {
              cookieSaved = true;
              setSpDcCookie(spDcCookie.value);
            }
          } catch {
            /* best-effort */
          }
        };

        const tryNavigateToWebPlayer = async () => {
          if (settled || webPlayerNavigationTriggered) {
            return;
          }
          await saveCookie();
          if (!cookieSaved) {
            return;
          }
          const currentUrl = String(authWindow.webContents.getURL() || "");
          if (currentUrl.startsWith(SPOTIFY_OPEN_URL)) {
            return;
          }
          webPlayerNavigationTriggered = true;
          try {
            await authWindow.loadURL(SPOTIFY_OPEN_URL);
          } catch {
            // Navigation failures are non-fatal; token capture can still succeed via cookie.
          }
        };

        const startCapture = () => {
          if (captureStarted || settled) return;
          captureStarted = true;
          capturePromise = captureToken(authWindow.webContents)
            .then(async (result) => {
              if (settled) return;
              settled = true;
              if (cookiePollTimer) {
                clearInterval(cookiePollTimer);
                cookiePollTimer = null;
              }
              await saveCookie();

              accessToken = result.token;
              accessTokenExpiresAt = result.expiresAt;
              lastError = "";

              authWindow.close();
              resolve({ ok: true });
            })
            .catch(async (err) => {
              if (settled) return;
              await saveCookie();
              lastError =
                err instanceof Error ? err.message : String(err);

              if (cookieSaved) {
                settled = true;
                if (cookiePollTimer) {
                  clearInterval(cookiePollTimer);
                  cookiePollTimer = null;
                }
                try {
                  const result = await exchangeWithHiddenWindow(
                    getSpDcCookie(),
                  );
                  accessToken = result.token;
                  accessTokenExpiresAt = result.expiresAt;
                  lastError = "";
                } catch (retryErr) {
                  lastError =
                    retryErr instanceof Error
                      ? retryErr.message
                      : String(retryErr);
                }
                authWindow.close();
                resolve({ ok: true });
              }
            });
        };

        // Some Spotify login flows present a "Open Web Player" button that uses window.open.
        // Intercept that and navigate in the same auth window so we can capture the token.
        authWindow.webContents.setWindowOpenHandler(({ url }) => {
          const nextUrl = String(url || "");
          if (nextUrl.startsWith(SPOTIFY_OPEN_URL)) {
            webPlayerNavigationTriggered = true;
            void authWindow.loadURL(nextUrl).catch(() => {});
            return { action: "deny" };
          }
          if (nextUrl.startsWith("https://accounts.spotify.com")) {
            void authWindow.loadURL(nextUrl).catch(() => {});
            return { action: "deny" };
          }
          return { action: "allow" };
        });

        authWindow.webContents.on("did-navigate", (_event, navUrl) => {
          if (navUrl.startsWith("https://open.spotify.com")) {
            startCapture();
            return;
          }
          // If login completes but Spotify doesn't auto-redirect, we still want to
          // move to open.spotify.com once the session cookie exists.
          void tryNavigateToWebPlayer();
        });

        authWindow.webContents.on("did-finish-load", () => {
          void tryNavigateToWebPlayer();
        });

        authWindow.on("closed", () => {
          if (!settled) {
            settled = true;
            if (cookiePollTimer) {
              clearInterval(cookiePollTimer);
              cookiePollTimer = null;
            }
            void saveCookie().then(() => {
              if (cookieSaved) {
                exchangeWithHiddenWindow(getSpDcCookie())
                  .then((result) => {
                    accessToken = result.token;
                    accessTokenExpiresAt = result.expiresAt;
                    lastError = "";
                    resolve({ ok: true });
                  })
                  .catch((err) => {
                    lastError =
                      err instanceof Error ? err.message : String(err);
                    resolve({ ok: true });
                  });
              } else {
                reject(new Error("Spotify login window was closed."));
              }
            });
          }
        });

        // Poll for session cookie creation so we can auto-navigate even if Spotify
        // stays on accounts.spotify.com after login.
        cookiePollTimer = setInterval(() => {
          void tryNavigateToWebPlayer();
        }, 650);

        authWindow.loadURL(SPOTIFY_LOGIN_URL);
      });
    },

    logout() {
      accessToken = "";
      accessTokenExpiresAt = 0;
      lastError = "";
      setSpDcCookie("");
      session.defaultSession.cookies
        .remove("https://open.spotify.com", "sp_dc")
        .catch(() => {});
    },

    getStatus() {
      const spDc = getSpDcCookie();
      const hasSession = Boolean(spDc);
      const hasAccess = Boolean(
        accessToken && accessTokenExpiresAt > Date.now(),
      );
      return {
        spotifyAuthenticated: hasSession,
        spotifyAccessTokenValid: hasAccess,
        spotifyAccessTokenExpiresAt: accessTokenExpiresAt,
        spotifyAuthError: lastError,
      };
    },
  };
}

module.exports = { createSpotifyAuth };
