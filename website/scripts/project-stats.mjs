import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const api = 'https://api.github.com/repos/Kineticron/KineSync'

// Stable releases in the last 90 days. Measure elapsed time between releases,
// including hotfixes, rather than promising a future publishing schedule.
export function releaseCadence(releases, now) {
  const cutoff = now - 90 * 86400000
  const dates = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => Date.parse(release.published_at))
    .filter((date) => Number.isFinite(date) && date >= cutoff && date <= now)
    .sort((a, b) => a - b)
  return {
    days:
      dates.length > 1
        ? Math.max(
            1,
            Math.round(
              (dates.at(-1) - dates[0]) / (dates.length - 1) / 86400000
            )
          )
        : null,
    releases: dates.length,
    windowDays: 90
  }
}

async function github(path) {
  const response = await fetch(`${api}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'KineSync-website'
    },
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw new Error(`GitHub ${response.status}`)
  return {
    data: await response.json(),
    next: response.headers.get('link')?.includes('rel="next"')
  }
}

async function refresh() {
  const destination = new URL('../app/project-stats.json', import.meta.url)
  try {
    const [{ data: repo }, { data: releases }] = await Promise.all([
      github(''),
      github('/releases?per_page=100')
    ])
    let contributors = 0
    for (let page = 1; ; page++) {
      const result = await github(`/contributors?per_page=100&page=${page}`)
      contributors += result.data.filter(
        (person) => person.type !== 'Bot'
      ).length
      if (!result.next) break
    }
    const now = Date.now()
    const snapshot = {
      stars: repo.stargazers_count,
      contributors,
      license: repo.license?.spdx_id ?? 'See license',
      updatedAt: new Date(now).toISOString(),
      cadence: releaseCadence(releases, now)
    }
    await writeFile(destination, JSON.stringify(snapshot, null, 2) + '\n')
    console.log('Refreshed public GitHub project statistics.')
  } catch (error) {
    // Pages remains buildable offline; the UI always labels the snapshot date.
    await readFile(destination, 'utf8')
    console.warn(`Using the saved GitHub snapshot: ${error.message}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await refresh()
