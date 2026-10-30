
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateRetryDelay,
  createBullMqRetryOptions,
  DEFAULT_RETRY_POLICY,
  hasRetriesExhausted,
  retryPolicyFromEnvironment,
  validateRetryPolicy,
} from "./retry-policy";

describe("calculateRetryDelay", () => {
  it("returns the initial delay without jitter at attempt one", () => {
    assert.equal(
      calculateRetryDelay(1, DEFAULT_RETRY_POLICY, () => 0.5),
      1000,
    );
  });

  it("grows exponentially", () => {
    assert.equal(calculateRetryDelay(2, DEFAULT_RETRY_POLICY, () => 0.5), 2000);
    assert.equal(calculateRetryDelay(3, DEFAULT_RETRY_POLICY, () => 0.5), 4000);
  });

  it("caps exponential delay at the maximum", () => {
    assert.equal(calculateRetryDelay(20, DEFAULT_RETRY_POLICY, () => 0.5), 60000);
    assert.equal(
      calculateRetryDelay(Number.MAX_SAFE_INTEGER, DEFAULT_RETRY_POLICY, () => 0.5),
      60000,
    );
  });

  it("applies jitter within the configured boundaries", () => {
    assert.equal(calculateRetryDelay(1, DEFAULT_RETRY_POLICY, () => 0), 800);
    assert.equal(calculateRetryDelay(1, DEFAULT_RETRY_POLICY, () => 1), 1200);
  });

  it("supports deterministic jitter values", () => {
    assert.equal(calculateRetryDelay(4, DEFAULT_RETRY_POLICY, () => 0.25), 7200);
    assert.equal(calculateRetryDelay(4, DEFAULT_RETRY_POLICY, () => 0.75), 8800);
  });

  it("normalizes zero and negative attempt numbers to the first attempt", () => {
    assert.equal(calculateRetryDelay(0, DEFAULT_RETRY_POLICY, () => 0.5), 1000);
    assert.equal(calculateRetryDelay(-100, DEFAULT_RETRY_POLICY, () => 0.5), 1000);
  });
});

describe("retry policy validation", () => {
  it("creates BullMQ job options using the configured attempt limit and custom backoff", () => {
    assert.deepEqual(createBullMqRetryOptions(DEFAULT_RETRY_POLICY), {
      attempts: 5,
      backoff: {
        type: "exponential-jitter",
        delay: 1000,
      },
    });
  });

  it("loads valid environment configuration", () => {
    const policy = retryPolicyFromEnvironment({
      WEBHOOK_RETRY_INITIAL_DELAY_MS: "250",
      WEBHOOK_RETRY_MAX_DELAY_MS: "5000",
      WEBHOOK_RETRY_JITTER_FACTOR: "0.3",
      WEBHOOK_RETRY_MAX_ATTEMPTS: "7",
    });
    assert.deepEqual(policy, {
      initialDelayMs: 250,
      maxDelayMs: 5000,
      jitterFactor: 0.3,
      maxAttempts: 7,
    });
  });

  it("rejects invalid configuration values", () => {
    assert.throws(() =>
      validateRetryPolicy({
        ...DEFAULT_RETRY_POLICY,
        initialDelayMs: 0,
      }),
    );
    assert.throws(() =>
      validateRetryPolicy({
        ...DEFAULT_RETRY_POLICY,
        maxDelayMs: 500,
      }),
    );
    assert.throws(() =>
      validateRetryPolicy({
        ...DEFAULT_RETRY_POLICY,
        jitterFactor: 1.5,
      }),
    );
    assert.throws(() =>
      validateRetryPolicy({
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 2.5,
      }),
    );
  });

  it("rejects malformed environment configuration", () => {
    assert.throws(() =>
      retryPolicyFromEnvironment({
        WEBHOOK_RETRY_INITIAL_DELAY_MS: "not-a-number",
      }),
    );
  });
});

describe("hasRetriesExhausted", () => {
  it("returns false when retries remain", () => {
    assert.equal(hasRetriesExhausted(0, 5), false);
    assert.equal(hasRetriesExhausted(1, 5), false);
    assert.equal(hasRetriesExhausted(3, 5), false);
  });

  it("returns true on the final attempt", () => {
    assert.equal(hasRetriesExhausted(5, 5), true);
  });

  it("handles a single allowed attempt", () => {
    assert.equal(hasRetriesExhausted(1, 1), true);
  });
});
