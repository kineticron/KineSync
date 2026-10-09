import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script } from 'node:vm'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const manifest = JSON.parse(
  readFileSync(resolve('public/previews/manifest.json'), 'utf8')
)
const digest = (value) => createHash('sha256').update(value).digest('hex')

test('website demo preserves the synced onboarding timing, translations and background vocals', () => {
  const website = JSON.parse(
    readFileSync(resolve('app/demo-lyrics.json'), 'utf8')
  )
  assert.equal(
    digest(readFileSync(resolve('app/demo-lyrics.json'))),
    manifest.demoSha256
  )
  assert.equal(website.length, 5)
  assert.equal(website.filter((line) => line.backgroundSyllables).length, 2)
  assert.ok(website.every((line) => line.translatedText))
  assert.equal(website[3].oppositeAligned, true)
})

for (const engine of ['spicy', 'amll']) {
  test(`${engine} export preserves the synced native renderer snapshot`, () => {
    const html = readFileSync(resolve(`out/previews/${engine}.html`), 'utf8')
    assert.equal(
      html,
      readFileSync(resolve(`public/previews/${engine}.html`), 'utf8')
    )
    assert.equal(digest(html), manifest.renderers[engine].htmlSha256)
    const scripts = [
      ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)
    ]
    assert.ok(scripts.length > 0)
    for (const script of scripts)
      assert.doesNotThrow(() => new Script(script[1]))
    assert.match(html, /name="color-scheme" content="dark"/)
    assert.doesNotMatch(html, /\$\{(?:escapeScript|AMLL_WEBVIEW|SPICY_WEBVIEW)/)
    assert.ok(statSync(resolve(`out/previews/${engine}.html`)).size < 800_000)
  })
}

test('download section includes only mobile releases and all four benefits', () => {
  const html = readFileSync(resolve('out/index.html'), 'utf8')
  assert.match(html, /KineSync-Android\.apk/)
  assert.match(html, /KineSync-iOS-unsigned\.ipa/)
  assert.doesNotMatch(
    html,
    /KineSync-Desktop|Download Desktop Bridge|View source/
  )
  for (const message of [
    '100% free',
    'No Spotify Premium',
    'Save and export your lyrics',
    'Fully open source'
  ])
    assert.ok(html.includes(message), message)
})
