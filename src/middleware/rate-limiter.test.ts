import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, it } from "node:test";
import {
  createRateLimiter,
  ingestionRateLimiter,
} from "./rate-limiter";

async function withTestServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("rate limiter middleware", () => {
  it("sets standard RateLimit headers and does not set legacy X-RateLimit headers", async () => {
    const app = express();
    app.use(
      createRateLimiter({
        windowMs: 60 * 1000,
        limit: 5,
      }),
    );
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await withTestServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/test`);
      assert.equal(response.status, 200);

      // Legacy headers should be absent
      assert.equal(response.headers.get("x-ratelimit-limit"), null);
      assert.equal(response.headers.get("x-ratelimit-remaining"), null);

      // Standard headers should be present (either combined RateLimit or RateLimit-Policy / RateLimit-Limit)
      const hasStandardHeader =
        response.headers.has("ratelimit") ||
        response.headers.has("ratelimit-limit") ||
        response.headers.has("ratelimit-policy");
      assert.equal(hasStandardHeader, true);
    });
  });

  it("blocks requests with 429 when the limit is exceeded", async () => {
    const app = express();
    app.use(
      createRateLimiter({
        windowMs: 60 * 1000,
        limit: 2,
      }),
    );
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await withTestServer(app, async (baseUrl) => {
      const res1 = await fetch(`${baseUrl}/test`);
      assert.equal(res1.status, 200);

      const res2 = await fetch(`${baseUrl}/test`);
      assert.equal(res2.status, 200);

      const res3 = await fetch(`${baseUrl}/test`);
      assert.equal(res3.status, 429);
    });
  });

  it("exports an ingestionRateLimiter instance", () => {
    assert.equal(typeof ingestionRateLimiter, "function");
  });
});

