"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const { pickAutoLyrics } = require("../src/lyricsAutoPicker")
const fixtures = require("./fixtures/lrc-red-auto.json")
const seesawFixture = require("./fixtures/seesaw-picker.json")

function packet(fixture) {
  return {
    source: fixture.source,
    metadata: { attribution: fixture.attribution },
    lyrics: fixture.lines.map(([start, end, text, background]) => ({
      lineStartTime: start,
      lineEndTime: end,
      syllables: [{ text, startTime: start, endTime: end }],
      ...(background ? { backgroundSyllables: [{ text: background, startTime: start, endTime: end }] } : {}),
    })),
  }
}

const pairs = fixtures.cases.map(f => ({ ...f, lrc: packet(f.lrc), spicy: packet(f.spicy) }))
for (const pair of pairs) {
  test(`captured ${pair.name}: picks ${pair.expected}`, () => {
    const decision = pickAutoLyrics(pair.lrc, pair.spicy)
    assert.equal(decision.result, pair[pair.expected])
    assert.equal(typeof decision.reason, "string")
  })
}

const clone = value => JSON.parse(JSON.stringify(value))
const equivalent = () => ({ lrc: clone(pairs[0].lrc), spicy: clone(pairs[0].spicy) })

test("picker respects inclusive timing tolerance, NFKC, whitespace, background and granularity", () => {
  let { lrc, spicy } = equivalent()
  lrc.lyrics[0].syllables = [{ text: "Ｆｏｏ \n bar" }]
  spicy.lyrics[0].syllables = [{ text: "Foobar" }]
  lrc.lyrics[0].lineStartTime = spicy.lyrics[0].lineStartTime + 100
  lrc.lyrics[0].lineEndTime = spicy.lyrics[0].lineEndTime - 100
  assert.equal(pickAutoLyrics(lrc, spicy).result, lrc)
  lrc.lyrics[0].lineEndTime -= 1
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "line-timing-mismatch")
  const backgroundPair = equivalent()
  backgroundPair.lrc.lyrics[0].backgroundSyllables = [{ text: "Different background" }]
  assert.equal(pickAutoLyrics(backgroundPair.lrc, backgroundPair.spicy).reason, "background-text-mismatch")
  lrc = clone(pairs[0].lrc)
  spicy = clone(pairs[0].spicy)
  lrc.source = "lrc-red-line"
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "spicy-finer-timing")
  spicy.source = "spicy-lyrics-line"
  assert.equal(pickAutoLyrics(lrc, spicy).result, lrc)
  lrc.source = "lrc-red-karaoke"
  assert.equal(pickAutoLyrics(lrc, spicy).result, lrc)
  spicy.metadata.attribution.source = "spl"
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "spicy-community")
})

test("live seesaw sample chooses equivalent lrc.red over Apple Music Spicy and leaves community Spicy absolute", () => {
  const packet = (fixture) => ({
    source: fixture.source,
    metadata: fixture.metadata || {},
    lyrics: fixture.lyrics.map(line => ({
      lineStartTime: line.lineStartTime,
      lineEndTime: line.lineEndTime,
      text: line.text,
      syllables: [{ text: line.text }],
    })),
  })
  const lrc = packet(seesawFixture.lrc)
  const appleMusicSpicy = packet(seesawFixture.spicy)
  const decision = pickAutoLyrics(lrc, appleMusicSpicy)
  assert.equal(decision.reason, "equivalent-lrc")
  assert.equal(decision.result, lrc)
  appleMusicSpicy.metadata.attribution.source = "spicy_lyrics"
  assert.equal(pickAutoLyrics(lrc, appleMusicSpicy).reason, "spicy-community")
  assert.equal(pickAutoLyrics(lrc, appleMusicSpicy).result, appleMusicSpicy)
})

test("equivalence normalizes case and punctuation, ignores auxiliary romanization, and requires same-script lead text", () => {
  const { lrc, spicy } = equivalent()
  lrc.lyrics[0].syllables = [{ text: "ＦＯＯ, Bar!" }]
  spicy.lyrics[0].syllables = [{ text: "foo bar?" }]
  lrc.lyrics[0].syllables[0].romanization = "auxiliary one"
  spicy.lyrics[0].syllables[0].romanization = "auxiliary two"
  lrc.lyrics[0].romanization = "unrelated auxiliary form"
  spicy.lyrics[0].romanization = "another auxiliary form"
  lrc.lyrics[0].translations = ["translation one"]
  spicy.lyrics[0].translations = ["translation two"]
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "equivalent-lrc")
  spicy.lyrics[0].syllables = [{ text: "푸 바" }]
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "lead-text-mismatch", "main lyric text must never be transliterated across scripts")
})

test("background vocals compare across split storage while missing or changed text still rejects equivalence", () => {
  const { lrc, spicy } = equivalent()
  lrc.lyrics[0].backgroundSyllables = [{ text: "(oh" }, { text: "!)" }]
  spicy.lyrics[0].backgroundText = "(OH!)"
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "equivalent-lrc")
  delete spicy.lyrics[0].backgroundText
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "background-text-mismatch")
  spicy.lyrics[0].backgroundSyllables = [{ text: "(no)" }]
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "background-text-mismatch")
})

