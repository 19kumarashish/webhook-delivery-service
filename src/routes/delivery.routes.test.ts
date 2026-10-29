import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, it } from "node:test";
import { createDeliveryRouter } from "./delivery.routes";
import type {
  getDeliveryAttempts,
  getDeliveryById,
} from "../services/delivery.service";

type DeliveryFinder = typeof getDeliveryById;
type DeliveryAttemptsFinder = typeof getDeliveryAttempts;

async function getDelivery(
  router: ReturnType<typeof createDeliveryRouter>,
  deliveryId = "delivery_123",
): Promise<Response> {
  return getDeliveryRoute(router, `/${deliveryId}`);
}

async function getDeliveryRoute(
  router: ReturnType<typeof createDeliveryRouter>,
  path: string,
): Promise<Response> {
  const app = express();
  app.use(router);

  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;

    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("delivery routes", () => {
  it("returns delivery details when the delivery exists", async () => {
    const delivery = {
      id: "delivery_123",
      status: "SUCCEEDED" as const,
      attemptCount: 1,
      nextAttemptAt: null,
      createdAt: new Date("2026-10-29T10:00:00.000Z"),
      updatedAt: new Date("2026-10-29T10:00:01.000Z"),
      event: {
        id: "event_123",
        eventType: "order.paid",
        createdAt: new Date("2026-10-29T09:59:00.000Z"),
      },
      attempts: [
        {
          id: "attempt_123",
          httpStatusCode: 200,
          responseBody: '{"received":true}',
          errorMessage: null,
          attemptedAt: new Date("2026-10-29T10:00:01.000Z"),
        },
      ],
    };

    const finder: DeliveryFinder = async () => delivery;
    const response = await getDelivery(createDeliveryRouter(finder));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: {
        ...delivery,
        createdAt: delivery.createdAt.toISOString(),
        updatedAt: delivery.updatedAt.toISOString(),
        nextAttemptAt: null,
        event: {
          ...delivery.event,
          createdAt: delivery.event.createdAt.toISOString(),
        },
        attempts: [
          {
            ...delivery.attempts[0],
            attemptedAt: delivery.attempts[0].attemptedAt.toISOString(),
          },
        ],
      },
    });
  });

  it("returns 404 when the delivery does not exist", async () => {
    const finder: DeliveryFinder = async () => null;
    const response = await getDelivery(createDeliveryRouter(finder));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Delivery not found",
    });
  });

  it("logs unexpected failures without exposing internal details", async () => {
    const internalError = new Error("Database connection details");
    const logged: unknown[] = [];

    const finder: DeliveryFinder = async () => {
      throw internalError;
    };

    const response = await getDelivery(
      createDeliveryRouter(finder, (_message, error) => logged.push(error)),
    );

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Failed to retrieve delivery",
    });
    assert.deepEqual(logged, [internalError]);
  });

  it("uses the injected attempts finder with validated pagination", async () => {
    const deliveryFinder: DeliveryFinder = async () => null;
    const calls: Array<{ deliveryId: string; page: number; limit: number }> = [];
    const attemptsFinder: DeliveryAttemptsFinder = async (deliveryId, page, limit) => {
      calls.push({ deliveryId, page, limit });
      return {
        attempts: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      };
    };

    const response = await getDeliveryRoute(
      createDeliveryRouter(deliveryFinder, console.error, attemptsFinder),
      "/delivery_123/attempts?page=2&limit=25",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: [],
      pagination: { page: 2, limit: 25, total: 0, totalPages: 0 },
    });
    assert.deepEqual(calls, [{ deliveryId: "delivery_123", page: 2, limit: 25 }]);
  });

  it("rejects invalid pagination parameters", async () => {
    const deliveryFinder: DeliveryFinder = async () => null;
    const response = await getDeliveryRoute(
      createDeliveryRouter(deliveryFinder),
      "/delivery_123/attempts?page=0&limit=101",
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "page must be a positive integer and limit must be between 1 and 100",
    });
  });

  it("returns 404 for attempts when the delivery does not exist", async () => {
    const deliveryFinder: DeliveryFinder = async () => null;
    const attemptsFinder: DeliveryAttemptsFinder = async () => null;
    const response = await getDeliveryRoute(
      createDeliveryRouter(deliveryFinder, console.error, attemptsFinder),
      "/delivery_123/attempts",
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Delivery not found",
    });
  });
});
