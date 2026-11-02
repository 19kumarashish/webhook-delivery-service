import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, it } from "node:test";
import { createHealthRouter } from "./health.routes";

async function requestHealth(
  path: string,
  healthService: Parameters<typeof createHealthRouter>[0],
): Promise<Response> {
  const app = express();
  app.use("/health", createHealthRouter(healthService));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${address.port}/health${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const okReadiness = {
  status: "ok" as const,
  timestamp: "2026-11-02T00:00:00.000Z",
  dependencies: { database: "up" as const, redis: "up" as const },
};

describe("health routes", () => {
  it("returns liveness without calling dependencies", async () => {
    let calls = 0;
    const response = await requestHealth("/live", {
      async getReadiness() {
        calls += 1;
        return okReadiness;
      },
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 0);
    assert.equal((await response.json()).status, "ok");
  });

  it("returns readiness 200 when dependencies are healthy", async () => {
    const response = await requestHealth("/ready", {
      async getReadiness() { return okReadiness; },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), okReadiness);
  });

  it("returns readiness 503 when PostgreSQL fails", async () => {
    const response = await requestHealth("/ready", {
      async getReadiness() {
        return {
          status: "error",
          timestamp: okReadiness.timestamp,
          dependencies: { database: "down" as const, redis: "up" as const },
        };
      },
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.dependencies.database, "down");
    assert.equal(JSON.stringify(body).includes("postgres://"), false);
  });

  it("returns readiness 503 when Redis fails", async () => {
    const response = await requestHealth("/ready", {
      async getReadiness() {
        return {
          status: "error",
          timestamp: okReadiness.timestamp,
          dependencies: { database: "up" as const, redis: "down" as const },
        };
      },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).dependencies.redis, "down");
  });

  it("keeps /health compatibility behavior as readiness", async () => {
    const response = await requestHealth("/", {
      async getReadiness() { return okReadiness; },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  });

  it("does not expose thrown internal errors or credentials", async () => {
    const response = await requestHealth("/ready", {
      async getReadiness() {
        throw new Error("redis://default:secret@private:6379 signature=abc");
      },
    });
    assert.equal(response.status, 503);
    const serialized = JSON.stringify(await response.json());
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("redis://"), false);
  });
});
