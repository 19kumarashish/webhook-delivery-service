import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEvent } from "./event.service";
import { runWithLogContext } from "../logging/context";

describe("event service queue correlation", () => {
  function createMockDb(endpoints = [{ id: "endpoint_1" }]) {
    const createdEvent = {
      id: "event_1",
      eventType: "order.paid",
      payload: { orderId: "1001" },
      idempotencyKey: "idem_1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const db: any = {
      webhookEndpoint: {
        findMany: async () => endpoints,
      },
      event: {
        create: async () => createdEvent,
      },
      delivery: {
        createMany: async () => ({ count: endpoints.length }),
      },
      $transaction: async (callback: (tx: any) => Promise<unknown>) =>
        await callback(db),
    };
    return db;
  }

  it("adds request and correlation IDs to new queue jobs and logs identifiers", async () => {
    const db = createMockDb();
    const bulkCalls: any[] = [];
    const logs: Array<{ fields: any; message: string }> = [];
    const queue: any = {
      addBulk: async (jobs: any[]) => bulkCalls.push(jobs),
    };
    const testLogger: any = {
      info(fields: any, message: string) {
        logs.push({ fields, message });
      },
    };

    await runWithLogContext(
      { requestId: "request_123", correlationId: "correlation_456" },
      () => createEvent(
        {
          eventType: "order.paid",
          payload: { orderId: "1001" },
          idempotencyKey: "idem_1",
        },
        { prismaClient: db, queueClient: queue, logger: testLogger },
      ),
    );

    assert.equal(bulkCalls[0][0].data.eventId, "event_1");
    assert.equal(bulkCalls[0][0].data.endpointId, "endpoint_1");
    assert.equal(bulkCalls[0][0].data.requestId, "request_123");
    assert.equal(bulkCalls[0][0].data.correlationId, "correlation_456");

    for (const log of logs) {
      assert.equal(log.fields.requestId, "request_123");
      assert.equal(log.fields.correlationId, "correlation_456");
      assert.equal(log.fields.eventId, "event_1");
      if (log.message === "event_delivery_queued") {
        assert.equal(log.fields.endpointId, "endpoint_1");
      }
      assert.equal(JSON.stringify(log.fields).includes("1001"), false);
      assert.equal(JSON.stringify(log.fields).includes("secret"), false);
    }
  });

  it("falls back to request ID for correlation and works without context", async () => {
    const db = createMockDb();
    const bulkCalls: any[] = [];
    const queue: any = {
      addBulk: async (jobs: any[]) => bulkCalls.push(jobs),
    };

    await runWithLogContext(
      { requestId: "request_fallback" },
      () => createEvent(
        {
          eventType: "order.paid",
          payload: {},
          idempotencyKey: "idem_fallback",
        },
        { prismaClient: db, queueClient: queue, logger: { info() {} } },
      ),
    );
    assert.equal(bulkCalls[0][0].data.correlationId, "request_fallback");
    assert.equal(bulkCalls[0][0].data.requestId, "request_fallback");

    const noContextDb = createMockDb();
    const noContextCalls: any[] = [];
    await createEvent(
      {
        eventType: "order.paid",
        payload: {},
        idempotencyKey: "idem_no_context",
      },
      {
        prismaClient: noContextDb,
        queueClient: { addBulk: async (jobs: any[]) => noContextCalls.push(jobs) } as any,
        logger: { info() {} },
      },
    );
    assert.deepEqual(noContextCalls[0][0].data, {
      eventId: "event_1",
      endpointId: "endpoint_1",
    });
  });

  it("preserves existing fields and keeps jobs without metadata compatible", async () => {
    const db = createMockDb();
    const bulkCalls: any[] = [];
    await createEvent(
      {
        eventType: "order.paid",
        payload: {},
        idempotencyKey: "idem_compat",
      },
      {
        prismaClient: db,
        queueClient: { addBulk: async (jobs: any[]) => bulkCalls.push(jobs) } as any,
        logger: { info() {} },
      },
    );

    assert.deepEqual(bulkCalls[0][0].data, {
      eventId: "event_1",
      endpointId: "endpoint_1",
    });
  });
});
