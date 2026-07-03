"use strict";

// Gemini lyric translation enrichment and translation cache handling.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const GEMINI_TRANSLATION_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    lineCount: { type: "INTEGER" },
    translations: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          i: { type: "INTEGER" },
          t: { type: "STRING" },
        },
        required: ["i", "t"],
      },
    },
  },
  required: ["lineCount", "translations"],
};

function stripJsonFences(value) {
  const fenced = String(value || "").match(/```(?:json|text)?\s*([\s\S]*?)```/i);
  return fenced?.[1] ? String(fenced[1]).trim() : String(value || "").trim();
}

function buildIndexedTranslationUserPayload({
  lines,
  startIndex = 0,
  targetLanguage,
  title,
  artist,
}) {
  return {
    lineCount: lines.length,
    startIndex,
    targetLanguage,
    context: {
      title: title || null,
      artist: artist || null,
    },
    lines: lines.map((text, offset) => ({
      i: startIndex + offset,
      text: String(text || ""),
    })),
  };
}

function buildTranslationSystemPrompt(targetLanguage) {
  return [
    `Translate each lyric line to natural ${targetLanguage}.`,
    "Use title/artist only to disambiguate meaning—never output them.",
    "One input line maps to exactly one output entry; keep order, register, slang, and profanity.",
    "Do not merge, split, skip, or reorder lines.",
    "Already-English or non-lexical lines (sounds, names, ad-libs): copy the source text into t unchanged.",
    'Return JSON only: {"lineCount":N,"translations":[{"i":0,"t":"..."},...]}.',
    "lineCount must equal the input lineCount.",
    "translations must contain exactly lineCount objects with i from startIndex through startIndex+lineCount-1, each i once.",
    "Use t:\"\" for blank source lines.",
  ].join(" ");
}

function buildGemmaTranslationPrompt(systemPrompt, userPayload) {
  return `${systemPrompt}\n\nTranslate this payload and return indexed JSON with the same lineCount and i values:\n${JSON.stringify(userPayload)}`;
}

function readIndexedTranslationRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const index = Number(row.i ?? row.index);
  const text = String(row.t ?? row.text ?? row.translated ?? "");
  if (!Number.isInteger(index)) {
    return null;
  }
  return { index, text };
}

function parseIndexedTranslationPayload(parsed, expectedCount, startIndex = 0) {
  if (!parsed || typeof parsed !== "object" || !expectedCount) {
    return null;
  }

  const declaredCount = Number(parsed.lineCount);
  const rows = Array.isArray(parsed.translations) ? parsed.translations : null;
  if (!rows || rows.length !== expectedCount) {
    return null;
  }
  if (
    Number.isInteger(declaredCount) &&
    declaredCount > 0 &&
    declaredCount !== expectedCount
  ) {
    return null;
  }

  const out = Array.from({ length: expectedCount }, () => "");
  const seen = new Set();
  for (const row of rows) {
    const entry = readIndexedTranslationRow(row);
    if (!entry) {
      return null;
    }
    const localIndex = entry.index - startIndex;
    if (localIndex < 0 || localIndex >= expectedCount || seen.has(localIndex)) {
      return null;
    }
    seen.add(localIndex);
    out[localIndex] = entry.text.trim();
  }

  if (seen.size !== expectedCount) {
    return null;
  }
  for (let index = 0; index < expectedCount; index += 1) {
    if (!seen.has(index)) {
      return null;
    }
  }
  return out;
}

function parseStringArrayTranslationPayload(rows, expectedCount) {
  if (!Array.isArray(rows) || !expectedCount || rows.length !== expectedCount) {
    return null;
  }
  if (!rows.every((row) => typeof row === "string" || row == null)) {
    return null;
  }
  return rows.map((row) => String(row ?? "").trim());
}

