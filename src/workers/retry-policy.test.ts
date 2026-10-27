
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasRetriesExhausted } from "./retry-policy";

describe("hasRetriesExhausted", () => {
  it("returns false when retries remain", () => {
    assert.equal(hasRetriesExhausted(0, 5), false);
    assert.equal(hasRetriesExhausted(1, 5), false);
    assert.equal(hasRetriesExhausted(3, 5), false);
  });

  it("returns true on the final attempt", () => {
    assert.equal(hasRetriesExhausted(4, 5), true);
  });

  it("handles a single allowed attempt", () => {
    assert.equal(hasRetriesExhausted(0, 1), true);
  });
});
