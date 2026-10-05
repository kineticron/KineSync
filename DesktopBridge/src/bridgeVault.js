// Shared by direct and relay transports; request IDs correlate replies on mobile.
function attachBridgeVault(transport, getStore) {
  for (const action of ['list', 'get']) {
    transport.on(action === 'list' ? 'vaultListRequested' : 'vaultGetRequested', (request = {}) => {
      const { requestId, reply } = request;
      if (typeof reply !== 'function') return;
      const response = { type: `vault:${action}:result`, requestId };
      try {
        const store = getStore();
        if (!store) throw new Error('Lyrics vault is not initialized.');
        if (action === 'list') {
          const query = String(request.query || '').trim().toLowerCase();
          const entries = store.listEntries().filter(entry => `${entry.title} ${entry.artist}`.toLowerCase().includes(query));
          const offset = request.offset || 0;
          const page = entries.slice(offset, offset + 50).map(({ vaultId, title, artist, lineCount, translatedLineCount }) => ({ vaultId, title, artist, lineCount, translatedLineCount }));
          reply({ ...response, ok: true, entries: page, total: entries.length, nextOffset: offset + page.length < entries.length ? offset + page.length : null });
        } else {
          const full = store.getEntry(request.vaultId);
          if (!full?.lyrics?.length) throw new Error('These lyrics are no longer available on the Desktop Bridge. Refresh the catalog.');
          const manifest = full.manifest || {};
          const entry = {
            vaultId: request.vaultId,
            track: { id: manifest.spotifyTrackId || request.vaultId, title: manifest.title || 'Unknown title', artist: manifest.artist || 'Unknown artist', album: manifest.album || '', durationMs: Number(manifest.durationMs || 0), spotifyTrackId: manifest.spotifyTrackId || undefined },
            lyrics: full.lyrics,
            originalSource: manifest.originalSource || full.sourceLabel || 'desktop-vault',
            metadata: manifest.metadata || {},
          };
          const packet = { ...response, ok: true, entry };
          if (Buffer.byteLength(JSON.stringify(packet)) > 7 * 1024 * 1024) throw new Error('These lyrics are too large to transfer to the device.');
          reply(packet);
        }
      } catch (error) {
        reply({ ...response, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}

module.exports = { attachBridgeVault };