function validateTranslationAlignment(translations, sourceLines) {
  if (
    !Array.isArray(translations) ||
    !Array.isArray(sourceLines) ||
    translations.length !== sourceLines.length ||
    !translations.length
  ) {
    return false;
  }

  const translationBySource = new Map();
  let nonEmptySourceCount = 0;
  let emptyTranslationCount = 0;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const source = String(sourceLines[index] || "").trim();
    const translated = String(translations[index] || "").trim();
    if (!source) {
      continue;
    }
    nonEmptySourceCount += 1;
    if (!translated) {
      emptyTranslationCount += 1;
    }
    if (translationBySource.has(source)) {
      if (translationBySource.get(source) !== translated) {
        return false;
      }
    } else {
      translationBySource.set(source, translated);
    }
  }

  if (!nonEmptySourceCount) {
    return true;
  }

  const emptyRatio = emptyTranslationCount / nonEmptySourceCount;
  return emptyRatio <= 0.35;
}

function parseTranslationPayloadObject(parsed, expectedCount, sourceLines, startIndex = 0) {
  if (!parsed) {
    return null;
  }

  const indexed = parseIndexedTranslationPayload(
    parsed,
    expectedCount,
    startIndex,
  );
  if (indexed) {
    return indexed;
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.translations)
      ? parsed.translations
      : null;
  if (!rows) {
    return null;
  }

  if (
    rows.length === expectedCount &&
    rows.every((row) => typeof row === "string" || row == null)
  ) {
    return parseStringArrayTranslationPayload(rows, expectedCount);
  }

  const out = Array.from({ length: expectedCount }, () => "");
  const seen = new Set();
  for (const row of rows) {
    const entry = readIndexedTranslationRow(row);
    if (!entry) {
      return null;
    }
    const localIndex = entry.index - startIndex;
    if (localIndex < 0 || localIndex >= expectedCount || seen.has(localIndex)) {
      return null;
    }
    seen.add(localIndex);
    out[localIndex] = entry.text.trim();
  }
  if (seen.size !== expectedCount) {
    return null;
  }
  return out;
}

function extractTranslationsFromGeminiPayload(
  payload,
  expectedCount,
  sourceLines,
  { startIndex = 0, parseLegacyFallback } = {},
) {
  const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts)
    ? payload.candidates[0].content.parts
    : [];

  const text = parts
    .map((part) => String(part?.text || ""))
    .join("")
    .trim();
  if (!text) {
    return null;
  }

  const fenced = stripJsonFences(text);
  for (const candidate of [text, fenced]) {
    try {
      const parsed = parseJsonLenient(candidate);
      const normalized = parseTranslationPayloadObject(
        parsed,
        expectedCount,
        sourceLines,
        startIndex,
      );
      if (
        normalized &&
        validateTranslationAlignment(normalized, sourceLines)
      ) {
        return normalized;
      }
    } catch {
      // try legacy parser below
    }
  }

  if (typeof parseLegacyFallback !== "function") {
    return null;
  }
  const legacy = parseLegacyFallback(text);
  if (
    !legacy ||
    !validateTranslationAlignment(legacy, sourceLines)
  ) {
    return null;
  }
  return legacy;
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

