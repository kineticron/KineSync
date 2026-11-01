// Cache actions can report warning-only save failures. Accept only a server record
// for this unique run/attempt/variant key and ref, with a positive stored size.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyCache({ key, ref, repository, token, api = 'https://api.github.com', request = fetch }) {
  if (!key || !ref || !repository || !token) throw new Error('Missing cache verification identity/authentication');
  const url = new URL(`/repos/${repository}/actions/caches`, api);
  url.searchParams.set('key', key);
  url.searchParams.set('ref', ref);
  url.searchParams.set('per_page', '100');
  // API key filtering is prefix-based. Bound both pagination and visibility delay.
  for (let attempt = 0; attempt < 4; attempt++) {
    for (let page = 1; page <= 5; page++) {
      url.searchParams.set('page', String(page));
      const response = await request(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(3000), redirect: 'error',
      });
      // Authentication, quota and server failures are not retried.
      if (!response.ok) throw new Error(`Cache API verification failed: HTTP ${response.status}`);
      const data = await response.json();
      const cache = data.actions_caches?.find(entry => entry.key === key && entry.ref === ref && Number.isSafeInteger(entry.id) && entry.id > 0 && entry.size_in_bytes > 0);
      if (cache) return { key, ref, id: cache.id, sizeInBytes: cache.size_in_bytes, verified: true };
      if ((data.actions_caches?.length || 0) < 100) break;
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, request === fetch ? 5000 : 0));
  }
  throw new Error(`Cache save NOT confirmed by server for exact key/ref: ${key} (${ref})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyCache({ key: process.env.CACHE_KEY, ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN, api: process.env.GITHUB_API_URL });
    console.log(`Cache save server-confirmed: ${JSON.stringify(result)}`);
    const dir = path.resolve('ExpoLyrics/.expo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `cache-verification-${result.key.startsWith('ios-sim-pods-') ? 'pods' : 'compiler'}.json`), JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `cache-id=${result.id}\ncache-size=${result.sizeInBytes}\nverified=true\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nCache save verified on server: ID ${result.id}, ${result.sizeInBytes} bytes, key \`${result.key}\`.\n`);
  } catch (error) {
    console.error(error.message);
    fs.mkdirSync('ExpoLyrics/.expo', { recursive: true });
    fs.writeFileSync(`ExpoLyrics/.expo/cache-verification-${process.env.CACHE_KEY?.startsWith('ios-sim-pods-') ? 'pods' : 'compiler'}.json`, JSON.stringify({ verified: false, key: process.env.CACHE_KEY, ref: process.env.GITHUB_REF, error: error.message }, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nCache save verification FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
