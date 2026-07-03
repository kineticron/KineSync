"use strict";

// Local lyrics vault source — serves persisted lyrics without network calls.
// Evaluated by ../index.js in the shared lyrics VM context.

const { getLyricsVaultStore } = require("./lyricsVault");

async function fetchFromLocalVault(track) {
  const store = getLyricsVaultStore();
  if (!store || typeof store.lookup !== "function") {
    return null;
  }

  const entry = store.lookup(track);
  if (!entry?.lyrics?.length) {
    return null;
  }

  return {
    lyrics: entry.lyrics,
    source: entry.sourceLabel,
    metadata: {
      ...(entry.metadata || {}),
      vault: {
        vaultId: entry.vaultId,
        savedAt: Number(entry.manifest?.savedAt || 0),
        originalSource: String(entry.manifest?.originalSource || ""),
      },
    },
  };
}