test("picker handles absent, static and invalid timing results without mutation", () => {
  const { lrc, spicy } = equivalent()
  const before = JSON.stringify([lrc, spicy])
  assert.equal(pickAutoLyrics(lrc, null).result, lrc)
  assert.equal(pickAutoLyrics(null, spicy).result, spicy)
  assert.equal(pickAutoLyrics(null, null).result, null)
  const staticSpicy = { ...spicy, source: "spicy-lyrics-static" }
  assert.equal(pickAutoLyrics(lrc, staticSpicy).result, lrc)
  assert.equal(pickAutoLyrics(null, staticSpicy).result, staticSpicy)
  assert.equal(JSON.stringify([lrc, spicy]), before)
  lrc.lyrics[0].lineStartTime = NaN
  assert.equal(pickAutoLyrics(lrc, spicy).reason, "line-timing-mismatch")
})

function load(mobile) {
  const src = path.resolve(__dirname, "../src")
  const context = vm.createContext({
    AbortController, Buffer, clearTimeout, setTimeout, clearInterval, setInterval,
    TextDecoder, URL, URLSearchParams, console: { ...console, debug() {} },
    fetch: () => { throw Error("Unexpected network request") },
    global: {}, module: { exports: {} }, process: { env: {} },
    require: createRequire(path.join(src, "lyricsService.js")),
  })
  if (mobile) {
    let source = fs.readFileSync(path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js"), "utf8")
    source = source.replace(/^import .*;\r?\n/gm, "")
    vm.runInContext(source.slice(0, source.indexOf("export {")), context)
  } else {
    const index = fs.readFileSync(path.join(src, "lyrics/index.js"), "utf8")
    for (const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(src, "lyrics/parts", match[1]), "utf8"), context)
    }
  }
  const fetchers = vm.runInContext("SOURCE_FETCHERS", context)
  for (const key of Object.keys(fetchers)) fetchers[key] = async () => null
  const track = { trackId: "track-one", spotifyTrackId: "6dfJecdkrYg19hefBy4kts", title: "Example", artist: "Artist", durationMs: 10000 }
  const run = (options = {}) => {
    context.track = track
    context.options = { spicyLyricsPublishableKey: "sl_pk_test", autoSourceTimeoutMs: 30, ...options }
    return vm.runInContext("fetchBestSyncedLyrics(track, options)", context)
  }
  return { context, fetchers, run }
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop"
  for (const pair of pairs) {
    test(`${platform}: auto selection uses the captured ${pair.name} decision`, async () => {
      const { fetchers, run } = load(mobile)
      fetchers["lrc-red"] = async () => clone(pair.lrc)
      fetchers["spicy-lyrics"] = async () => clone(pair.spicy)
      const result = await run({ waitForAutoCompletion: true })
      assert.equal(result.source, pair[pair.expected].source)
    })
  }

  test(`${platform}: publishes the first result immediately then upgrades to the captured Spicy winner`, async () => {
    const { fetchers, run } = load(mobile)
    let resolveLrc, resolveSpicy, calls = 0
    fetchers["lrc-red"] = () => { calls++; return new Promise(resolve => { resolveLrc = resolve }) }
    fetchers["spicy-lyrics"] = () => { calls++; return new Promise(resolve => { resolveSpicy = resolve }) }
    const sourceCache = new Map()
    const progress = []
    const pending = run({ sourceCache, autoSourceTimeoutMs: 1000, onProgress: packet => progress.push(packet.source) })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 2)
    resolveLrc(clone(pairs[1].lrc))
    assert.equal((await pending).source, pairs[1].lrc.source)
    assert.equal(sourceCache.has("auto"), false, "pending Spicy precedence prevents caching a partial choice")
    resolveSpicy(clone(pairs[1].spicy))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sourceCache.get("auto").source, "spicy-lyrics-syllable")
    assert.deepEqual(progress, [pairs[1].lrc.source, "spicy-lyrics-syllable"])
    assert.equal((await run({ sourceCache })).source, "spicy-lyrics-syllable")
    assert.equal(calls, 2)
  })

  for (const missing of ["lrc-red", "spicy-lyrics"]) {
    for (const failure of ["timeout", "error", "empty"]) {
      test(`${platform}: ${missing} ${failure} uses the synced sibling`, async () => {
        const { fetchers, run } = load(mobile)
        fetchers["lrc-red"] = async () => clone(pairs[0].lrc)
        fetchers["spicy-lyrics"] = async () => clone(pairs[0].spicy)
        fetchers[missing] = failure === "timeout" ? () => new Promise(() => {})
          : failure === "error" ? async () => { throw Error("unavailable") } : async () => null
        const result = await run()
        assert.equal(result.source, missing === "lrc-red" ? "spicy-lyrics-syllable" : "lrc-red-karaoke")
      })
    }
  }

  test(`${platform}: manual choices stay isolated and static Spicy loses to synced lrc.red`, async () => {
    const { fetchers, run } = load(mobile)
    let spicyCalls = 0
    fetchers["lrc-red"] = async () => clone(pairs[0].lrc)
    fetchers["spicy-lyrics"] = async () => { spicyCalls++; return clone(pairs[0].spicy) }
    assert.equal((await run({ preferredSource: "lrc-red" })).source, "lrc-red-karaoke")
    assert.equal(spicyCalls, 0)
    assert.equal((await run({ preferredSource: "spicy-lyrics" })).source, "spicy-lyrics-syllable")
    fetchers["spicy-lyrics"] = async () => ({ ...clone(pairs[0].spicy), source: "spicy-lyrics-static" })
    assert.equal((await run()).source, "lrc-red-karaoke")
  })

  test(`${platform}: both primary providers failing still allow another synced source`, async () => {
    const { fetchers, run } = load(mobile)
    fetchers["lrc-red"] = async () => { throw Error("unavailable") }
    fetchers["spicy-lyrics"] = () => new Promise(() => {})
    fetchers.netease = async () => ({ ...clone(pairs[0].lrc), source: "netease-yrc" })
    assert.equal((await run()).source, "netease-yrc")
  })

  test(`${platform}: a late community response upgrades the provisional result and final cache`, async () => {
    const { fetchers, run } = load(mobile)
    let resolveSpicy
    fetchers["lrc-red"] = async () => clone(pairs[0].lrc)
    fetchers["spicy-lyrics"] = () => new Promise(resolve => { resolveSpicy = resolve })
    const sourceCache = new Map()
    let progress = 0
    const result = await run({ sourceCache, onProgress: () => { progress++ } })
    resolveSpicy(clone(pairs[4].spicy))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sourceCache.get("auto")?.source, "spicy-lyrics-syllable")
    assert.equal(progress, 2, "initial publication and one superior community upgrade")
    assert.equal(result.source, "lrc-red-karaoke")
  })

  test(`${platform}: cached community result returns without waiting for lrc.red`, async () => {
    const { fetchers, run } = load(mobile)
    fetchers["lrc-red"] = () => new Promise(() => {})
    const sourceCache = new Map([["spicy-lyrics", clone(pairs[4].spicy)]])
    const result = await Promise.race([run({ sourceCache, autoSourceTimeoutMs: 500 }),
      new Promise((_, reject) => setTimeout(() => reject(Error("community result waited")), 100))])
    assert.equal(result.metadata.attribution.source, "spicy_lyrics")
  })

  test(`${platform}: Spicy Line excludes interludes and already segments captured Korean text`, () => {
    const { context } = load(mobile)
    context.payload = { Type: "Line", Content: [
      { Type: "Interlude", StartTime: 0, EndTime: 10 }, fixtures.rewindSpicyVocal,
    ] }
    const lines = vm.runInContext("parseSpicyLyrics(payload)", context)
    assert.equal(lines.length, 1)
    assert(lines[0].syllables.length > 1)
  })
}

