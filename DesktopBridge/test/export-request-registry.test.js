"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createExportRequestRegistry } = require("../src/exportRequestRegistry");

test("cancellation invalidates the active request and a new request invalidates the old result", () => {
  const registry = createExportRequestRegistry();
  const first = registry.activate(1);
  assert.equal(registry.isCurrent(first), true);
  registry.cancel(first);
  assert.equal(registry.isCurrent(first), false, "canceled request cannot save");
  const second = registry.activate(2);
  assert.equal(registry.isCurrent(first), false, "old request cannot save after a new dialog");
  assert.equal(registry.isCurrent(second), true);
  registry.cancel(2);
  assert.equal(registry.isCurrent(second), false);
});
