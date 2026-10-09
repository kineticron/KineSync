import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = resolve('out')
const html = readFileSync(join(root, 'index.html'), 'utf8')
test('export has crawlable content and search metadata', () => {
  assert.match(html, /<h1[^>]*>Your music/)
  assert.match(html, /rel="canonical" href="https:\/\/kineticron.github.io\/KineSync\/"/)
  assert.match(html, /application\/ld\+json/)
  assert.match(html, /SoftwareApplication/)
  assert.match(html, /name="description"/)
  assert.match(html, /property="og:image"/)
  assert.match(html, /KineSync-Android.apk/)
  assert.match(html, /<details>/)
  for (const file of ['robots.txt', 'sitemap.xml', 'social-card.png', 'icon.svg']) assert.ok(existsSync(join(root, file)), file)
})
test('all exported script, stylesheet, and image references resolve under the Pages subpath', () => {
  const assets = [...html.matchAll(/(?:src|href)="(\/KineSync\/[^"?#]+)"/g)].map(match => match[1])
  assert.ok(assets.length > 3)
  for (const asset of assets) assert.ok(existsSync(join(root, decodeURIComponent(asset.slice('/KineSync/'.length)))), asset)
  assert.doesNotMatch(html, /fonts.googleapis.com|googletagmanager|google-analytics/)
})
test('initial images stay within the landing page asset budget', () => {
  assert.ok(statSync(join(root, 'social-card.png')).size < 300_000)
  assert.ok(statSync(join(root, 'icon.svg')).size < 2000)
  const walk = folder => readdirSync(folder).flatMap(name => {
    const file = join(folder, name)
    return statSync(file).isDirectory() ? walk(file) : [file]
  })
  const jsBytes = walk(join(root, '_next/static')).filter(file => file.endsWith('.js')).reduce((sum, file) => sum + statSync(file).size, 0)
  assert.ok(jsBytes < 1_500_000, `JavaScript total: ${jsBytes} bytes`)
  console.log(`Static JavaScript budget: ${jsBytes} bytes before compression`)
})
