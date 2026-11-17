"use strict";

function createExportRequestRegistry() {
  let latest = 0;
  const canceled = new Set();
  return {
    start() {
      latest += 1;
      return latest;
    },
    activate(id) {
      const key = Number(id);
      if (!key) return 0;
      latest = key;
      canceled.delete(key);
      return key;
    },
    isCurrent(id) {
      return Number(id) === latest && !canceled.has(Number(id));
    },
    cancel(id) {
      const key = Number(id);
      if (!key) return;
      canceled.add(key);
      if (key === latest) latest += 1;
    },
    finish(id) {
      canceled.delete(Number(id));
    },
  };
}

module.exports = { createExportRequestRegistry };
