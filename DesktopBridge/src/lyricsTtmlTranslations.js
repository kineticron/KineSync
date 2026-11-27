"use strict";

const LRC_NS = "http://lrc.red/lyric-ttml-internal";
const TT_NS = "http://www.w3.org/ns/ttml";
const TTM_NS = "http://www.w3.org/ns/ttml#metadata";
const AMLL_NS = "http://www.example.com/ns/amll";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

function decodeText(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#x[\da-f]+|#\d+);/gi, (entity, name) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (name[0] !== "#") return named[name] || entity;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : entity;
  });
}

function expandedName(name, namespaces, attribute = false) {
  const colon = name.indexOf(":");
  return colon < 0 ? [attribute ? "" : namespaces[""] || "", name]
    : [namespaces[name.slice(0, colon)], name.slice(colon + 1)];
}

// A small, non-resolving XML reader for the optional metadata only. It never
// fetches resources or expands DTD entities. Lyric/timing parsing stays separate.
function readDocument(content) {
  if (/<!DOCTYPE\b/i.test(content)) return null;
  const root = { children: [], namespaces: { xml: XML_NS } };
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+\b(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;
  for (const token of content.matchAll(tokens)) {
    const raw = token[0];
    const parent = stack[stack.length - 1];
    if (raw.startsWith("<!--") || raw.startsWith("<?")) continue;
    if (raw.startsWith("<![CDATA[")) { parent.children.push(raw.slice(9, -3)); continue; }
    if (!raw.startsWith("<")) { parent.children.push(decodeText(raw)); continue; }
    if (raw.startsWith("</")) {
      if (stack.length === 1 || raw.slice(2, -1).trim() !== parent.name) return null;
      if (parent.local === "span") parent.close = token.index;
      stack.pop();
      continue;
    }
    const name = raw.match(/^<([\w:.-]+)/)[1];
    const attributes = [...raw.slice(name.length + 1).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map(match => [match[1], decodeText(match[2] ?? match[3])]);
    const namespaces = Object.assign(Object.create(null), parent.namespaces);
    for (const [key, value] of attributes) {
      if (key === "xmlns") namespaces[""] = value;
      else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
    }
    const [uri, local] = expandedName(name, namespaces);
    const node = { name, uri, local, attributes, namespaces, children: [], start: token.index };
    node.language = attribute(node, "lang", XML_NS) || parent.language || "";
    parent.children.push(node);
    if (!/\/\s*>$/.test(raw)) stack.push(node);
  }
  return stack.length === 1 ? root : null;
}

const isTt = (node, local) => node.local === local && (node.uri === "" || node.uri === TT_NS);
const isLrc = (node, local) => node.local === local && node.uri === LRC_NS;
const elements = node => node.children.filter(child => typeof child !== "string");
function attribute(node, local, uri = "") {
  return node.attributes.find(([name]) => {
    if (name === "xmlns" || name.startsWith("xmlns:")) return false;
    const expanded = expandedName(name, node.namespaces, true);
    return expanded[0] === uri && expanded[1] === local;
  })?.[1] || "";
}
const textContent = node => node.children.map(child => typeof child === "string" ? child
  : child.local === "br" ? " " : textContent(child)).join("").replace(/\s+/g, " ").trim();

function extractTtmlTranslations(content) {
  const tracks = [];
  const paragraphKeys = new Map();
  const document = readDocument(content);
  if (!document) return { tracks, paragraphKeys };
  const roles = new Map();
  const spanNames = new Map();
  const root = elements(document).find(node => isTt(node, "tt"));
  const lrcRed = root && Object.values(root.namespaces).includes(LRC_NS);
  const explicitWordBoundaries = root && attribute(root, "wordBoundaries", AMLL_NS) === "explicit";
  function visit(node, ancestors) {
    // Older imports can use ttm without declaring it. Keep that spelling
    // compatible while respecting declared namespace bindings and their scope.
    const role = attribute(node, "role", TTM_NS) ||
      (!node.namespaces.ttm && node.attributes.find(([name]) => name === "ttm:role")?.[1]);
    if (role && (isTt(node, "p") || isTt(node, "span"))) roles.set(node.start, role.trim().toLowerCase());
    if (node.local === "span") {
      const name = isTt(node, "span") ? "span" : node.name === "span" ? "skip" : node.name;
      if (name !== node.name) {
        const replacement = name.padEnd(node.name.length);
        spanNames.set(node.start + 1, replacement);
        if (node.close !== undefined) spanNames.set(node.close + 2, replacement);
      }
    }
    if (isTt(node, "p") && !ancestors.some(parent => isTt(parent, "head"))) {
      const key = attribute(node, "key", LRC_NS).trim();
      if (key) paragraphKeys.set(node.start, key);
    }
    if (isLrc(node, "sourceMetadata") && isTt(ancestors.at(-1) || {}, "metadata") &&
        isTt(ancestors.at(-2) || {}, "head")) {
      for (const translations of elements(node).filter(child => isLrc(child, "translations"))) {
        for (const translation of elements(translations).filter(child => isLrc(child, "translation"))) {
          const lines = elements(translation).filter(child => isLrc(child, "text")).map(child => ({
            key: attribute(child, "for").trim(), text: textContent(child),
          })).filter(line => line.key && line.text);
          if (!lines.length) continue;
          const automatic = attribute(translation, "automaticallyCreated");
          tracks.push({ language: translation.language.trim(),
            type: attribute(translation, "type").trim(),
            ...(/^(true|false)$/.test(automatic) ? { automaticallyCreated: automatic === "true" } : {}), lines });
        }
      }
    }
    for (const child of elements(node)) visit(child, [...ancestors, node]);
  }
  for (const node of elements(document)) visit(node, []);
  return { tracks, paragraphKeys, lrcRed, roles, spanNames, explicitWordBoundaries };
}

// Offsets refer to the original text, so callers can reuse timed spans while
// moving only complete, nonempty outer groups.
function findParentheticalGroups(text, includeEmpty = false) {
  const groups = [];
  const closing = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "(" || char === "（") {
      if (!closing.length) start = index;
      closing.push(char === "(" ? ")" : "）");
    } else if ((char === ")" || char === "）") && closing.length) {
      if (closing.pop() !== char) {
        closing.length = 0;
        continue;
      }
      if (!closing.length && (includeEmpty || text.slice(start + 1, index).trim())) {
        groups.push({ start, end: index + 1 });
      }
    }
  }
  return groups;
}

