"use strict"

// Keep Korean words intact. Unspaced Japanese and Chinese advance by character.
function segmentTimedLine(text, startTime, endTime) {
  const chunks = String(text || "").trim().match(/\S+\s*/gu) || []
  const parts = chunks.flatMap(chunk => chunk.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]\p{M}*|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
  ) || [])
  // Whitespace belongs to the preceding segment, never to a timed empty segment.
  const words = []
  for (const part of parts) {
    if (/^\s+$/u.test(part) && words.length) words[words.length - 1] += part
    else words.push(part)
  }
  return words.map((word, index) => ({
    text: word,
    startTime: startTime + (endTime - startTime) * index / words.length,
    endTime: index === words.length - 1
      ? endTime : startTime + (endTime - startTime) * (index + 1) / words.length,
    isPartOfWord: index < words.length - 1 && !/\s$/u.test(word),
  }))
}

module.exports = { segmentTimedLine }
