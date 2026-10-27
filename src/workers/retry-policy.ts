
export function hasRetriesExhausted(
  attemptsMade: number,
  maxAttempts: number,
): boolean {
  return attemptsMade + 1 >= maxAttempts;
}