function unwrapTtmlBackgroundText(text) {
  const trimmed = text.trim();
  const [group] = findParentheticalGroups(trimmed, true);
  return group?.start === 0 && group.end === trimmed.length
    ? trimmed.slice(1, -1).trim() : trimmed;
}

function markLiteralBackgroundParentheses(line) {
  const vocals = (line.backgroundSyllables || []).map(atom => atom.text).join("").trim();
  const translation = String(line.backgroundTranslatedText || "").trim();
  if (unwrapTtmlBackgroundText(vocals) !== vocals || unwrapTtmlBackgroundText(translation) !== translation) {
    return line.literalBackgroundParentheses === true ? line : { ...line, literalBackgroundParentheses: true };
  }
  if (!line.literalBackgroundParentheses) return line;
  const { literalBackgroundParentheses, ...rest } = line;
  return rest;
}

const ATTACHING_PUNCTUATION = /^\s*[,.;:!?、。，．；：！？]/u;

function extractTimedBackgroundGroups(syllables) {
  const slices = [];
  let length = 0;
  for (const syllable of syllables) {
    slices.push({ syllable, start: length });
    length += syllable.text.length;
  }

  const groups = findParentheticalGroups(syllables.map(part => part.text).join(""));
  if (!groups.length) return null;

  // Splitting a span reuses its full original interval for both fragments.
  function slice(start, end) {
    return slices.flatMap(({ syllable, start: offset }) => {
      const left = Math.max(0, start - offset);
      const right = Math.min(syllable.text.length, end - offset);
      return left < right ? [{ ...syllable, text: syllable.text.slice(left, right) }] : [];
    });
  }

  function appendLead(lead, parts) {
    const previous = lead[lead.length - 1];
    const firstText = parts.findIndex(part => part.text.trim());
    const attaches = firstText >= 0 && ATTACHING_PUNCTUATION.test(parts[firstText].text);
    if (previous && attaches) {
      // A closing delimiter can leave whitespace in its own timed fragment.
      for (let index = lead.length - 1; index >= 0; index--) {
        lead[index].text = lead[index].text.trimEnd();
        if (lead[index].text) break;
      }
    }
    if (previous && (attaches || /\s$/.test(previous.text))) {
      if (firstText < 0) return;
      parts = parts.slice(firstText);
      parts[0].text = parts[0].text.trimStart();
    }
    lead.push(...parts);
  }

  function finish(parts) {
    const words = [];
    for (const part of parts) {
      if (part.text.trim()) words.push(part);
      else if (words.length) words[words.length - 1].text += part.text;
    }
    if (!words.length) return words;
    words[0].text = words[0].text.trimStart();
    words[words.length - 1].text = words[words.length - 1].text.trimEnd();
    for (let index = 0; index < words.length; index++) {
      const next = words[index + 1];
      words[index].isPartOfWord = Boolean(next && !/\s$/.test(words[index].text) && !/^\s/.test(next.text));
    }
    return words;
  }

  const lead = [];
  const background = [];
  let cursor = 0;
  for (const { start, end } of groups) {
    appendLead(lead, slice(cursor, start));
    const previous = background[background.length - 1];
    if (previous) previous.text += " ";
    background.push(...finish(slice(start + 1, end - 1)));
    cursor = end;
  }
  appendLead(lead, slice(cursor, length));
  return { lead: finish(lead), background, count: groups.length };
}

