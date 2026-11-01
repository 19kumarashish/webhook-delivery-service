import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, it } from "node:test";
import { createDeliveryRouter } from "./delivery.routes";
import type {
  getDeliveryAttempts,
  getDeliveryById,
  listDeadLetteredDeliveries,
  replayDeadLetteredDelivery,
} from "../services/delivery.service";

type DeliveryFinder = typeof getDeliveryById;
type DeliveryAttemptsFinder = typeof getDeliveryAttempts;
type DeadLetterLister = typeof listDeadLetteredDeliveries;
type DeadLetterReplayer = typeof replayDeadLetteredDelivery;

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
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestDeliveryRoute(
  router: ReturnType<typeof createDeliveryRouter>,
  path: string,
  method = "GET",
): Promise<Response> {
  const app = express();
  app.use(router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
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
        payload: { amount: 5000 },
      },
      endpoint: {
        id: "endpoint_123",
        url: "https://example.com/webhooks",
        isActive: true,
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

  it("lists dead-lettered deliveries with validated pagination and filters", async () => {
    const lister: DeadLetterLister = async (input) => {
      assert.deepEqual(input, {
        page: 2,
        limit: 25,
        eventType: "order.paid",
        endpointId: "endpoint_123",
      });
      return {
        deliveries: [{
          id: "delivery_dlq",
          status: "DEAD_LETTERED",
          attemptCount: 5,
          createdAt: new Date("2026-10-29T10:00:00.000Z"),
          updatedAt: new Date("2026-10-29T10:00:01.000Z"),
          event: {
            id: "event_123",
            eventType: "order.paid",
            createdAt: new Date("2026-10-29T09:59:00.000Z"),
          },
          endpoint: {
            id: "endpoint_123",
            url: "https://example.com/webhooks",
            isActive: true,
          },
          attempts: [],
        }],
        pagination: { page: 2, limit: 25, total: 26, totalPages: 2 },
      };
    };

    const response = await requestDeliveryRoute(
      createDeliveryRouter(async () => null, console.error, undefined, lister),
      "/dlq?page=2&limit=25&eventType=order.paid&endpointId=endpoint_123",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: [{
        id: "delivery_dlq",
        status: "DEAD_LETTERED",
        attemptCount: 5,
        createdAt: "2026-10-29T10:00:00.000Z",
        updatedAt: "2026-10-29T10:00:01.000Z",
        event: {
          id: "event_123",
          eventType: "order.paid",
          createdAt: "2026-10-29T09:59:00.000Z",
        },
        endpoint: {
          id: "endpoint_123",
          url: "https://example.com/webhooks",
          isActive: true,
        },
        attempts: [],
      }],
      pagination: { page: 2, limit: 25, total: 26, totalPages: 2 },
    });
  });

  it("retrieves a dead-lettered delivery without changing its status", async () => {
    const finder: DeliveryFinder = async () => ({
      id: "delivery_dlq",
      status: "DEAD_LETTERED",
      attemptCount: 5,
      nextAttemptAt: null,
      createdAt: new Date("2026-10-29T10:00:00.000Z"),
      updatedAt: new Date("2026-10-29T10:00:01.000Z"),
      event: {
        id: "event_123",
        eventType: "order.paid",
        payload: { amount: 5000 },
        createdAt: new Date("2026-10-29T09:59:00.000Z"),
      },
      endpoint: {
        id: "endpoint_123",
        url: "https://example.com/webhooks",
        isActive: true,
      },
      attempts: [],
    });

    const response = await requestDeliveryRoute(
      createDeliveryRouter(finder),
      "/dlq/delivery_dlq",
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.status, "DEAD_LETTERED");
    assert.equal(body.data.endpoint.url, "https://example.com/webhooks");
  });

  it("accepts a valid replay request and rejects replay conflicts", async () => {
    const replayer: DeadLetterReplayer = async () => ({
      id: "delivery_dlq",
      status: "PENDING",
      eventId: "event_123",
      endpointId: "endpoint_123",
    });

    const response = await requestDeliveryRoute(
      createDeliveryRouter(async () => null, console.error, undefined, undefined, replayer),
      "/dlq/delivery_dlq/replay",
      "POST",
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      message: "Dead-lettered delivery replay accepted",
      data: {
        id: "delivery_dlq",
        status: "PENDING",
        eventId: "event_123",
        endpointId: "endpoint_123",
      },
    });
  });
});
