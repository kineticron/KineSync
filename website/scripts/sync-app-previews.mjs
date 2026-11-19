import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'

// Share the native app's complete HTML host and generated renderer bundles.
// Keep these in isolated frames so native engine styles never leak into the site.
const app = resolve('../ExpoLyrics/components/lyrics')
const destination = resolve('public/previews')
await mkdir(destination, { recursive: true })
// Onboarding and website must use the same original lyrics, timing and vocals.
const demoSource = await readFile(
  resolve('../ExpoLyrics/lib/onboarding-demo-lyrics.ts'),
  'utf8'
)
const demoModule = { exports: {} }
runInNewContext(
  ts.transpileModule(demoSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText,
  demoModule
)
await writeFile(
  resolve('app/demo-lyrics.json'),
  JSON.stringify(demoModule.exports.DEMO_LYRICS, null, 2) + '\n'
)
const digest = (value) => createHash('sha256').update(value).digest('hex')
const manifest = {
  demoSha256: digest(await readFile(resolve('app/demo-lyrics.json'))),
  renderers: {}
}
for (const engine of ['spicy', 'amll']) {
  const prefix = engine.toUpperCase()
  const bundle = await readFile(
    resolve(app, `${engine}-webview-bundle.ts`),
    'utf8'
  )
  const value = (kind) => {
    const literal = bundle.match(
      new RegExp(`export const ${prefix}_WEBVIEW_${kind} = (.+);`)
    )?.[1]
    if (!literal) throw new Error(`Missing ${engine} ${kind} bundle`)
    return JSON.parse(literal)
  }
  const host = await readFile(resolve(app, `${engine}-lyrics-view.tsx`), 'utf8')
  let html = host.match(/return `(<!doctype[\s\S]*?)`;/i)?.[1]
  if (!html) throw new Error(`Missing ${engine} HTML host`)
  html = html
    .replace('<head>', '<head>\n<meta name="color-scheme" content="dark" />')
    .replace(`\${${prefix}_WEBVIEW_CSS}`, () => value('CSS'))
    .replace(`\${escapeScript(${prefix}_WEBVIEW_JS)}`, () =>
      value('JS').replace(/<\/script/gi, '<\\/script')
    )
  html = html.replace(
    '<body>',
    `<body>
<script>window.ReactNativeWebView = { postMessage: function(raw) { parent.postMessage({ kind: 'kinesync-preview', payload: JSON.parse(raw) }, location.origin); } };</script>`
  )
  await writeFile(resolve(destination, `${engine}.html`), html)
  manifest.renderers[engine] = { htmlSha256: digest(html) }
}
await writeFile(
  resolve(destination, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
)
await sharp(resolve('design/emulator-reference.png'))
  .resize({ width: 720 })
  .webp({ quality: 85 })
  .toFile(resolve(destination, 'player.webp'))
await sharp(resolve('../Previews/KineSyncPortraits.png'))
  .extract({ left: 791, top: 177, width: 337, height: 702 })
  .resize({ width: 480 })
  .webp({ quality: 85 })
  .toFile(resolve(destination, 'artwork.webp'))
await sharp(resolve('../ExpoLyrics/assets/images/R.png'))
  .resize(256, 256)
  .png()
  .toFile(resolve('public/app-icon.png'))
await copyFile(
  resolve('../ExpoLyrics/LICENSE'),
  resolve('public/licenses/app-renderers.txt')
)
console.log('Synced native renderer hosts and provisional app captures.')
