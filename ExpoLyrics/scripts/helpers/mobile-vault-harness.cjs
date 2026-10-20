const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');

// Exercise the real SQL and transactions using SQLite, adapting only Expo's
// native async boundary so these checks can also run on desktop CI.
function loadMobileVault({ legacy = null, filename = ':memory:', resolveImportedTrack = async track => track } = {}) {
  let database;
  let backup = legacy;
  const queries = [];
  const context = { exports: {}, setTimeout, clearTimeout, require(name) {
    if (name === '@react-native-async-storage/async-storage') return { getItem: async () => backup, setItem: async (_key, value) => { backup = value; } };
    if (name === '@/lib/lyrics-policy') return require('../../lib/lyrics-policy');
    if (name === '@/lib/vault-spotify-match') return { resolveImportedVaultTrack: resolveImportedTrack };
    assert.equal(name, 'expo-sqlite');
    return { openDatabaseAsync: async () => {
      database = new DatabaseSync(filename);
      return {
        execAsync: async sql => { queries.push(sql); database.exec(sql); },
        runAsync: async (sql, ...params) => { queries.push(sql); return database.prepare(sql).run(...params); },
        getFirstAsync: async (sql, ...params) => { queries.push(sql); return database.prepare(sql).get(...params) || null; },
        getAllAsync: async (sql, ...params) => { queries.push(sql); return database.prepare(sql).all(...params); },
        closeAsync: async () => { database.close(); database = undefined; },
      };
    } };
  } };
  const source = fs.readFileSync(path.resolve(__dirname, '../../lib/mobile-lyrics-vault.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { vault: context.exports, queries, get database() { return database; },
    get backup() { return backup; }, set backup(value) { backup = value; },
    close() { if (database) { database.close(); database = undefined; } } };
}
module.exports = { loadMobileVault };
