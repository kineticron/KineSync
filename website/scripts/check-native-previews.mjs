import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import assert from 'node:assert/strict'

// Run against the app checkout when syncing; Pages verifies the saved snapshot.
const demoModule = { exports: {} }
runInNewContext(
  ts.transpileModule(
    readFileSync(
      resolve('../ExpoLyrics/lib/onboarding-demo-lyrics.ts'),
      'utf8'
    ),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }
  ).outputText,
  demoModule
)
assert.deepEqual(
  JSON.parse(readFileSync(resolve('app/demo-lyrics.json'), 'utf8')),
  JSON.parse(JSON.stringify(demoModule.exports.DEMO_LYRICS))
)
for (const engine of ['spicy', 'amll']) {
  const bundle = readFileSync(
    resolve(`../ExpoLyrics/components/lyrics/${engine}-webview-bundle.ts`),
    'utf8'
  )
  const html = readFileSync(resolve(`public/previews/${engine}.html`), 'utf8')
  for (const kind of ['JS', 'CSS']) {
    const source = JSON.parse(
      bundle.match(
        new RegExp(
          `export const ${engine.toUpperCase()}_WEBVIEW_${kind} = (.+);`
        )
      )[1]
    )
    assert.ok(
      html.includes(
        kind === 'JS' ? source.replace(/<\/script/gi, '<\\/script') : source
      ),
      `${engine} ${kind} must match the app`
    )
  }
}
console.log('Website demo and renderer snapshots match the current mobile app.')