function splitTtmlBackgroundTranslation(text, count) {
  if (!count) return { text };
  const groups = findParentheticalGroups(text).slice(0, count);
  if (!groups.length) return { text };
  let cursor = 0;
  const lead = [];
  const background = [];
  for (const { start, end } of groups) {
    lead.push(text.slice(cursor, start));
    background.push(text.slice(start + 1, end - 1).trim());
    cursor = end;
  }
  lead.push(text.slice(cursor));
  const joined = lead.reduce((left, right) => {
    if (ATTACHING_PUNCTUATION.test(right)) return left.trimEnd() + right.trimStart();
    if (/\s$/.test(left) && /^\s/.test(right)) return left.trimEnd() + " " + right.trimStart();
    return left + right;
  });
  return { text: joined.trim(), backgroundText: background.join(" ") };
}

function resolveTtmlTranslationLanes(line, text, count, dedicatedBackground) {
  if (line.backgroundSyllables?.length && !line.syllables.length) {
    if (dedicatedBackground) return { backgroundText: dedicatedBackground };
    const split = splitTtmlBackgroundTranslation(text, count);
    return { backgroundText: split.backgroundText && !split.text
      ? split.backgroundText : unwrapTtmlBackgroundText(text) };
  }
  return dedicatedBackground ? { text, backgroundText: dedicatedBackground }
    : splitTtmlBackgroundTranslation(text, count);
}

