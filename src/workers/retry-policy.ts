
export interface RetryPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
  maxAttempts: number;
}

export type RandomNumberFunction = () => number;

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterFactor: 0.2,
  maxAttempts: 5,
});

export function validateRetryPolicy(policy: RetryPolicy): RetryPolicy {
  for (const [name, value] of [
    ["initialDelayMs", policy.initialDelayMs],
    ["maxDelayMs", policy.maxDelayMs],
    ["maxAttempts", policy.maxAttempts],
  ] as const) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  if (policy.maxDelayMs < policy.initialDelayMs) {
    throw new Error("maxDelayMs must be greater than or equal to initialDelayMs");
  }

  if (
    !Number.isFinite(policy.jitterFactor) ||
    policy.jitterFactor < 0 ||
    policy.jitterFactor > 1
  ) {
    throw new Error("jitterFactor must be between 0 and 1");
  }

  return { ...policy };
}

export function retryPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RetryPolicy {
  return validateRetryPolicy({
    initialDelayMs: parseIntegerEnvironment(
      environment.WEBHOOK_RETRY_INITIAL_DELAY_MS,
      DEFAULT_RETRY_POLICY.initialDelayMs,
    ),
    maxDelayMs: parseIntegerEnvironment(
      environment.WEBHOOK_RETRY_MAX_DELAY_MS,
      DEFAULT_RETRY_POLICY.maxDelayMs,
    ),
    jitterFactor: parseNumberEnvironment(
      environment.WEBHOOK_RETRY_JITTER_FACTOR,
      DEFAULT_RETRY_POLICY.jitterFactor,
    ),
    maxAttempts: parseIntegerEnvironment(
      environment.WEBHOOK_RETRY_MAX_ATTEMPTS,
      DEFAULT_RETRY_POLICY.maxAttempts,
    ),
  });
}

function parseIntegerEnvironment(
  value: string | undefined,
  fallback: number,
): number {
  return value === undefined ? fallback : Number(value);
}

function parseNumberEnvironment(
  value: string | undefined,
  fallback: number,
): number {
  return value === undefined || value.trim() === "" ? fallback : Number(value);
}

export function calculateRetryDelay(
  attempt: number,
  policy: RetryPolicy,
  random: RandomNumberFunction = Math.random,
): number {
  validateRetryPolicy(policy);

  const normalizedAttempt =
    attempt === Number.POSITIVE_INFINITY
      ? 54
      : Number.isFinite(attempt)
        ? Math.max(1, Math.floor(attempt))
        : 1;

  let baseDelay = policy.initialDelayMs;
  if (normalizedAttempt > 1) {
    const exponent = normalizedAttempt - 1;
    if (
      exponent >= 53 ||
      baseDelay >= policy.maxDelayMs / 2 ** Math.min(exponent, 52)
    ) {
      baseDelay = policy.maxDelayMs;
    } else {
      baseDelay = Math.min(
        policy.maxDelayMs,
        Math.round(policy.initialDelayMs * 2 ** exponent),
      );
    }
  }

  if (policy.jitterFactor === 0) {
    return baseDelay;
  }

  const randomValue = random();
  if (!Number.isFinite(randomValue)) {
    throw new Error("random function must return a finite number");
  }
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  const multiplier =
    1 + (boundedRandom * 2 - 1) * policy.jitterFactor;
  const jitteredDelay = Math.round(baseDelay * multiplier);

  return Math.min(
    policy.maxDelayMs,
    Math.max(0, jitteredDelay),
  );
}

export function hasRetriesExhausted(
  attemptsMade: number,
  maxAttempts: number,
): boolean {
  if (!Number.isFinite(attemptsMade) || attemptsMade < 0) {
    return false;
  }
  return attemptsMade >= maxAttempts;
}

export function createBullMqRetryOptions(
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
) {
  validateRetryPolicy(policy);
  return {
    attempts: policy.maxAttempts,
    backoff: {
      type: "exponential-jitter",
      delay: policy.initialDelayMs,
    },
  };
}
