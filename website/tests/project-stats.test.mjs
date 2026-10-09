import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseCadence } from '../scripts/project-stats.mjs'

test('release rhythm uses stable published releases in the last 90 days', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const release = (date, extra = {}) => ({
    published_at: date,
    prerelease: false,
    draft: false,
    ...extra
  })
  const result = releaseCadence(
    [
      release('2026-10-07T00:00:00Z'),
      release('2026-09-09T00:00:00Z'),
      release('2026-09-23T00:00:00Z'),
      release('2026-10-08T00:00:00Z', { prerelease: true }),
      release('2026-10-08T00:00:00Z', { draft: true }),
      release('2026-07-01T00:00:00Z'),
      release('2026-10-10T00:00:00Z'),
      release(null)
    ],
    now
  )
  assert.deepEqual(result, { days: 14, releases: 3, windowDays: 90 })
})

test('sparse release history does not invent a cadence; same-day hotfixes retain a sensible display', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  assert.equal(releaseCadence([], now).days, null)
  assert.equal(
    releaseCadence([{ published_at: '2026-10-07T00:00:00Z' }], now).days,
    null
  )
  assert.equal(
    releaseCadence(
      [
        { published_at: '2026-10-07T00:00:00Z' },
        { published_at: '2026-10-07T02:00:00Z' }
      ],
      now
    ).days,
    1
  )
})
