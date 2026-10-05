import { bridgeClient } from '@/lib/bridge-client';
import { saveMobileVaultLyrics } from '@/lib/mobile-lyrics-vault';

export async function transferDesktopVaultToMobile(onProgress: (completed: number, total: number) => void) {
  const ids = new Set<string>();
  let offset: number | null = 0;
  // Always fetch the whole catalog, independently of the browsing filter.
  while (offset !== null) {
    const page = await bridgeClient.browseDesktopVault('', offset);
    for (const entry of page.entries || []) ids.add(entry.vaultId);
    const next = page.nextOffset ?? null;
    if (next !== null && next <= offset) throw new Error('Desktop Bridge returned an invalid catalog page. Refresh and try again.');
    offset = next;
  }
  let transferred = 0;
  const failures: string[] = [];
  onProgress(0, ids.size);
  for (const vaultId of ids) {
    let full;
    try {
      full = await bridgeClient.getDesktopVaultEntry(vaultId);
      if (full.vaultId !== vaultId) throw new Error('Desktop Bridge returned a different song.');
    } catch (error) {
      // Stop on a failed download instead of repeating a disconnected/timed-out request for every song.
      failures.push(error instanceof Error ? error.message : String(error));
      return { transferred, total: ids.size, failed: ids.size - transferred, error: failures[0] };
    }
    try {
      await saveMobileVaultLyrics({ track: full.track, lyrics: full.lyrics, originalSource: full.originalSource, metadata: full.metadata });
      transferred++;
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    onProgress(transferred + failures.length, ids.size);
  }
  return { transferred, total: ids.size, failed: failures.length, error: failures[0] };
}
