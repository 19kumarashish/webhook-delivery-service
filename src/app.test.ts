import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import app from "./app";
import redis from "./config/redis";
import prisma from "./config/prisma";

async function withAppServer(
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

describe("App Integration Tests", () => {
  after(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });
  it("GET /metrics responds with prometheus metrics and correct content-type without authentication", async () => {
    await withAppServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/metrics`);
      assert.equal(response.status, 200);

      const contentType = response.headers.get("content-type") || "";
      assert.match(contentType, /^text\/plain/);

      const body = await response.text();
      assert.match(body, /webhook_events_received_total/);
    });
  });

  it("rejects unauthenticated requests to /api/v1/* routes with 401", async () => {
    await withAppServer(async (baseUrl) => {
      const endpointsRes = await fetch(`${baseUrl}/api/v1/webhook-endpoints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/hook" }),
      });
      assert.equal(endpointsRes.status, 401);
      assert.deepEqual(await endpointsRes.json(), {
        status: "error",
        message: "Unauthorized: Invalid or missing API Key",
      });

      const eventsRes = await fetch(`${baseUrl}/api/v1/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "user.created",
          payload: {},
          idempotencyKey: "idem_1",
        }),
      });
      assert.equal(eventsRes.status, 401);

      const deliveriesRes = await fetch(`${baseUrl}/api/v1/deliveries/del_123`);
      assert.equal(deliveriesRes.status, 401);
    });
  });

  it("allows requests to /api/v1/* with valid X-API-Key header", async () => {
    await withAppServer(async (baseUrl) => {
      const validApiKey = process.env.API_KEY || "dev_secret_key_123";
      // An invalid event payload will pass auth and hit event schema validation (400)
      const res = await fetch(`${baseUrl}/api/v1/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": validApiKey,
        },
        body: JSON.stringify({}),
      });

      // Status should be 400 (Bad Request from Zod validation), proving it passed auth middleware
      assert.equal(res.status, 400);
      const json = (await res.json()) as { error: string };
      assert.equal(json.error, "Invalid request");
    });
  });
});
