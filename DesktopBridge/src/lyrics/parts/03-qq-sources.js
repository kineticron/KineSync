"use strict";

// QQ Music legacy, direct musicu, jsososo mirror, open API fallback, and Meting source adapters.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

function decodeUriComponentSafe(value) {
  try {
    const decoded = decodeURIComponent(String(value || ""));
    return decoded;
  } catch {
    return String(value || "");
  }
}

function decodeQQBase64Text(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (
    !compact ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    return "";
  }
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    if (!decoded || decoded.includes("\u0000")) {
      return "";
    }
    return decoded;
  } catch {
    return "";
  }
}

function decodeQQBase64EncryptedText(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return "";
  }
  try {
    const encrypted = Buffer.from(compact, "base64");
    if (!encrypted.length || encrypted.length % 8 !== 0) {
      return "";
    }
    return qqKaraokeDecryptHex(encrypted.toString("hex"));
  } catch {
    return "";
  }
}

function looksLikeQQKaraokeLyrics(value) {
  const text = String(value || "");
  return (
    /<Lyric_\d+\b/i.test(text) ||
    /LyricContent\s*=/i.test(text) ||
    /^\s*\[(?:\d{2}:\d{2}|\d+,\d+)\]/m.test(text) ||
    /\(\d+,\d+(?:,[^)]*)?\)/.test(text)
  );
}

function decodeQQKaraokePayload(rawPayload) {
  const raw = String(rawPayload || "").trim();
  if (!raw) {
    return "";
  }
  const candidates = [];
  const seen = new Set();
  const addCandidate = (value) => {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    candidates.push(text);
  };

  addCandidate(raw);
  addCandidate(decodeQQBase64Text(raw));
  addCandidate(decodeQQBase64EncryptedText(raw));

  // QQ legacy lyric_download still returns encrypted hex, while musicu with
  // crypt: 0 can return plaintext/base64 QRC. Try encrypted hex after the
  // direct candidates so plaintext QRC is not mangled before parsing.
  if (/^(?:[0-9a-f]{2})+$/i.test(raw)) {
    const decrypted = qqKaraokeDecryptHex(raw);
    addCandidate(decrypted);
    addCandidate(decodeQQBase64Text(decrypted));
  }

  let fallbackBody = "";
  for (const candidate of candidates) {
    const body = extractKaraokeBody(candidate);
    if (!body) {
      continue;
    }
    if (!fallbackBody) {
      fallbackBody = body;
    }
    if (looksLikeQQKaraokeLyrics(candidate) || looksLikeQQKaraokeLyrics(body)) {
      return body;
    }
  }
  return fallbackBody;
}
function getQqCandidateDurationMs(getSongInterval, song) {
  const interval = Number(getSongInterval(song) || 0);
  if (interval <= 0) {
    return 0;
  }
  return interval < 1_000 ? interval * 1000 : interval;
}

function filterLikelyQqRankedCandidates(
  track,
  ranked,
  getSongTitle,
  getSongArtist,
  getSongInterval,
) {
  const { recordingIdentityMatches } = require("./lyricsRecordingIdentity");
  const strict = ranked.filter(candidate => recordingIdentityMatches(track,
    getSongTitle(candidate.song), getSongArtist(candidate.song), getQqCandidateDurationMs(getSongInterval, candidate.song)));
  if (strict.length) return strict;
  return filterLikelySameTrackCandidates(track, ranked, {
    getTitle: (candidate) => getSongTitle(candidate.song),
    getArtist: (candidate) => getSongArtist(candidate.song),
    getDurationMs: (candidate) =>
      getQqCandidateDurationMs(getSongInterval, candidate.song),
    getScore: (candidate) => candidate.score,
  });
}

function normalizeLegacyXmlText(value) {
  const decoded = decodeUriComponentSafe(value);
  return String(decoded || "")
    .replace(/^<!\[CDATA\[/i, "")
    .replace(/\]\]>$/i, "")
    .replace(/\+/g, " ")
    .trim();
}

function extractLegacySearchSongs(xmlText) {
  const songs = [];
  const regex = /<songinfo\b[^>]*id="(\d+)"[^>]*>([\s\S]*?)<\/songinfo>/g;
  let match;
  while ((match = regex.exec(String(xmlText || ""))) !== null) {
    const songId = Number(match[1] || 0);
    const content = match[2] || "";
    const nameRaw = content.match(/<name>([\s\S]*?)<\/name>/)?.[1] || "";
    const singerRaw =
      content.match(/<singername>([\s\S]*?)<\/singername>/)?.[1] || "";
    const albumRaw =
      content.match(/<albumname>([\s\S]*?)<\/albumname>/)?.[1] || "";
    const intervalRaw =
      content.match(/<interval>([\s\S]*?)<\/interval>/)?.[1] || "";
    songs.push({
      songid: songId,
      songname: normalizeLegacyXmlText(nameRaw),
      singername: normalizeLegacyXmlText(singerRaw),
      albumname: normalizeLegacyXmlText(albumRaw),
      interval: Number(intervalRaw || 0),
    });
  }
  return songs;
}

