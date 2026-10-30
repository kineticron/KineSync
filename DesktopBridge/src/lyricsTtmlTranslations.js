"use strict";

const LRC_NS = "http://lrc.red/lyric-ttml-internal";
const TT_NS = "http://www.w3.org/ns/ttml";
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
  function visit(node, ancestors) {
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
  return { tracks, paragraphKeys };
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
// request, replacing only text previously supplied by this metadata. Inline or
// subsequently enriched translations remain authoritative. Explicit AI requests
// still use the existing service path and can replace source translations.
function selectTtmlTranslationTracks(packet, translationLanguage = "English") {
  const ttml = packet?.metadata?.ttml;
  if (!Array.isArray(ttml?.translationTracks) || !ttml.translationTracks.length || !Array.isArray(packet.lyrics) ||
      packet.metadata?.translation?.translatedLineCount > 0 || packet.lyrics.translationMeta?.translatedLineCount > 0) return packet;
  const target = languageTag(translationLanguage);
  const ranked = ttml.translationTracks.map((track, index) => ({ track, index, score: languageScore(track.language, target) }))
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
  const previous = new Map((ttml.appliedTranslations || []).map(line => [line.key, line.text]));
  const appliedTranslations = [];
  const lyrics = packet.lyrics.map(line => {
    const current = String(line.translatedText || "").trim();
    if (current && current !== previous.get(line.ttmlKey)) return line;
    const next = { ...line };
    delete next.translatedText;
    const text = counts.get(line.ttmlKey) === 1 && lookup.get(line.ttmlKey);
    if (text) { next.translatedText = text; appliedTranslations.push({ key: line.ttmlKey, text }); }
    return next;
  });
  if (packet.lyrics.translationMeta) lyrics.translationMeta = packet.lyrics.translationMeta;
  const original = { ...ttml };
  delete original.selectedTranslationTrack;
  delete original.appliedTranslations;
  return { ...packet, lyrics, metadata: { ...packet.metadata, ttml: { ...original,
    ...(selected ? { selectedTranslationTrack: selected.index } : {}), appliedTranslations } } };
}

module.exports = { extractTtmlTranslations, selectTtmlTranslationTracks };