const LANGUAGE_TAGS = {
  English: "en", Arabic: "ar", Bengali: "bn", "Chinese (Simplified)": "zh-hans", "Chinese (Traditional)": "zh-hant",
  Czech: "cs", Danish: "da", Dutch: "nl", Finnish: "fi", French: "fr", German: "de", Greek: "el", Hebrew: "he",
  Hindi: "hi", Hungarian: "hu", Indonesian: "id", Italian: "it", Japanese: "ja", Korean: "ko", Malay: "ms",
  Norwegian: "no", Persian: "fa", Polish: "pl", Portuguese: "pt", Romanian: "ro", Russian: "ru", Spanish: "es",
  Swedish: "sv", Tamil: "ta", Telugu: "te", Thai: "th", Turkish: "tr", Ukrainian: "uk", Urdu: "ur", Vietnamese: "vi",
};
function languageTag(value) {
  const tag = String(LANGUAGE_TAGS[value] || value || "").toLowerCase().replace(/_/g, "-");
  return tag.replace(/^zh-(cn|sg)(-|$)/, "zh-hans$2").replace(/^zh-(tw|hk|mo)(-|$)/, "zh-hant$2");
}
function languageScore(language, target) {
  const tag = languageTag(language);
  if (!tag || tag.split("-")[0] !== target.split("-")[0]) return 0;
  if (tag === target) return 3;
  if (target.startsWith("zh-") && tag.startsWith("zh-") && tag.split("-")[1] !== target.split("-")[1]) return 0;
  return 1;
}

// Source caches are language-independent. Select from retained tracks on every
// request. Retain inline/existing non-AI choices separately from applied source
// text, so a later Gemini pass cannot erase them. Source tracks may themselves
// be automatically created; their original provenance is never rewritten.
function selectTtmlTranslationTracks(packet, translationLanguage = "English") {
  const ttml = packet?.metadata?.ttml;
  const tracks = Array.isArray(ttml?.translationTracks) ? ttml.translationTracks : [];
  if (!Array.isArray(packet?.lyrics) || (!tracks.length && !ttml?.parentheticalBackgroundResolved)) return packet;
  const target = languageTag(translationLanguage);
  const translation = packet.metadata?.translation || packet.lyrics.translationMeta;
  const isAi = translation?.provider === "Gemini";
  const staleAi = isAi && translation.targetLanguage && languageTag(translation.targetLanguage) !== target;
  if (!tracks.length && !staleAi && !ttml.preservedTranslations?.length) return packet;
  const ranked = tracks.map((track, index) => ({ track, index, score: languageScore(track.language, target) }))
    .filter(entry => entry.score && (!entry.track.type || entry.track.type === "subtitle"))
    .sort((a, b) => b.score - a.score || Number(a.track.automaticallyCreated === true) - Number(b.track.automaticallyCreated === true) || a.index - b.index);
  const selected = ranked[0];
  const lookup = new Map();
  for (const { key, text } of selected?.track.lines || []) {
    // Identical repeats are harmless; conflicting duplicate keys are ambiguous.
    lookup.set(key, lookup.has(key) && lookup.get(key) !== text ? null : text);
  }
  const counts = new Map();
  for (const line of packet.lyrics) if (line.ttmlKey) counts.set(line.ttmlKey, (counts.get(line.ttmlKey) || 0) + 1);
  const previous = new Map((ttml.appliedTranslations || []).map(line => [line.key, line]));
  const preserved = new Map((ttml.preservedTranslations || []).map(line => [line.index, line]));
  const appliedTranslations = [];
  const lyrics = packet.lyrics.map((line, index) => {
    const current = String(line.translatedText || "").trim();
    const currentBackground = String(line.backgroundTranslatedText || "").trim();
    const prior = previous.get(line.ttmlKey);
    if (!isAi) {
      const saved = preserved.get(index);
      const text = current && current !== prior?.text ? current : "";
      const backgroundText = !saved?.backgroundText && currentBackground !== prior?.backgroundText ? currentBackground : "";
      if (text || backgroundText) preserved.set(index, { ...saved, index,
        ...(text ? { text } : {}), ...(backgroundText ? { backgroundText } : {}) });
    }
    const next = { ...line };
    if (staleAi || current === prior?.text) delete next.translatedText;
    if (staleAi || currentBackground === prior?.backgroundText) delete next.backgroundTranslatedText;
    const text = counts.get(line.ttmlKey) === 1 && lookup.get(line.ttmlKey);
    const choice = preserved.get(index);
    if (text && (!choice?.text || !choice?.backgroundText)) {
      const count = line.backgroundSyllables?.length && ttml.backgroundGroupCounts?.[index];
      const split = resolveTtmlTranslationLanes(line, text, count, choice?.backgroundText);
      const applied = { key: line.ttmlKey };
      if (!choice?.text) {
        if (split.text) next.translatedText = split.text;
        else delete next.translatedText;
        applied.text = split.text;
      }
      if (!choice?.backgroundText && split.backgroundText) {
        next.backgroundTranslatedText = split.backgroundText;
        applied.backgroundText = split.backgroundText;
      }
      if (Object.keys(applied).length > 1) appliedTranslations.push(applied);
    }
    if (choice?.text) next.translatedText = choice.text;
    if (choice?.backgroundText) next.backgroundTranslatedText = choice.backgroundText;
    return markLiteralBackgroundParentheses(next);
  });
  if (!staleAi && packet.lyrics.translationMeta) lyrics.translationMeta = packet.lyrics.translationMeta;
  const original = { ...ttml };
  delete original.selectedTranslationTrack;
  delete original.appliedTranslations;
  const metadata = { ...packet.metadata, ttml: { ...original,
    ...(selected ? { selectedTranslationTrack: selected.index } : {}),
    ...(tracks.length ? { appliedTranslations } : {}),
    ...(preserved.size ? { preservedTranslations: [...preserved.values()] } : {}) } };
  if (staleAi) delete metadata.translation;
  return { ...packet, lyrics, metadata };
}

