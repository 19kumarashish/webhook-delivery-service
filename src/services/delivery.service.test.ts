import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeadLetterNotEligibleError,
  DeadLetterNotFoundError,
  DeadLetterReplayConflictError,
  listDeadLetteredDeliveries,
  replayDeadLetteredDelivery,
} from "./delivery.service";
describe("dead-letter delivery service", () => {
  const deadDelivery = {
    id: "delivery_1",
    eventId: "event_1",
    endpointId: "endpoint_1",
    status: "DEAD_LETTERED",
    attemptCount: 5,
    nextAttemptAt: null,
    event: { id: "event_1", eventType: "order.paid", payload: { amount: 100 } },
    endpoint: {
      id: "endpoint_1",
      url: "https://example.com/webhook",
      secret: "must-not-be-returned",
      isActive: true,
    },
  };

  it("lists dead-lettered deliveries with filters and pagination", async () => {
    let capturedFindArgs: any;
    let capturedCountArgs: any;
    const db: any = {
      delivery: {
        findMany: async (args: any) => {
          capturedFindArgs = args;
          return [{ id: "delivery_1" }];
        },
        count: async (args: any) => {
          capturedCountArgs = args;
          return 11;
        },
      },
      $transaction: async (items: unknown[]) =>
        await Promise.all(items as Promise<unknown>[]),
    };

    const result = await listDeadLetteredDeliveries(
      { page: 2, limit: 5, eventType: "order", endpointId: "endpoint_1" },
      { prismaClient: db },
    );

    assert.equal(result.pagination.total, 11);
    assert.equal(result.pagination.totalPages, 3);
    assert.equal(capturedFindArgs.where.status, "DEAD_LETTERED");
    assert.equal(capturedFindArgs.skip, 5);
    assert.equal(capturedFindArgs.take, 5);
    assert.equal(capturedCountArgs.where.endpointId, "endpoint_1");
  });

  it("replays a valid delivery through the existing queue and current endpoint", async () => {
    const queueAdds: any[] = [];
    const db: any = {
      delivery: {
        findUnique: async () => deadDelivery,
        updateMany: async () => ({ count: 1 }),
      },
      $transaction: async (callback: (tx: any) => Promise<unknown>) =>
        await callback(db),
    };
    const queue: any = {
      add: async (...args: any[]) => {
        queueAdds.push(args);
      },
    };

    const result = await replayDeadLetteredDelivery("delivery_1", {
      prismaClient: db,
      queueClient: queue,
      urlValidator: async () => true,
    });

    assert.equal(result.status, "PENDING");
    assert.equal(queueAdds[0][0], "deliver-webhook");
    assert.deepEqual(queueAdds[0][1], {
      eventId: "event_1",
      endpointId: "endpoint_1",
    });
    assert.match(queueAdds[0][2].jobId, /^delivery:delivery_1:replay:/);
  });

  it("rejects replay when the delivery is missing or not dead-lettered", async () => {
    const db: any = {
      delivery: {
        findUnique: async () => null,
      },
    };
    await assert.rejects(
      replayDeadLetteredDelivery("missing", { prismaClient: db, urlValidator: async () => true }),
      DeadLetterNotFoundError,
    );

    db.delivery.findUnique = async () => ({ ...deadDelivery, status: "SUCCEEDED" });
    await assert.rejects(
      replayDeadLetteredDelivery("delivery_1", { prismaClient: db, urlValidator: async () => true }),
      DeadLetterNotEligibleError,
    );
  });

  it("rejects replay for inactive endpoints and prohibited URLs", async () => {
    const db: any = {
      delivery: {
        findUnique: async () => ({
          ...deadDelivery,
          endpoint: { ...deadDelivery.endpoint, isActive: false },
        }),
      },
    };
    await assert.rejects(
      replayDeadLetteredDelivery("delivery_1", { prismaClient: db, urlValidator: async () => true }),
      DeadLetterNotEligibleError,
    );

    db.delivery.findUnique = async () => deadDelivery;
    await assert.rejects(
      replayDeadLetteredDelivery("delivery_1", { prismaClient: db, urlValidator: async () => false }),
      DeadLetterNotEligibleError,
    );
  });

  it("prevents concurrent replay with an atomic status claim", async () => {
    const db: any = {
      delivery: {
        findUnique: async () => deadDelivery,
        updateMany: async () => ({ count: 0 }),
      },
      $transaction: async (callback: (tx: any) => Promise<unknown>) =>
        await callback(db),
    };

    await assert.rejects(
      replayDeadLetteredDelivery("delivery_1", {
        prismaClient: db,
        queueClient: { add: async () => undefined } as any,
        urlValidator: async () => true,
      }),
      DeadLetterReplayConflictError,
    );
  });

  it("rolls replay state back when queue insertion fails", async () => {
    const updates: any[] = [];
    const db: any = {
      delivery: {
        findUnique: async () => deadDelivery,
        updateMany: async (args: any) => {
          updates.push(args);
          return { count: 1 };
        },
      },
      $transaction: async (callback: (tx: any) => Promise<unknown>) =>
        await callback(db),
    };
    const queue: any = {
      add: async () => {
        throw new Error("Redis queue unavailable");
      },
    };

    await assert.rejects(
      replayDeadLetteredDelivery("delivery_1", {
        prismaClient: db,
        queueClient: queue,
        urlValidator: async () => true,
      }),
      /Redis queue unavailable/,
    );

    assert.equal(updates.length, 2);
    assert.equal(updates[0].data.status, "PENDING");
    assert.equal(updates[1].where.status, "PENDING");
    assert.equal(updates[1].data.status, "DEAD_LETTERED");
  });

  it("does not create or reset attempt history during replay", async () => {
    const db: any = {
      delivery: {
        findUnique: async () => deadDelivery,
        updateMany: async () => ({ count: 1 }),
      },
      deliveryAttempt: {
        create: async () => {
          throw new Error("Replay must not create a separate attempt history row");
        },
      },
      $transaction: async (callback: (tx: any) => Promise<unknown>) =>
        await callback(db),
    };

    await replayDeadLetteredDelivery("delivery_1", {
      prismaClient: db,
      queueClient: { add: async () => undefined } as any,
      urlValidator: async () => true,
    });
  });
});