for (const [platform, importer] of [
  ["desktop", require("../src/lyricsTtmlImport")],
  ["mobile", require("../../ExpoLyrics/lib/lyrics-ttml-import")],
]) {
  test(`${platform}: captured Rewind TTML interpolates words across the exact line boundaries`, () => {
    const parsed = importer.parseTtmlToLyrics(`<tt lrc:timing="Line"><body>${fixtures.rewindParagraph}</body></tt>`)
    const line = parsed.lyrics[0]
    assert.equal(parsed.useKaraokeTiming, false)
    assert.equal(line.syllables.length, 4)
    assert.equal(line.syllables.map(s => s.text).join(""), "미처 몰랐던 네 모습")
    assert.equal(line.syllables[0].startTime, line.lineStartTime)
    assert.equal(line.syllables.at(-1).endTime, line.lineEndTime)
    assert(line.syllables.every(s => s.endTime > s.startTime))
    for (let i = 1; i < line.syllables.length; i++) {
      assert.equal(line.syllables[i].startTime, line.syllables[i - 1].endTime)
    }
  })

  test(`${platform}: unspaced CJK line imports segment while Word TTML retains supplied spans`, () => {
    const paragraph = '<p begin="1" end="4">君の笑顔</p>'
    const line = importer.parseTtmlToLyrics(`<tt lrc:timing="Line">${paragraph}</tt>`).lyrics[0]
    assert.equal(line.syllables.length, 4)
    assert.equal(line.syllables.map(s => s.text).join(""), "君の笑顔")
    const word = importer.parseTtmlToLyrics('<tt lrc:timing="Word"><p begin="1" end="4"><span begin="1" end="4">君の笑顔</span></p></tt>').lyrics[0]
    assert.equal(word.syllables.length, 1)
    assert.equal(word.syllables[0].startTime, 1000)
    assert.equal(word.syllables[0].endTime, 4000)
  })
}