// Match newly applied translations to the parsed background groups, then
// reselect any source subtitle for the requested language.
function mergeTtmlTranslationResult(base, lyrics, targetLanguage) {
  const ttml = base.metadata?.ttml;
  if (ttml?.parentheticalBackgroundResolved) {
    const translationMeta = lyrics.translationMeta;
    const preserved = new Map((ttml.preservedTranslations || []).map(line => [line.index, line]));
    lyrics = lyrics.map((line, index) => {
      const original = base.lyrics[index];
      const explicit = preserved.get(index)?.backgroundText;
      const count = line.backgroundSyllables?.length && ttml.backgroundGroupCounts?.[index];
      if (line.backgroundSyllables?.length && !line.syllables.length) {
        const { translatedText, ...next } = line;
        const { backgroundText } = resolveTtmlTranslationLanes(line, translatedText || "", count,
          explicit || line.backgroundTranslatedText);
        if (backgroundText) next.backgroundTranslatedText = backgroundText;
        return next;
      }
      if (explicit) {
        return { ...line, backgroundTranslatedText: explicit };
      }
      if (!line.translatedText || line.backgroundTranslatedText || line.translatedText === original?.translatedText) return line;
      const { text, backgroundText } = splitTtmlBackgroundTranslation(line.translatedText, count);
      if (!backgroundText) return line;
      const next = { ...line, backgroundTranslatedText: backgroundText };
      if (text) next.translatedText = text;
      else delete next.translatedText;
      return next;
    });
    lyrics = lyrics.map(markLiteralBackgroundParentheses);
    if (translationMeta) lyrics.translationMeta = translationMeta;
  }
  if ((ttml?.translationTracks?.length || ttml?.parentheticalBackgroundResolved) && lyrics.translationMeta) {
    lyrics = Object.assign([...lyrics], { translationMeta: { ...lyrics.translationMeta, targetLanguage } });
  }
  const packet = { ...base, lyrics, metadata: { ...base.metadata,
    translation: { ...base.metadata?.translation, ...lyrics.translationMeta } } };
  return selectTtmlTranslationTracks(packet, targetLanguage);
}

module.exports = { decodeText, extractTtmlTranslations, extractTimedBackgroundGroups, unwrapTtmlBackgroundText,
  resolveTtmlTranslationLanes, markLiteralBackgroundParentheses,
  selectTtmlTranslationTracks, mergeTtmlTranslationResult };
