import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { after, describe, it } from "node:test";
import { createEventRouter } from "./event.routes";
import prisma from "../config/prisma";
import { deliveryQueue } from "../config/queue";
import redis from "../config/redis";
import { DuplicateIdempotencyKeyError } from "../services/event.errors";

after(async () => {
  await deliveryQueue.close();
  await redis.quit();
  await prisma.$disconnect();
});

async function postEvent(
  router: ReturnType<typeof createEventRouter>,
): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use(router);

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${address.port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "order.paid",
        payload: { orderId: "order_1003" },
        idempotencyKey: "order-paid-1003",
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("event routes", () => {
  it("returns 409 for duplicate idempotency keys", async () => {
    const response = await postEvent(
      createEventRouter(async () => {
        throw new DuplicateIdempotencyKeyError();
      }),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "An event with this idempotency key already exists",
    });
  });

  it("logs unexpected failures and returns no internal error details", async () => {
    const internalError = new Error("Redis unavailable with internal details");
    const logged: unknown[] = [];
    const response = await postEvent(
      createEventRouter(
        async () => {
          throw internalError;
        },
        (_message, error) => logged.push(error),
      ),
    );

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Failed to accept event",
    });
    assert.deepEqual(logged, [internalError]);
  });
});