function extractLegacyLyricFields(xmlText) {
  const cleaned = String(xmlText || "")
    .replace(/<!--/g, "")
    .replace(/-->/g, "");
  const readTag = (tag) =>
    (
      cleaned.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`))
        ?.[1] || ""
    ).trim();
  return [
    readTag("content"),
    readTag("contentts"),
    readTag("contentroma"),
  ].filter(Boolean);
}

async function fetchQQText(url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "KineSyncDesktopBridge/1.0",
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Keep the abort timer active while the XML or lyric body is read.
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function createQQRequestOperation() {
  const requests = new Map();
  const waiting = [];
  let active = 0;
  let lastRequestError = null;
  const sortedEntries = object => Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b));

  function request(kind, endpoint, options = {}, body) {
    const params = Object.fromEntries(sortedEntries(options.params));
    const headers = sortedEntries(options.headers).map(([name, value]) => [name.toLowerCase(), value]);
    const url = buildUrlWithParams(endpoint, params);
    const key = JSON.stringify([kind, url, headers, body]);
    if (requests.has(key)) return requests.get(key);
    const timeoutMs = Math.min(options.timeoutMs ?? 8_000, 5_000);
    const transport = { headers: options.headers, timeoutMs };

    const pending = new Promise((resolve, reject) => {
      const start = async () => {
        active++;
        try {
          const result = kind === "post" ? await fetchJsonPost(url, body, transport)
            : kind === "text" ? await fetchQQText(url, transport)
              : await fetchJson(endpoint, { ...transport, params });
          resolve(result);
        } catch (error) {
          // Keep failures for this operation. A later track or refresh retries.
          if (!/^HTTP 404\b/.test(String(error?.message || ""))) lastRequestError = error;
          reject(error);
        } finally {
          active--;
          waiting.shift()?.();
        }
      };
      if (active < 6) void start();
      else waiting.push(start);
    });
    requests.set(key, pending);
    return pending;
  }
  async function any(kind, endpoints, options, body) {
    const start = endpoint => request(kind, endpoint, options, body)
      .then(value => ({ value }), error => ({ error }));
    // Keep the primary Musicu response authoritative and avoid contacting its
    // alternate host on successful searches and downloads.
    const pending = kind === "post" ? endpoints : endpoints.map(start);
    let lastError;
    for (const endpoint of pending) {
      const result = await (kind === "post" ? start(endpoint) : endpoint);
      if (!result.error) return result.value;
      lastError = result.error;
    }
    throw lastError || new Error("All QQ endpoints failed");
  }
  return {
    get lastRequestError() { return lastRequestError; },
    json: (endpoint, options) => request("json", endpoint, options),
    text: (endpoint, options) => request("text", endpoint, options),
    anyJson: (endpoints, options) => any("json", endpoints, options),
    anyText: (endpoints, options) => any("text", endpoints, options),
    anyPost: (endpoints, body, options) => any("post", endpoints, options, body),
    mirror: (path, options) => any("json", JSOSOSO_BASE_URLS.map(base => `${base}${path}`), options),
  };
}

async function fetchFromQQLegacyDownload(track, operation = createQQRequestOperation()) {
  const rankedSongs = [];
  await Promise.all(buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS).map(async query => {
    try {
      const searchXml = await operation.anyText(
        QQ_LEGACY_SEARCH_ENDPOINTS,
        {
          params: {
            SONGNAME: query,
            SINGERNAME: track.artist,
            TYPE: "2",
            RANGE_MIN: "1",
            RANGE_MAX: "40",
          },
          timeoutMs: 12_000,
          headers: {
            Referer: "https://y.qq.com/",
            Origin: "https://y.qq.com",
          },
        },
      );
      rankedSongs.push(...extractLegacySearchSongs(searchXml));
    } catch {
      // Try next query variant.
    }
  }));

  const seenSongIds = new Set();
  const ranked = rankedSongs
    .filter((song) => {
      const id = Number(song.songid || 0);
      if (!id || seenSongIds.has(id)) {
        return false;
      }
      seenSongIds.add(id);
      return true;
    })
    .map((song) => ({
      song,
      score: scoreCandidate(track, song.songname || "", song.singername || ""),
    }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return null;
  }

  let best = null;
  let bestScore = -1;

  const likelyLegacyCandidates = filterLikelyQqRankedCandidates(
    track,
    ranked,
    (song) => song.songname || "",
    (song) => song.singername || "",
    (song) => Number(song.interval || 0),
  )
    .map((candidate) => ({
      ...candidate,
      candidateTitle: candidate.song.songname || "",
      candidateArtist: candidate.song.singername || "",
    }))
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, MAX_QQ_LEGACY_CANDIDATES);

  let bestLegacySelection = null;

  const downloads = likelyLegacyCandidates.map(candidate =>
    operation.anyText(QQ_LEGACY_DOWNLOAD_ENDPOINTS, {
      params: {
        version: "15", miniversion: "82", lrctype: "4",
        musicid: String(candidate.song.songid),
      },
      timeoutMs: 12_000,
      headers: { Referer: "https://y.qq.com/", Origin: "https://y.qq.com" },
    }).catch(() => ""));
  for (const [index, candidate] of likelyLegacyCandidates.entries()) {
    try {
      const xml = await downloads[index];
      const fields = extractLegacyLyricFields(xml);
      for (const encryptedHex of fields) {
        const karaokeBody = decodeQQKaraokePayload(encryptedHex);
        if (!karaokeBody) {
          continue;
        }
        const lyrics = parseLrc(karaokeBody);
        if (!lyrics.length) {
          continue;
        }
        const coverage = scoreLyricsCoverage(lyrics, track.durationMs);
        const selection = {
          title: candidate.song.songname || "",
          artist: candidate.song.singername || "",
          durationMs: 0,
          searchScore: candidate.score,
        };
        if (
          !bestLegacySelection ||
          shouldPreferLyricsCandidate(
            track,
            bestLegacySelection,
            selection,
            bestScore,
            coverage,
          )
        ) {
          bestLegacySelection = selection;
          bestScore = coverage;
          best = { lyrics, source: "qq-legacy-lyric_download-qrc" };
        }
      }
    } catch {
      // Try next legacy candidate.
    }
  }

  return best;
}

async function fetchQQDesktopSearchSongs(query, operation = createQQRequestOperation()) {
  const body = {
    comm: {
      cv: 4747474,
      ct: 24,
      format: "json",
      inCharset: "utf-8",
      outCharset: "utf-8",
      platform: "yqq.json",
      needNewCode: 1,
    },
    "music.search.SearchCgiService": {
      method: "DoSearchForQQMusicDesktop",
      module: "music.search.SearchCgiService",
      param: {
        query,
        page_num: 1,
        num_per_page: 30,
        search_type: 0,
      },
    },
  };

  const payload = await operation.anyPost(
    QQ_MUSICU_ENDPOINTS,
    body,
    {
      timeoutMs: 10_000,
      headers: {
        Referer: "https://y.qq.com/",
        Origin: "https://y.qq.com",
      },
    },
  );
  const list =
    payload?.["music.search.SearchCgiService"]?.data?.body?.song?.list ||
    payload?.["music.search.SearchCgiService"]?.data?.song?.list ||
    [];
  return Array.isArray(list) ? list : [];
}

function createQQDirectSongAccessors() {
  const getSongMid = (song) =>
    song?.songmid || song?.mid || song?.track_mid || "";
  const getSongId = (song) =>
    Number(song?.songid || song?.id || song?.track_id || 0);
  const getSongTitle = (song) =>
    song?.songname || song?.name || song?.title || "";
  const getSongArtist = (song) => {
    if (Array.isArray(song?.singer)) {
      return song.singer.map((s) => s?.name || "").join(" ");
    }
    return song?.singer_name || song?.singer || song?.artist || "";
  };
  const getSongInterval = (song) => Number(song?.interval || song?.duration || 0);
  return { getSongMid, getSongId, getSongTitle, getSongArtist, getSongInterval };
}

async function collectQQSongsFromDesktopSearch(queryVariants, requests = new Map(), operation = createQQRequestOperation()) {
  const desktopSongs = [];
  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        if (!requests.has(query)) requests.set(query, fetchQQDesktopSearchSongs(query, operation));
        desktopSongs.push(...(await requests.get(query)));
      } catch {
        // Try next query variant.
      }
    }),
  );
  return desktopSongs;
}

async function collectQQSongsFromLegacyClientSearch(queryVariants, operation = createQQRequestOperation()) {
  const legacySongs = [];
  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const searchData = await operation.anyJson(QQ_SEARCH_ENDPOINTS, {
          params: { p: 1, n: 60, w: query, format: "json" },
          timeoutMs: 8_000,
          headers: {
            Referer: "https://y.qq.com/",
            Origin: "https://y.qq.com",
          },
        });
        const searchSongs =
          searchData?.data?.song?.list || searchData?.data?.list || [];
        legacySongs.push(...(Array.isArray(searchSongs) ? searchSongs : []));
      } catch {
        // Try next query variant.
      }
    }),
  );
  return legacySongs;
}

function rankQQDirectSearchSongs(track, songs, accessors) {
  const { getSongMid, getSongTitle, getSongArtist, getSongInterval } = accessors;
  const seen = new Set();
  const deduped = songs.filter((song) => {
    const mid = getSongMid(song);
    if (!mid || seen.has(mid)) {
      return false;
    }
    seen.add(mid);
    return true;
  });

  return deduped
    .map((song) => {
      const title = getSongTitle(song);
      const artist = getSongArtist(song);
      let score = scoreCandidate(track, title, artist);
      const interval = getSongInterval(song);
      const candidateDurationMs =
        interval > 0 ? (interval < 1_000 ? interval * 1000 : interval) : 0;
      score += scoreDurationBonus(track, title, artist, candidateDurationMs);
      return { song, score };
    })
    .sort((a, b) => b.score - a.score);
}

function qqDirectSearchNeedsLegacySupplement(track, ranked, accessors) {
  const { getSongTitle, getSongArtist, getSongInterval } = accessors;
  if (!ranked.length) {
    return true;
  }
  if (isAmbiguousTopMatch(ranked)) {
    return true;
  }
  const likelyCandidates = filterLikelyQqRankedCandidates(
    track,
    ranked,
    getSongTitle,
    getSongArtist,
    getSongInterval,
  );
  if (!likelyCandidates.length) {
    return true;
  }
  const topScore = Number(ranked[0]?.score || 0);
  if (topScore < MATCH_ACCEPTANCE_THRESHOLD) {
    return true;
  }
  if (
    trackNeedsFeaturedVariantVerification(track) &&
    topScore < MATCH_CONFIDENCE_SCORE
  ) {
    return true;
  }
  return false;
}

function createRankedProbePool(items, limit, mapper) {
  const slots = items.map(() => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  });
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      let result = null;
      try { result = await mapper(items[index], index); } catch { /* Preserve per-candidate fallback. */ }
      slots[index].resolve(result);
    }
  };
  for (let index = 0; index < Math.min(Math.max(1, limit), items.length); index += 1) worker();
  return {
    read: index => slots[index].promise,
    stop() {
      stopped = true;
      while (next < slots.length) slots[next++].resolve(null);
    },
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  );
  return results;
}

function rankVerifiedQQSongs(track, songs, accessors, verifyRecording) {
  const verified = reconcileRecordingAliasRows(songs, accessors.getSongMid,
    song => verifyRecording(song, accessors));
  return rankQQDirectSearchSongs(track, verified, accessors);
}

async function searchQQFeaturedDesktopSongPool(track, operation, verifyRecording) {
  const accessors = createQQDirectSongAccessors();
  const queries = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const songs = await collectQQSongsFromDesktopSearch(queries, new Map(), operation);
  return { ranked: rankVerifiedQQSongs(track, songs, accessors, verifyRecording), accessors };
}

async function searchQQDirectSongPool(track, verifyRecording = null, operation = createQQRequestOperation()) {
  const accessors = createQQDirectSongAccessors();
  const allQueryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const desktopRequests = new Map();
  // Search variants and the legacy supplement are independent. Start the same
  // bounded query set once, while retaining the original supplement decision.
  const desktopSearch = collectQQSongsFromDesktopSearch(allQueryVariants, desktopRequests, operation);
  const legacySearch = collectQQSongsFromLegacyClientSearch(allQueryVariants, operation);
  let songs;
  if (verifyRecording || trackNeedsFeaturedVariantVerification(track)) {
    // Verified aliases require the union of both catalogs. A legacy row can
    // invalidate a Musicu MID even when its own lyric payload is unusable.
    const [desktopSongs, legacySongs] = await Promise.all([desktopSearch, legacySearch]);
    songs = [...desktopSongs, ...legacySongs];
  } else {
    songs = await (desktopRequests.get(allQueryVariants[0]) || Promise.resolve([])).catch(() => []);
    const initialRanked = rankQQDirectSearchSongs(track, songs, accessors);
    if (qqDirectSearchNeedsLegacySupplement(track, initialRanked, accessors)) {
      const [desktopSongs, legacySongs] = await Promise.all([desktopSearch, legacySearch]);
      songs = [...desktopSongs, ...legacySongs];
    }
  }
  const ranked = verifyRecording
    ? rankVerifiedQQSongs(track, songs, accessors, verifyRecording)
    : rankQQDirectSearchSongs(track, songs, accessors);
  return { ranked, accessors };
}

async function resolveQQLegacyDownloadFallback(track, operation = createQQRequestOperation()) {
  try {
    return await fetchFromQQLegacyDownload(track, operation);
  } catch {
    return null;
  }
}

function createQQDirectAggregateState(track, seededKaraokeResult = null) {
  const seededKaraokeCoverageScore = seededKaraokeResult?.lyrics?.length
    ? scoreLyricsCoverage(seededKaraokeResult.lyrics, track.durationMs)
    : -1;
  const seededSelection = seededKaraokeResult?.lyrics?.length
    ? {
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs,
        searchScore: MATCH_CONFIDENCE_SCORE,
      }
    : null;
  return {
    bestResult: seededKaraokeResult,
    bestCoverageScore: seededKaraokeCoverageScore,
    bestSelection: seededSelection,
    bestKaraokeResult: seededKaraokeResult,
    bestKaraokeCoverageScore: seededKaraokeCoverageScore,
    bestKaraokeSelection: seededSelection,
  };
}

function applyQQDirectCandidateProbe(track, state, candidate, probe) {
  if (!probe) {
    return;
  }
  const { selection, karaokeResult, directResult } = probe;
  if (karaokeResult?.lyrics?.length) {
    if (
      !state.bestSelection ||
      shouldPreferLyricsCandidate(
        track,
        state.bestSelection,
        selection,
        state.bestCoverageScore,
        karaokeResult.coverage,
      )
    ) {
      state.bestSelection = selection;
      state.bestCoverageScore = karaokeResult.coverage;
      state.bestResult = {
        lyrics: karaokeResult.lyrics,
        source: "qq-musicu-qrc",
      };
    }
    if (
      !state.bestKaraokeSelection ||
      shouldPreferLyricsCandidate(
        track,
        state.bestKaraokeSelection,
        selection,
        state.bestKaraokeCoverageScore,
        karaokeResult.coverage,
      )
    ) {
      state.bestKaraokeSelection = selection;
      state.bestKaraokeCoverageScore = karaokeResult.coverage;
      state.bestKaraokeResult = {
        lyrics: karaokeResult.lyrics,
        source: "qq-musicu-qrc",
      };
    }
  }
  if (directResult?.lyrics?.length) {
    if (
      !state.bestSelection ||
      shouldPreferLyricsCandidate(
        track,
        state.bestSelection,
        selection,
        state.bestCoverageScore,
        directResult.coverage,
      )
    ) {
      state.bestSelection = selection;
      state.bestCoverageScore = directResult.coverage;
      state.bestResult = {
        lyrics: directResult.lyrics,
        source: "qq-music-direct",
      };
    }
  }
}

function shouldEarlyExitQQDirectCandidate(
  track,
  candidate,
  selection,
  coverageRatio,
  bestSelection,
) {
  if (candidate.score < MATCH_CONFIDENCE_SCORE) {
    return false;
  }
  if (coverageRatio < EARLY_RETURN_COVERAGE_RATIO) {
    return false;
  }
  return (
    computeCandidateMatchRank(
      track,
      selection.title,
      selection.artist,
      selection.durationMs,
      candidate.score,
    ) >=
    computeCandidateMatchRank(
      track,
      bestSelection?.title || "",
      bestSelection?.artist || "",
      bestSelection?.durationMs || 0,
      bestSelection?.searchScore || 0,
    ) -
      1
  );
}

async function probeQQDirectCandidate(track, candidate, accessors, operation = createQQRequestOperation()) {
  const { getSongMid, getSongId, getSongTitle, getSongArtist, getSongInterval } =
    accessors;
  const songMid = getSongMid(candidate.song);
  const songId = getSongId(candidate.song);
  if (!songMid) {
    return null;
  }
  const candidateTitle = getSongTitle(candidate.song);
  const candidateArtist = getSongArtist(candidate.song);
  const interval = getSongInterval(candidate.song);
  const candidateDurationMs =
    interval > 0 && interval < 1_000 ? interval * 1000 : interval;
  const selection = {
    title: candidateTitle,
    artist: candidateArtist,
    durationMs: candidateDurationMs,
    searchScore: candidate.score,
  };
  const probe = {
    selection,
    karaokeResult: null,
    directResult: null,
    earlyExit: null,
  };

  try {
    const musicuData = await operation.anyPost(
      QQ_MUSICU_ENDPOINTS,
      {
        comm: {
          cv: 4747474,
          ct: 24,
          format: "json",
          inCharset: "utf-8",
          outCharset: "utf-8",
          platform: "yqq.json",
          needNewCode: 1,
        },
        req_1: {
          module: "music.musichallSong.PlayLyricInfo",
          method: "GetPlayLyricInfo",
          param: {
            songMID: songMid,
            songID: songId,
            qrc: 1,
            trans: 1,
            roma: 1,
            crypt: 0,
          },
        },
      },
      {
        timeoutMs: QQ_DIRECT_LYRIC_FETCH_TIMEOUT_MS,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      },
    );
    const karaokeBody = decodeQQKaraokePayload(
      musicuData?.req_1?.data?.lyric || "",
    );
    const karaokeLyrics = stripLeadingMetadataLines(
      trimLeadingMetaLines(
        parseLrc(karaokeBody),
        Number(musicuData?.req_1?.data?.startTs || 0),
      ),
      track,
    );
    if (karaokeLyrics.length) {
      const coverage = scoreLyricsCoverage(karaokeLyrics, track.durationMs);
      const coverageRatio = getLyricsCoverageRatio(
        karaokeLyrics,
        track.durationMs,
      );
      probe.karaokeResult = { lyrics: karaokeLyrics, coverage, coverageRatio };
    }
  } catch {
    // Try standard lyric endpoint below for confident matches.
  }

  if (!probe.karaokeResult && candidate.score >= MATCH_CONFIDENCE_SCORE) {
    try {
      const lyricData = await operation.anyJson(QQ_LYRIC_ENDPOINTS, {
        params: {
          format: "json",
          nobase64: 1,
          songmid: songMid,
        },
        timeoutMs: QQ_DIRECT_LYRIC_FETCH_TIMEOUT_MS,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      });
      const rawTimedLyrics = lyricData?.qrc || lyricData?.lyric || "";
      const lyrics = parseLrc(
        decodeQQKaraokePayload(rawTimedLyrics) || String(rawTimedLyrics),
      );
      if (lyrics.length) {
        const coverage = scoreLyricsCoverage(lyrics, track.durationMs);
        const coverageRatio = getLyricsCoverageRatio(lyrics, track.durationMs);
        probe.directResult = { lyrics, coverage, coverageRatio };
      }
    } catch {
      // No lyrics for this candidate.
    }
  }

  return probe;
}

async function fetchQQDirectCandidateLyricsParallel(
  track,
  likelyDirectCandidates,
  accessors,
  seededKaraokeResult = null,
  operation = createQQRequestOperation(),
) {
  const state = createQQDirectAggregateState(track, seededKaraokeResult);
  const candidatesToProbe = likelyDirectCandidates.slice(
    0,
    QQ_DIRECT_CANDIDATE_PROBE_CAP,
  );
  const shared = { earlyExit: null };

  const considerProbe = (candidate, probe) => {
    if (!probe || shared.earlyExit) {
      return;
    }
    applyQQDirectCandidateProbe(track, state, candidate, probe);
    if (
      probe.karaokeResult &&
      shouldEarlyExitQQDirectCandidate(
        track,
        candidate,
        probe.selection,
        probe.karaokeResult.coverageRatio,
        state.bestSelection,
      )
    ) {
      shared.earlyExit = {
        lyrics: probe.karaokeResult.lyrics,
        source: "qq-musicu-qrc",
      };
      return;
    }
    // Do not early-exit on the plain direct LRC result. Later candidates may
    // still have QQ QRC karaoke lyrics, and QRC is the preferred QQ payload.
  };

  const topCandidate = candidatesToProbe[0];
  const runnerUpCandidate = candidatesToProbe[1];
  const topCandidateIsClearWinner =
    topCandidate &&
    topCandidate.score >= MATCH_CONFIDENCE_SCORE &&
    (!runnerUpCandidate ||
      topCandidate.score - runnerUpCandidate.score >= 1.5);
  if (topCandidateIsClearWinner) {
    considerProbe(
      topCandidate,
      await probeQQDirectCandidate(track, topCandidate, accessors, operation),
    );
  }

  if (shared.earlyExit) {
    return { earlyExit: shared.earlyExit, state };
  }

  const remainingCandidates = topCandidateIsClearWinner
    ? candidatesToProbe.slice(1)
    : candidatesToProbe;

  await mapWithConcurrency(
    remainingCandidates,
    QQ_DIRECT_CANDIDATE_PARALLELISM,
    async (candidate) => {
      if (shared.earlyExit) {
        return;
      }
      const probe = await probeQQDirectCandidate(track, candidate, accessors, operation);
      considerProbe(candidate, probe);
    },
  );

  if (shared.earlyExit) {
    return { earlyExit: shared.earlyExit, state };
  }
  return { earlyExit: null, state };
}

function resolveQQDirectAggregatedResults(track, state) {
  const { bestResult, bestKaraokeResult } = state;

  if (bestKaraokeResult?.lyrics?.length) {
    return bestKaraokeResult;
  }
  return bestResult || null;
}

async function fetchFromQQDirect(track, operation, desktopOnly = false) {
  const verify = desktopOnly ? (song, accessors) => {
    const title = accessors.getSongTitle(song);
    const artist = accessors.getSongArtist(song);
    const durationMs = getQqCandidateDurationMs(accessors.getSongInterval, song);
    const artists = Array.isArray(song.singer)
      ? song.singer.map(singer => String(singer?.name || "").trim()).filter(Boolean)
      : recordingAliasArtistNames(artist);
    const { titleKey } = require("./lyricsRecordingIdentity");
    if (titleKey(track.title) !== titleKey(title) ||
        !recordingAliasCandidateMatches(track, song, title, artists, durationMs)) return null;
    return recordingAliasRowEvidence(song, song, title, artists, durationMs);
  } : null;
  const { ranked, accessors } = verify
    ? await searchQQFeaturedDesktopSongPool(track, operation, verify)
    : await searchQQDirectSongPool(track, null, operation);
  const { getSongTitle, getSongArtist, getSongInterval } = accessors;

  const likelyDirectCandidates = filterLikelyQqRankedCandidates(
    track,
    ranked,
    getSongTitle,
    getSongArtist,
    getSongInterval,
  )
    .map((candidate) => ({
      ...candidate,
      candidateTitle: getSongTitle(candidate.song),
      candidateArtist: getSongArtist(candidate.song),
    }))
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, MAX_QQ_DIRECT_CANDIDATES);

  const parallelFetch = await fetchQQDirectCandidateLyricsParallel(
    track, likelyDirectCandidates, accessors, null, operation,
  );
  if (parallelFetch.earlyExit) {
    return parallelFetch.earlyExit;
  }
  return desktopOnly ? null : resolveQQDirectAggregatedResults(track, parallelFetch.state);
}

async function findQQFallbackLyrics(candidates, probe) {
  const pool = createRankedProbePool(candidates, QQ_DIRECT_CANDIDATE_PARALLELISM, probe);
  try {
    for (let index = 0; index < candidates.length; index++) {
      const result = await pool.read(index);
      if (result) return result;
    }
    return null;
  } finally {
    pool.stop();
  }
}

async function fetchFromQQOpenApiMirrorFallback(track, operation = createQQRequestOperation()) {
  const songs = await collectQQSongsFromLegacyClientSearch(
    buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS), operation,
  );

  if (!songs.length) {
    return null;
  }

  const getSongMid = (song) =>
    song?.songmid || song?.mid || song?.track_mid || "";
  const getSongTitle = (song) =>
    song?.songname || song?.name || song?.title || "";
  const getSongArtist = (song) => {
    if (Array.isArray(song?.singer)) {
      return song.singer.map((s) => s?.name || "").join(" ");
    }
    return song?.singer_name || song?.singer || song?.artist || "";
  };
  const getSongInterval = (song) =>
    Number(song?.interval || song?.duration || 0);

  const seen = new Set();
  const ranked = songs
    .filter((song) => {
      const mid = getSongMid(song);
      if (!mid || seen.has(mid)) {
        return false;
      }
      seen.add(mid);
      return true;
    })
    .map((song) => {
      const title = getSongTitle(song);
      const artist = getSongArtist(song);
      let score = scoreCandidate(track, title, artist);
      const rawDuration = getSongInterval(song);
      const candidateDurationMs =
        rawDuration > 0
          ? rawDuration < 1_000
            ? rawDuration * 1000
            : rawDuration
          : 0;
      score += scoreDurationBonus(track, title, artist, candidateDurationMs);
      return { song, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return null;
  }

  const likelyFallbackCandidates = filterLikelyQqRankedCandidates(
    track,
    ranked,
    getSongTitle,
    getSongArtist,
    getSongInterval,
  ).slice(0, 8);

  const result = await findQQFallbackLyrics(likelyFallbackCandidates, async candidate => {
    const songMid = getSongMid(candidate.song);
    const title = getSongTitle(candidate.song);
    const artist = getSongArtist(candidate.song);
    const interval = getSongInterval(candidate.song);
    const candidateDurationMs =
      interval > 0 && interval < 1_000 ? interval * 1000 : interval;
    if (!songMid || candidate.score < MATCH_ACCEPTANCE_THRESHOLD) {
      return null;
    }

    try {
      const lyricData = await operation.anyJson(QQ_LYRIC_ENDPOINTS, {
        params: {
          format: "json",
          nobase64: 1,
          songmid: songMid,
        },
        timeoutMs: 10_000,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      });
      const rawTimedLyrics = lyricData?.qrc || lyricData?.lyric || "";
      const lyrics = parseLrc(
        decodeQQKaraokePayload(rawTimedLyrics) || String(rawTimedLyrics),
      );
      if (lyrics.length) {
        return { lyrics, source: "qq-music-openapi-fallback" };
      }
    } catch {
      // Try next candidate.
    }
    return null;
  });

  return result;
}

async function fetchFromQQMirror(track, operation = createQQRequestOperation()) {
  const query = `${normalizeText(track.title)} ${normalizeText(track.artist)}`;
  let searchData = null;
  let lastSearchError = null;
  const searches = ["/search/quick", "/search"].map(path =>
    operation.mirror(path, { params: { key: query }, timeoutMs: 12_000 })
      .then(data => ({ data }), error => ({ error })));
  for (const search of searches) {
    const { data, error } = await search;
    if (!error) {
      searchData = data;
      break;
    }
    lastSearchError = error;
  }
  if (!searchData) {
    // JSOSOSO public mirrors are often unstable; fall back to direct QQ open APIs.
    const openApiFallback = await fetchFromQQOpenApiMirrorFallback(track, operation);
    if (openApiFallback) {
      return openApiFallback;
    }
    throw lastSearchError || new Error("jsososo search failed");
  }

  const songs = normalizeJsososoSongs(searchData);
  const ranked = songs
    .map((song) => {
      const title = song?.name || song?.songname || song?.title || "";
      const artist =
        song?.singer || song?.singer_name || song?.artist || song?.author || "";
      let score = scoreCandidate(track, title, artist);
      const rawDuration = Number(song?.interval || song?.duration || 0);
      const candidateDurationMs =
        rawDuration > 0
          ? rawDuration < 1_000
            ? rawDuration * 1000
            : rawDuration
          : 0;
      score += scoreDurationBonus(track, title, artist, candidateDurationMs);
      return { song, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return null;
  }

  const likelyMirrorCandidates = filterLikelySameTrackCandidates(track, ranked, {
    getTitle: (candidate) =>
      candidate.song?.name ||
      candidate.song?.songname ||
      candidate.song?.title ||
      "",
    getArtist: (candidate) =>
      candidate.song?.singer ||
      candidate.song?.singer_name ||
      candidate.song?.artist ||
      candidate.song?.author ||
      "",
    getDurationMs: (candidate) => {
      const rawDuration = Number(
        candidate.song?.interval || candidate.song?.duration || 0,
      );
      return rawDuration > 0 && rawDuration < 1_000
        ? rawDuration * 1000
        : rawDuration;
    },
    getScore: (candidate) => candidate.score,
  }).slice(0, 6);

  const result = await findQQFallbackLyrics(likelyMirrorCandidates, async candidate => {
    const candidateId =
      candidate.song?.id ||
      candidate.song?.songid ||
      candidate.song?.songId ||
      "";
    const songmid =
      candidate.song?.mid ||
      candidate.song?.songmid ||
      candidate.song?.songMid ||
      "";
    const candidateTitle =
      candidate.song?.name ||
      candidate.song?.songname ||
      candidate.song?.title ||
      "";
    const candidateArtist =
      candidate.song?.singer ||
      candidate.song?.singer_name ||
      candidate.song?.artist ||
      candidate.song?.author ||
      "";
    const rawDuration = Number(
      candidate.song?.interval || candidate.song?.duration || 0,
    );
    const candidateDurationMs =
      rawDuration > 0 && rawDuration < 1_000 ? rawDuration * 1000 : rawDuration;
    if (!songmid || candidate.score < MATCH_ACCEPTANCE_THRESHOLD) {
      return null;
    }
    try {
      const lyricData = await operation.mirror(
        "/lyric",
        {
          params: {
            songmid,
            id: candidateId || undefined,
            ownCookie: 0,
          },
          timeoutMs: 12_000,
        },
      );
      const lyricText = extractJsososoLyricText(lyricData);
      const lyrics = parseLrc(lyricText);
      if (lyrics.length) {
        return { lyrics, source: "qq-music-jsososo" };
      }
    } catch {
      // Try next candidate.
    }
    return null;
  });

  if (result) return result;
  const openApiFallback = await fetchFromQQOpenApiMirrorFallback(track, operation);
  if (openApiFallback) {
    return openApiFallback;
  }

  return null;
}

async function fetchFromQQMeting(track, operation = createQQRequestOperation()) {
  const query = `${track.title} ${track.artist}`.trim();
  const searchParamVariants = [{ id: query }, { s: query }];
  let candidates = [];
  let lastError = null;

  const searches = METING_SEARCH_ENDPOINTS.flatMap(endpoint => searchParamVariants.map(variant =>
    operation.json(endpoint, {
      params: { server: "tencent", type: "search", ...variant },
      timeoutMs: 8_000,
    }).then(data => ({ data }), error => ({ error }))));
  for (const search of searches) {
    const { data, error } = await search;
    if (error) {
      lastError = error;
      continue;
    }
    const nextCandidates = Array.isArray(data) ? data : [];
    if (!nextCandidates.length) {
      continue;
    }
    if (nextCandidates.length >= 5) {
      const maxSimilarity = nextCandidates.reduce(
        (max, item) =>
          Math.max(
            max,
            scoreCandidate(track, item?.title || "", item?.author || ""),
          ),
        -Infinity,
      );
      const topTitle = String(nextCandidates[0]?.title || "")
        .toLowerCase()
        .trim();
      const topAuthor = String(nextCandidates[0]?.author || "")
        .toLowerCase()
        .trim();
      const appearsStaticDefault =
        topTitle === "hello" && topAuthor === "adele";
      if (
        appearsStaticDefault &&
        maxSimilarity < MATCH_ACCEPTANCE_THRESHOLD - 1
      ) {
        lastError = new Error(
          "Meting endpoint returned unrelated static results (stale catalog)",
        );
        continue;
      }
    }
    candidates = nextCandidates;
    break;
  }

  if (!candidates.length) {
    if (lastError) {
      throw lastError;
    }
    return null;
  }

  const sorted = candidates
    .map((item) => ({
      item,
      score: scoreCandidate(track, item.title || "", item.author || ""),
    }))
    .sort((a, b) => b.score - a.score);



  const likelyMetingCandidates = filterLikelySameTrackCandidates(track, sorted, {
    getTitle: (candidate) => candidate.item?.title || "",
    getArtist: (candidate) => candidate.item?.author || "",
    getDurationMs: () => Number(track.durationMs || 0),
    getScore: (candidate) => candidate.score,
  }).slice(0, 6);

  const result = await findQQFallbackLyrics(likelyMetingCandidates, async candidate => {
    if (candidate.score < MATCH_ACCEPTANCE_THRESHOLD || !candidate.item?.lrc) {
      return null;
    }
    try {
      const lyricText = await operation.text(candidate.item.lrc, {
        timeoutMs: 8_000,
      });
      if (
        shouldRejectLyricVariant(
          track.title,
          candidate.item?.title || "",
          lyricText,
        )
      ) {
        return null;
      }
      const lyrics = parseLrc(lyricText);
      if (lyrics.length) {
        return { lyrics, source: "qq-music-meting" };
      }
    } catch {
      // Try next candidate.
    }
    return null;
  });
  return result;
}

async function fetchQQRecordingAliasLyrics(track, options, operation) {
  const { foldCatalogText, stripFeaturing } = require("./lyricsRecordingIdentity");
  track = await resolveLyricsTrackMetadata(track, ["isrc", ...lyricsTextMatchFields], options);
  const aliases = await resolveVerifiedRecordingAliases(track);
  for (const alias of aliases) {
    // Only the search and scoring title changes. Verify credits and version
    // against the original recording before allowing any lyric probe.
    const queryTrack = { ...track, title: alias.title };
    const { ranked, accessors } = await searchQQDirectSongPool(queryTrack, (song, accessors) => {
      const { getSongTitle, getSongArtist, getSongInterval } = accessors;
      const title = getSongTitle(song);
      const artists = Array.isArray(song.singer)
        ? song.singer.map(singer => String(singer?.name || "").trim()).filter(Boolean)
        : recordingAliasArtistNames(getSongArtist(song));
      const durationMs = getQqCandidateDurationMs(getSongInterval, song);
      if (foldCatalogText(stripFeaturing(title)) !== foldCatalogText(alias.title) ||
          !recordingAliasCandidateMatches(track, song, title, artists, durationMs)) return null;
      return recordingAliasRowEvidence(song, song, title, artists, durationMs);
    }, operation);
    const { earlyExit, state } = await fetchQQDirectCandidateLyricsParallel(queryTrack, ranked.slice(0, MAX_QQ_DIRECT_CANDIDATES), accessors, null, operation);
    const result = earlyExit || resolveQQDirectAggregatedResults(queryTrack, state);
    if (result?.lyrics?.length) return result;
  }
  return null;
}

// QQ's Musicu endpoint, public search endpoint, and public mirrors each have
// intermittent catalog gaps. Keep the desktop-compatible direct flow first,
// then try the existing compatible fallbacks before reporting no match.
async function fetchFromQQ(track, { spotifyAccessToken = "" } = {}) {
  track = await resolveLyricsTrackMetadata(track, lyricsTextMatchFields, { spotifyAccessToken });
  if (!track.title?.trim() || !track.artist?.trim()) return null;
  const operation = createQQRequestOperation();
  if (trackNeedsFeaturedVariantVerification(track)) {
    const direct = await fetchFromQQDirect(track, operation, true).catch(() => null);
    if (direct?.lyrics?.length) return direct;
  }
  const direct = await fetchFromQQDirect(track, operation).catch(() => null);
  if (direct?.lyrics?.length) return direct;
  const alias = await fetchQQRecordingAliasLyrics(track, { spotifyAccessToken }, operation).catch(() => null);
  if (alias?.lyrics?.length) return alias;

  // These routes are independent. Preserve route preference while the bounded
  // request queue shares duplicate catalog and lyric requests across them.
  const fallbacks = [resolveQQLegacyDownloadFallback, fetchFromQQMirror, fetchFromQQMeting]
    .map(fetcher => fetcher(track, operation).catch(() => null));
  for (const fallback of fallbacks) {
    const result = await fallback;
    if (result?.lyrics?.length) return result;
  }
  if (operation.lastRequestError) throw operation.lastRequestError;
  return null;
}

async function previewQQDirectSearchCandidates(track) {
  const { ranked, accessors } = await searchQQDirectSongPool(track);
  const { getSongMid, getSongTitle, getSongArtist, getSongInterval } = accessors;

  return ranked.map((candidate) => {
    const title = String(getSongTitle(candidate.song) || "").trim();
    const artist = String(getSongArtist(candidate.song) || "").trim();
    const interval = getSongInterval(candidate.song);
    let durationMs = 0;
    if (interval > 0) {
      durationMs = interval < 1_000 ? interval * 1000 : interval;
    }
    return {
      title,
      artist,
      score: candidate.score,
      durationMs,
      songMid: getSongMid(candidate.song),
    };
  });
}
