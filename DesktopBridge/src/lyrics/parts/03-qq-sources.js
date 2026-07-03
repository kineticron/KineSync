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
    songs.push({
      songid: songId,
      songname: normalizeLegacyXmlText(nameRaw),
      singername: normalizeLegacyXmlText(singerRaw),
      albumname: normalizeLegacyXmlText(albumRaw),
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

async function fetchFromQQLegacyDownload(track) {
  const rankedSongs = [];
  for (const query of buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS)) {
    try {
      const searchXml = await fetchTextFromAnyEndpoint(
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
  }

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

  const likelyLegacyCandidates = filterLikelySameTrackCandidates(
    track,
    ranked,
    {
      getTitle: (candidate) => candidate.song.songname || "",
      getArtist: (candidate) => candidate.song.singername || "",
      getDurationMs: () => 0,
      getScore: (candidate) => candidate.score,
    },
  )
    .map((candidate) => ({
      ...candidate,
      candidateTitle: candidate.song.songname || "",
      candidateArtist: candidate.song.singername || "",
    }))
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, MAX_QQ_LEGACY_CANDIDATES);

  let bestLegacySelection = null;

  for (const candidate of likelyLegacyCandidates) {
    if (!candidate.song.songid) {
      continue;
    }
    try {
      const xml = await fetchTextFromAnyEndpoint(QQ_LEGACY_DOWNLOAD_ENDPOINTS, {
        params: {
          version: "15",
          miniversion: "82",
          lrctype: "4",
          musicid: String(candidate.song.songid),
        },
        timeoutMs: 12_000,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      });
      const fields = extractLegacyLyricFields(xml);
      for (const encryptedHex of fields) {
        const decrypted = qqKaraokeDecryptHex(encryptedHex);
        if (!decrypted) {
          continue;
        }
        const karaokeBody = extractKaraokeBody(decrypted);
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

async function fetchQQDesktopSearchSongs(query) {
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

  const payload = await fetchJsonPostFromAnyEndpoint(
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

async function collectQQSongsFromDesktopSearch(queryVariants) {
  const desktopSongs = [];
  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        desktopSongs.push(...(await fetchQQDesktopSearchSongs(query)));
      } catch {
        // Try next query variant.
      }
    }),
  );
  return desktopSongs;
}

async function collectQQSongsFromLegacyClientSearch(queryVariants) {
  const legacySongs = [];
  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const searchData = await fetchJsonFromAnyEndpoint(QQ_SEARCH_ENDPOINTS, {
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

async function searchQQDirectSongPool(track) {
  const accessors = createQQDirectSongAccessors();
  const allQueryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  let songs = [];

  if (trackNeedsFeaturedVariantVerification(track)) {
    const [desktopSongs, legacySongs] = await Promise.all([
      collectQQSongsFromDesktopSearch(allQueryVariants),
      collectQQSongsFromLegacyClientSearch(allQueryVariants),
    ]);
    songs = [...desktopSongs, ...legacySongs];
  } else {
    songs = await collectQQSongsFromDesktopSearch(allQueryVariants.slice(0, 1));
    let ranked = rankQQDirectSearchSongs(track, songs, accessors);
    if (qqDirectSearchNeedsLegacySupplement(track, ranked, accessors)) {
      const [desktopSongs, legacySongs] = await Promise.all([
        collectQQSongsFromDesktopSearch(allQueryVariants),
        collectQQSongsFromLegacyClientSearch(allQueryVariants),
      ]);
      songs = [...desktopSongs, ...legacySongs];
    }
  }

  const ranked = rankQQDirectSearchSongs(track, songs, accessors);
  return { ranked, accessors };
}

async function resolveQQLegacyDownloadFallback(track) {
  try {
    return await fetchFromQQLegacyDownload(track);
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

async function probeQQDirectCandidate(track, candidate, accessors) {
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
    const musicuData = await fetchJsonPostFromAnyEndpoint(
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
    const encryptedLyricHex = musicuData?.req_1?.data?.lyric || "";
    const decryptedKaraoke = qqKaraokeDecryptHex(encryptedLyricHex);
    const karaokeBody = extractKaraokeBody(decryptedKaraoke);
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
      const lyricData = await fetchJsonFromAnyEndpoint(QQ_LYRIC_ENDPOINTS, {
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
      const lyrics = parseLrc(String(rawTimedLyrics));
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
    if (
      probe.directResult &&
      shouldEarlyExitQQDirectCandidate(
        track,
        candidate,
        probe.selection,
        probe.directResult.coverageRatio,
        state.bestSelection,
      )
    ) {
      shared.earlyExit = {
        lyrics: probe.directResult.lyrics,
        source: "qq-music-direct",
      };
    }
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
      await probeQQDirectCandidate(track, topCandidate, accessors),
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
      const probe = await probeQQDirectCandidate(track, candidate, accessors);
      considerProbe(candidate, await probeQQDirectCandidate(track, candidate, accessors));
    },
  );

  if (shared.earlyExit) {
    return { earlyExit: shared.earlyExit, state };
  }
  return { earlyExit: null, state };
}

function resolveQQDirectAggregatedResults(track, state) {
  const {
    bestResult,
    bestCoverageScore,
    bestKaraokeResult,
    bestKaraokeCoverageScore,
  } = state;

  if (bestKaraokeResult?.lyrics?.length) {
    const karaokeRatio = getLyricsCoverageRatio(
      bestKaraokeResult.lyrics,
      track.durationMs,
    );
    const bestRatio = bestResult?.lyrics?.length
      ? getLyricsCoverageRatio(bestResult.lyrics, track.durationMs)
      : 0;
    const coverageGap = bestCoverageScore - bestKaraokeCoverageScore;
    const karaokeIsBestAlready =
      !bestResult?.lyrics?.length ||
      String(bestResult.source || "") === String(bestKaraokeResult.source || "");
    if (!karaokeIsBestAlready) {
      const karaokeLooksIncomplete =
        karaokeRatio > 0 && karaokeRatio < 0.42 && bestRatio >= karaokeRatio + 0.08;
      const lyricsClearlyMoreComplete =
        coverageGap >= 30 && bestRatio >= karaokeRatio + 0.04;
      if (karaokeLooksIncomplete || lyricsClearlyMoreComplete) {
        return bestResult;
      }
    }
    return bestKaraokeResult;
  }

  return bestResult || null;
}

async function fetchFromQQDirect(track) {
  const { ranked, accessors } = await searchQQDirectSongPool(track);
  const { getSongTitle, getSongArtist, getSongInterval } = accessors;

  if (!ranked.length) {
    const seededKaraokeResult = await resolveQQLegacyDownloadFallback(track);
    return seededKaraokeResult?.lyrics?.length ? seededKaraokeResult : null;
  }

  if (isAmbiguousTopMatch(ranked)) {
    return null;
  }

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

  const desktopSearchReady = likelyDirectCandidates.length > 0;
  let seededKaraokeResult = null;
  let seededKaraokeCoverageScore = -1;

  if (!desktopSearchReady) {
    seededKaraokeResult = await resolveQQLegacyDownloadFallback(track);
    if (seededKaraokeResult?.lyrics?.length) {
      seededKaraokeCoverageScore = scoreLyricsCoverage(
        seededKaraokeResult.lyrics,
        track.durationMs,
      );
      if (
        getLyricsCoverageRatio(seededKaraokeResult.lyrics, track.durationMs) >=
        EARLY_RETURN_COVERAGE_RATIO
      ) {
        return seededKaraokeResult;
      }
    } else {
      seededKaraokeResult = null;
    }
  }

  const parallelFetch = await fetchQQDirectCandidateLyricsParallel(
    track,
    likelyDirectCandidates,
    accessors,
    seededKaraokeResult,
  );
  if (parallelFetch.earlyExit) {
    return parallelFetch.earlyExit;
  }
  const bestResult = resolveQQDirectAggregatedResults(track, parallelFetch.state);

  if (!bestResult?.lyrics?.length) {
    const legacyFallback = await resolveQQLegacyDownloadFallback(track);
    if (legacyFallback?.lyrics?.length) {
      return legacyFallback;
    }
  }

  return bestResult || null;
}

async function fetchFromQQOpenApiMirrorFallback(track) {
  const songs = [];
  for (const query of buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS)) {
    try {
      const searchData = await fetchJsonFromAnyEndpoint(QQ_SEARCH_ENDPOINTS, {
        params: { p: 1, n: 60, w: query, format: "json" },
        timeoutMs: 10_000,
        headers: {
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
        },
      });
      const searchSongs =
        searchData?.data?.song?.list || searchData?.data?.list || [];
      songs.push(...(Array.isArray(searchSongs) ? searchSongs : []));
    } catch {
      // Try next query variant.
    }
  }

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

  if (!ranked.length || isAmbiguousTopMatch(ranked)) {
    return null;
  }

  const likelyFallbackCandidates = filterLikelyQqRankedCandidates(
    track,
    ranked,
    getSongTitle,
    getSongArtist,
    getSongInterval,
  ).slice(0, 8);

  for (const candidate of likelyFallbackCandidates) {
    const songMid = getSongMid(candidate.song);
    const title = getSongTitle(candidate.song);
    const artist = getSongArtist(candidate.song);
    const interval = getSongInterval(candidate.song);
    const candidateDurationMs =
      interval > 0 && interval < 1_000 ? interval * 1000 : interval;
    if (!songMid || candidate.score < MATCH_ACCEPTANCE_THRESHOLD) {
      continue;
    }

    try {
      const lyricData = await fetchJsonFromAnyEndpoint(QQ_LYRIC_ENDPOINTS, {
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
      const lyrics = parseLrc(String(rawTimedLyrics));
      if (lyrics.length) {
        return { lyrics, source: "qq-music-openapi-fallback" };
      }
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

async function fetchFromQQMirror(track) {
  const query = `${normalizeText(track.title)} ${normalizeText(track.artist)}`;
  let searchData = null;
  let lastSearchError = null;
  for (const searchPath of ["/search/quick", "/search"]) {
    try {
      searchData = await fetchJsososoWithFallback(
        searchPath,
        {
          params: { key: query },
          timeoutMs: 12_000,
        },
        { attempts: 3, backoffMs: 500 },
      );
      break;
    } catch (error) {
      lastSearchError = error;
    }
  }
  if (!searchData) {
    // JSOSOSO public mirrors are often unstable; fall back to direct QQ open APIs.
    const openApiFallback = await fetchFromQQOpenApiMirrorFallback(track);
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

  if (!ranked.length || isAmbiguousTopMatch(ranked)) {
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

  for (const candidate of likelyMirrorCandidates) {
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
      continue;
    }
    try {
      const lyricData = await fetchJsososoWithFallback(
        "/lyric",
        {
          params: {
            songmid,
            id: candidateId || undefined,
            ownCookie: 0,
          },
          timeoutMs: 12_000,
        },
        { attempts: 2, backoffMs: 450 },
      );
      const lyricText = extractJsososoLyricText(lyricData);
      const lyrics = parseLrc(lyricText);
      if (lyrics.length) {
        return { lyrics, source: "qq-music-jsososo" };
      }
    } catch {
      // Try next candidate.
    }
  }

  const openApiFallback = await fetchFromQQOpenApiMirrorFallback(track);
  if (openApiFallback) {
    return openApiFallback;
  }

  return null;
}

async function fetchFromQQMeting(track) {
  const query = `${track.title} ${track.artist}`.trim();
  const searchParamVariants = [{ id: query }, { s: query }];
  let candidates = [];
  let lastError = null;

  for (const endpoint of METING_SEARCH_ENDPOINTS) {
    for (const variant of searchParamVariants) {
      try {
        const data = await fetchJson(endpoint, {
          params: {
            server: "tencent",
            type: "search",
            ...variant,
          },
          timeoutMs: 8_000,
        });
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
      } catch (error) {
        lastError = error;
      }
    }
    if (candidates.length) {
      break;
    }
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

  if (isAmbiguousTopMatch(sorted)) {
    return null;
  }

  const likelyMetingCandidates = filterLikelySameTrackCandidates(track, sorted, {
    getTitle: (candidate) => candidate.item?.title || "",
    getArtist: (candidate) => candidate.item?.author || "",
    getDurationMs: () => Number(track.durationMs || 0),
    getScore: (candidate) => candidate.score,
  }).slice(0, 6);

  for (const candidate of likelyMetingCandidates) {
    if (candidate.score < MATCH_ACCEPTANCE_THRESHOLD || !candidate.item?.lrc) {
      continue;
    }
    try {
      const lyricText = await fetchText(candidate.item.lrc, {
        timeoutMs: 8_000,
      });
      if (
        shouldRejectLyricVariant(
          track.title,
          candidate.item?.title || "",
          lyricText,
        )
      ) {
        continue;
      }
      const lyrics = parseLrc(lyricText);
      if (lyrics.length) {
        return { lyrics, source: "qq-music-meting" };
      }
    } catch {
      // Try next candidate.
    }
  }
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