async function enrichLyricsWithGeminiTranslations(
  track,
  lyrics,
  { geminiApiKey = "", geminiCache = null } = {},
) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return lyrics || [];
  }

  const apiKey = String(geminiApiKey || "").trim();
  if (!apiKey) {
    console.log(
      `[lyrics-translate] skipped: missing Gemini key for ${String(track?.title || "unknown title")} / ${String(track?.artist || "unknown artist")}`,
    );
    lyrics.translationMeta = {
      provider: "Gemini",
      model: "",
      apiRequestMs: 0,
      bridgeProcessingMs: 0,
      translatedLineCount: 0,
      requestedAt: Date.now(),
      completedAt: Date.now(),
      isLoading: false,
    };
    return lyrics;
  }

  const geminiCooldown = getGeminiCooldownInfo();
  if (geminiCooldown.active) {
    console.log(
      `[lyrics-translate] skipped: cooldown active (${geminiCooldown.reason || "unknown"}, ${Math.ceil(geminiCooldown.remainingMs / 1000)}s) for ${String(track?.title || "unknown title")}`,
    );
    lyrics.translationMeta = {
      provider: "Gemini",
      model: "",
      apiRequestMs: 0,
      bridgeProcessingMs: 0,
      translatedLineCount: 0,
      requestedAt: Date.now(),
      completedAt: Date.now(),
      isLoading: false,
    };
    return lyrics;
  }

  const cacheMap = geminiCache instanceof Map ? geminiCache : null;
  const cleanupGeminiCache = (now = Date.now()) => {
    if (!cacheMap) {
      return;
    }
    for (const [key, entry] of cacheMap.entries()) {
      if (!entry || Number(entry.expiresAt || 0) <= now) {
        cacheMap.delete(key);
      }
    }
  };
  const normalizeLineKey = (text) => String(text || "").trim();

  const uniqueLineMap = new Map();
  let candidateLineCount = 0;
  const registerCandidateText = (value) => {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }
    const key = normalizeLineKey(text);
    if (!key) {
      return;
    }
    candidateLineCount += 1;
    if (!uniqueLineMap.has(key)) {
      uniqueLineMap.set(key, text);
    }
  };

  for (const line of lyrics) {
    registerCandidateText(getLineText(line));
    registerCandidateText(getBackgroundLineText(line));
  }

  if (!candidateLineCount || !uniqueLineMap.size) {
    return lyrics;
  }

  const fingerprint = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        title: String(track?.title || ""),
        artist: String(track?.artist || ""),
        durationMs: Number(track?.durationMs || 0),
        lines: [...uniqueLineMap.keys()],
      }),
    )
    .digest("hex");
  const cacheKey = `openrouter|${fingerprint}`;

  cleanupGeminiCache();
  const cached = cacheMap?.get(cacheKey);
  if (
    cached &&
    cached.translations &&
    typeof cached.translations === "object"
  ) {
    console.log(
      `[lyrics-translate] cache hit for ${String(track?.title || "unknown title")} (${uniqueLineMap.size} unique lines)`,
    );
    const cachedLyrics = lyrics.map((line) => {
      const translatedText = buildTranslatedTextForLineFromLookup(
        line,
        cached.translations,
      );
      if (!translatedText) {
        return line;
      }
      return {
        ...line,
        translatedText,
      };
    });
    cachedLyrics.translationMeta = {
      provider: "Gemini",
      model: "cache",
      apiRequestMs: 0,
      bridgeProcessingMs: 0,
      translatedLineCount: Object.keys(cached.translations || {}).length,
      requestedAt: Date.now(),
      completedAt: Date.now(),
      isLoading: false,
    };
    return cachedLyrics;
  }

  const uniqueLines = [...uniqueLineMap.values()];
  const translatedByText = {};
  let translationModelUsed = "";
  let translationApiRequestMs = 0;
  let translationBridgeProcessingMs = 0;
  const translationStartedAt = Date.now();
  console.log(
    `[lyrics-translate] start for ${String(track?.title || "unknown title")} / ${String(track?.artist || "unknown artist")}: ${uniqueLines.length} unique lines, source=${String(track?.source || "unknown")}`,
  );

  const parseGeminiCompactLines = (
    content,
    expectedCount,
    sourceLines = [],
    startIndex = 0,
  ) => {
    const raw = String(content || "").trim();
    if (!raw) {
      return null;
    }

    const candidates = [raw, stripJsonFences(raw)];
    for (const candidate of candidates) {
      try {
        const parsed = parseJsonLenient(candidate);
        const normalized = parseTranslationPayloadObject(
          parsed,
          expectedCount,
          sourceLines,
          startIndex,
        );
        if (normalized) {
          return normalized;
        }
      } catch {
        // try regex salvage below
      }
    }

    const salvageIndexedRowsByRegex = (value) => {
      const text = String(value || "");
      if (!text) {
        return null;
      }
      const out = Array.from({ length: expectedCount }, () => "");
      const seen = new Set();
      const patterns = [
        /"i"\s*:\s*(\d+)\s*,\s*"t"\s*:\s*"((?:\\.|[^"\\])*)"/g,
        /"index"\s*:\s*(\d+)\s*,\s*"translated"\s*:\s*"((?:\\.|[^"\\])*)"/g,
      ];
      for (const regex of patterns) {
        let match = regex.exec(text);
        while (match) {
          const index = Number(match[1]);
          const encoded = String(match[2] || "");
          let translated = "";
          try {
            translated = JSON.parse(`"${encoded}"`);
          } catch {
            translated = encoded
              .replace(/\\n/g, "\n")
              .replace(/\\r/g, "")
              .replace(/\\t/g, "\t")
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, "\\");
          }
          const localIndex = index - startIndex;
          if (
            Number.isInteger(localIndex) &&
            localIndex >= 0 &&
            localIndex < out.length &&
            !seen.has(localIndex)
          ) {
            seen.add(localIndex);
            out[localIndex] = String(translated).trim();
          }
          match = regex.exec(text);
        }
      }
      if (seen.size !== expectedCount) {
        return null;
      }
      return out;
    };

    for (const candidate of candidates) {
      const salvaged = salvageIndexedRowsByRegex(candidate);
      if (salvaged) {
        return salvaged;
      }
    }

    return null;
  };

  const requestGeminiFullLyrics = async (allLines, { startIndex = 0 } = {}) => {
    const trackTitle = String(track?.title || "").trim();
    const trackArtist = String(track?.artist || "").trim();
    const normalizeMetadataGuardText = (value) =>
      String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/['"`]/g, "")
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
    const normalizedTrackTitle = normalizeMetadataGuardText(trackTitle);
    const normalizedTrackArtist = normalizeMetadataGuardText(trackArtist);
    const isTrackMetadataLeak = (value) => {
      const text = String(value || "").trim();
      if (!text) {
        return false;
      }
      const lower = text.toLowerCase();
      if (/^(?:title|track|song|artist|by)\s*[:=-]/i.test(text)) {
        return true;
      }
      const normalized = normalizeMetadataGuardText(text);
      if (!normalized) {
        return false;
      }
      if (normalizedTrackTitle && normalized === normalizedTrackTitle) {
        return true;
      }
      if (
        normalizedTrackTitle &&
        (normalized === `title ${normalizedTrackTitle}` ||
          normalized === `track ${normalizedTrackTitle}` ||
          normalized === `song ${normalizedTrackTitle}` ||
          normalized.startsWith(`${normalizedTrackTitle} by `) ||
          normalized.startsWith(`title ${normalizedTrackTitle} `) ||
          normalized.startsWith(`track ${normalizedTrackTitle} `) ||
          normalized.startsWith(`song ${normalizedTrackTitle} `))
      ) {
        return true;
      }
      if (
        normalizedTrackArtist &&
        (lower.startsWith("artist:") ||
          normalized === `artist ${normalizedTrackArtist}` ||
          normalized === `by ${normalizedTrackArtist}`)
      ) {
        return true;
      }
      return false;
    };
    const sanitizeTranslatedLines = (lines) =>
      Array.isArray(lines)
        ? lines.map((line) =>
            isTrackMetadataLeak(line) ? "" : String(line || "").trim(),
          )
        : lines;
    const systemPrompt = buildTranslationSystemPrompt(
      GEMINI_TRANSLATION_TARGET_LANGUAGE,
    );
    const userPayload = buildIndexedTranslationUserPayload({
      lines: allLines,
      startIndex,
      targetLanguage: GEMINI_TRANSLATION_TARGET_LANGUAGE,
      title: trackTitle,
      artist: trackArtist,
    });
    const userPrompt = JSON.stringify(userPayload);

    const shouldRetryGeminiError = (error) => {
      if (!error) {
        return false;
      }
      const message = String(error?.message || error || "").toLowerCase();
      return (
        message.includes("openrouter 429") ||
        message.includes("gemini 429") ||
        message.includes("http 429") ||
        message.includes("resource_exhausted") ||
        message.includes("http 5") ||
        message.includes("temporarily rate-limited") ||
        message.includes("provider returned error") ||
        message.includes("aborted") ||
        message.includes("timeout") ||
        message.includes("network")
      );
    };

    const isGeminiUsageLimitError = (error) => {
      if (!error) {
        return false;
      }
      const message = String(error?.message || error || "").toLowerCase();
      return isGeminiTranslationRateLimitedMessage(message);
    };

    const isGemmaModel = (model) =>
      String(model || "")
        .trim()
        .toLowerCase()
        .startsWith("gemma-");

    const getHttpErrorWithBody = async (response) => {
      const retryAfter = response.headers.get("retry-after");
      const retrySuffix = retryAfter ? ` (retry-after=${retryAfter})` : "";
      let bodyText = "";
      try {
        bodyText = String(await response.text()).trim();
      } catch {
        bodyText = "";
      }
      const compactBody = bodyText.replace(/\s+/g, " ").slice(0, 240);
      const bodySuffix = compactBody ? `: ${compactBody}` : "";
      return new Error(`HTTP ${response.status}${retrySuffix}${bodySuffix}`);
    };

    const requestGeminiLines = async ({ model }) => {
      try {
        const requestStartedAt = Date.now();
        const useGemmaCompatMode = isGemmaModel(model);
        const requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const generationConfig = {
          temperature: 0,
          topP: 0.05,
          maxOutputTokens: Math.min(
            8192,
            Math.max(2048, allLines.length * 48),
          ),
          responseMimeType: "application/json",
          responseSchema: GEMINI_TRANSLATION_JSON_SCHEMA,
        };
        if (
          !useGemmaCompatMode &&
          String(model || "")
            .toLowerCase()
            .includes("gemini")
        ) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        if (useGemmaCompatMode) {
          delete generationConfig.responseMimeType;
          delete generationConfig.responseSchema;
          delete generationConfig.thinkingConfig;
        }

        const requestBody = useGemmaCompatMode
          ? {
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: buildGemmaTranslationPrompt(systemPrompt, userPayload),
                    },
                  ],
                },
              ],
              generationConfig,
            }
          : {
              systemInstruction: {
                parts: [{ text: systemPrompt }],
              },
              contents: [
                {
                  role: "user",
                  parts: [{ text: userPrompt }],
                },
              ],
              generationConfig,
            };

        const response = await fetch(requestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
        const responseReceivedAt = Date.now();

        if (!response.ok) {
          throw await getHttpErrorWithBody(response);
        }

        const payload = await response.json();
        const parsedLines = extractTranslationsFromGeminiPayload(
          payload,
          allLines.length,
          allLines,
          {
            startIndex,
            parseLegacyFallback: (legacyText) =>
              parseGeminiCompactLines(
                legacyText,
                allLines.length,
                allLines,
                startIndex,
              ),
          },
        );
        if (
          !Array.isArray(parsedLines) ||
          parsedLines.length !== allLines.length ||
          !validateTranslationAlignment(parsedLines, allLines)
        ) {
          throw new Error(
            `Gemini returned invalid line payload (expected ${allLines.length} aligned lines).`,
          );
        }
        const sanitizedLines = sanitizeTranslatedLines(parsedLines);
        translationModelUsed = model;
        translationApiRequestMs += responseReceivedAt - requestStartedAt;
        translationBridgeProcessingMs += Math.max(0, Date.now() - responseReceivedAt);
        return sanitizedLines;
      } catch (error) {
        throw error;
      }
    };

    const isInvalidPayloadError = (error) => {
      const message = String(error?.message || error || "").toLowerCase();
      return (
        message.includes("invalid line payload") ||
        message.includes("invalid payload") ||
        message.includes("aligned lines")
      );
    };

    let lastError = null;
    let consecutiveInvalidPayloadCount = 0;
    for (const model of GEMINI_MODEL_CANDIDATES) {
      for (
        let attempt = 0;
        attempt < GEMINI_TRANSLATION_MAX_RETRIES;
        attempt += 1
      ) {
        try {
          const translatedLines = await requestGeminiLines({
            model,
          });
          consecutiveInvalidPayloadCount = 0;
          console.log(
            `[lyrics-translate] model ${model} success for ${allLines.length} lines`,
          );
          return translatedLines;
        } catch (error) {
          lastError = error;
          if (isInvalidPayloadError(error)) {
            consecutiveInvalidPayloadCount += 1;
            if (consecutiveInvalidPayloadCount >= 2) {
              throw new Error(
                "Gemini returned invalid payload twice consecutively; skipping further retries.",
              );
            }
          } else {
            consecutiveInvalidPayloadCount = 0;
          }
          const canRetry =
            attempt < GEMINI_TRANSLATION_MAX_RETRIES - 1 &&
            shouldRetryGeminiError(error);
          if (canRetry) {
            const delayMs =
              GEMINI_TRANSLATION_RETRY_BASE_MS * Math.pow(2, attempt) +
              Math.floor(Math.random() * 450);
            await wait(delayMs);
            continue;
          }
          break;
        }
      }
      if (!isGeminiUsageLimitError(lastError)) {
        throw lastError || new Error("Gemini translation failed.");
      }
    }
    throw lastError || new Error("Gemini translation failed.");
  };

  const requestGeminiChunkedLyrics = async (allLines) => {
    const chunkSize = GEMINI_TRANSLATION_CHUNK_SIZE;
    const chunks = [];
    for (let start = 0; start < allLines.length; start += chunkSize) {
      chunks.push({
        lines: allLines.slice(start, start + chunkSize),
        startIndex: start,
      });
    }
    const chunkCount = chunks.length;
    const parallelLimit = Math.max(
      1,
      Number(GEMINI_TRANSLATION_MAX_PARALLEL_CHUNKS) || 1,
    );
    const chunkResults = await mapWithConcurrency(
      chunks,
      parallelLimit,
      async (chunk, chunkIndex) => {
        const chunkTranslated = await requestGeminiFullLyrics(chunk.lines, {
          startIndex: chunk.startIndex,
        });
        if (
          !Array.isArray(chunkTranslated) ||
          chunkTranslated.length !== chunk.lines.length
        ) {
          throw new Error(
            `Gemini chunk translation failed (expected ${chunk.lines.length} lines).`,
          );
        }
        console.log(
          `[lyrics-translate] chunk ${chunkIndex + 1}/${chunkCount} translated (${chunk.lines.length} lines, startIndex=${chunk.startIndex})`,
        );
        return chunkTranslated;
      },
    );
    return chunkResults.flat();
  };

  const isRateLimitedTranslationError = (message = "") => {
    return isGeminiTranslationRateLimitedMessage(message);
  };

  const isInvalidPayloadRetryStopError = (message = "") => {
    const lowerMessage = String(message || "").toLowerCase();
    return lowerMessage.includes(
      "invalid payload twice consecutively; skipping further retries",
    );
  };

  let translatedAll = [];
  let translationError = null;
  const attemptedChunkedFirst =
    uniqueLines.length > GEMINI_TRANSLATION_PROACTIVE_CHUNK_LINES;
  try {
    translatedAll = attemptedChunkedFirst
      ? await requestGeminiChunkedLyrics(uniqueLines)
      : await requestGeminiFullLyrics(uniqueLines);
  } catch (error) {
    translationError = error;
    console.warn(
      `[lyrics-translate] full translation failed for ${String(track?.title || "unknown title")}: ${String(error?.message || error || "unknown")}`,
    );
  }

  if (translationError) {
    const message = String(translationError?.message || translationError || "");
    const shouldTryChunkedFallback =
      !attemptedChunkedFirst &&
      uniqueLines.length > GEMINI_TRANSLATION_CHUNK_SIZE &&
      !isRateLimitedTranslationError(message) &&
      !isInvalidPayloadRetryStopError(message);
    if (shouldTryChunkedFallback) {
      try {
        console.log(
          `[lyrics-translate] retrying chunked translation (${uniqueLines.length} lines)`,
        );
        translatedAll = await requestGeminiChunkedLyrics(uniqueLines);
        translationError = null;
      } catch (chunkError) {
        translationError = chunkError;
        console.warn(
          `[lyrics-translate] chunked translation failed for ${String(track?.title || "unknown title")}: ${String(chunkError?.message || chunkError || "unknown")}`,
        );
      }
    }
  }

  if (translationError) {
    const message = String(translationError?.message || translationError || "");
    if (isRateLimitedTranslationError(message)) {
      const reason = String(message || "")
        .toLowerCase()
        .includes("503")
        ? "http-503"
        : "http-429";
      activateGeminiCooldown(reason, GEMINI_RATE_LIMIT_COOLDOWN_MS);
      console.warn(
        `[lyrics-translate] rate limited, cooldown activated (${Math.ceil(GEMINI_RATE_LIMIT_COOLDOWN_MS / 1000)}s)`,
      );
      lyrics.translationMeta = {
        provider: "Gemini",
        model: translationModelUsed,
        apiRequestMs: translationApiRequestMs,
        bridgeProcessingMs: translationBridgeProcessingMs,
        translatedLineCount: 0,
        requestedAt: translationStartedAt,
        completedAt: Date.now(),
        isLoading: false,
      };
      return lyrics;
    }
    lyrics.translationMeta = {
      provider: "Gemini",
      model: translationModelUsed,
      apiRequestMs: translationApiRequestMs,
      bridgeProcessingMs: translationBridgeProcessingMs,
      translatedLineCount: 0,
      requestedAt: translationStartedAt,
      completedAt: Date.now(),
      isLoading: false,
    };
    return lyrics;
  }

  for (let index = 0; index < uniqueLines.length; index += 1) {
    const text = uniqueLines[index];
    const translated = String(translatedAll[index] || "").trim();
    if (translated && !shouldHideTranslatedText(text, translated)) {
      translatedByText[text] = translated;
    }
  }

  console.log(
    `[lyrics-translate] completed for ${String(track?.title || "unknown title")}: translated ${Object.keys(translatedByText).length}/${uniqueLines.length} unique lines`,
  );

  const translatedLyrics = lyrics.map((line) => {
    const translatedText = buildTranslatedTextForLineFromLookup(
      line,
      translatedByText,
    );
    if (!translatedText) {
      return line;
    }
    return {
      ...line,
      translatedText,
    };
  });

  if (cacheMap) {
    cleanupGeminiCache();
    cacheMap.set(cacheKey, {
      expiresAt: Date.now() + GEMINI_TRANSLATION_CACHE_TTL_MS,
      translations: translatedByText,
    });
  }

  translatedLyrics.translationMeta = {
    provider: "Gemini",
    model: translationModelUsed || GEMINI_MODEL_CANDIDATES[0],
    apiRequestMs: translationApiRequestMs,
    bridgeProcessingMs:
      translationBridgeProcessingMs ||
      Math.max(0, Date.now() - translationStartedAt - translationApiRequestMs),
    translatedLineCount: Object.keys(translatedByText).length,
    requestedAt: translationStartedAt,
    completedAt: Date.now(),
    isLoading: false,
  };

  return translatedLyrics;
}

