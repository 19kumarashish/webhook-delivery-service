import rateLimit, { type Options } from "express-rate-limit";

export function createRateLimiter(options: Partial<Options> = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
  });
}

export const ingestionRateLimiter = createRateLimiter();
export default ingestionRateLimiter;

