import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, describe, it } from "node:test";
import type { Job } from "bullmq";
import {
  processDeliveryJob,
  registerDeliveryWorkerListeners,
  type DeliveryJobData,
} from "./delivery.worker";
import {
  HttpDeliveryError,
  SsrfSecurityError,
} from "../services/webhook-http-client";
import prisma from "../config/prisma";
import redis from "../config/redis";
import { getLogContext } from "../logging/context";

after(async () => {
  await redis.quit();
  await prisma.$disconnect();
});

describe("delivery worker job processing", () => {
  const mockEvent = {
    id: "evt_123",
    eventType: "payment.received",
    payload: { amount: 5000, currency: "USD" },
    createdAt: new Date("2026-10-29T12:00:00.000Z"),
  };

  const mockEndpoint = {
    id: "ep_123",
    url: "https://example.com/webhook",
    secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    isActive: true,
  };

  const mockDelivery = {
    id: "del_123",
    eventId: "evt_123",
    endpointId: "ep_123",
    status: "PENDING",
    attemptCount: 0,
    event: mockEvent,
    endpoint: mockEndpoint,
  };

  function createMockPrisma(deliveryRecord = mockDelivery) {
    const transactions: any[] = [];
    const updates: any[] = [];
    const attempts: any[] = [];

    const mockPrisma: any = {
      delivery: {
        findUnique: async () => deliveryRecord,
        update: async (args: any) => {
          updates.push(args);
          return { ...deliveryRecord, ...args.data };
        },
      },
      deliveryAttempt: {
        create: async (args: any) => {
          attempts.push(args);
          return { id: "att_1", ...args.data };
        },
      },
      $transaction: async (items: any[]) => {
        const resolved = await Promise.all(items);
        transactions.push(resolved);
        return resolved;
      },
    };

    return { mockPrisma, transactions, updates, attempts };
  }

  it("delivers webhook successfully with exact HMAC signature and headers", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const { mockPrisma, transactions, updates } = createMockPrisma();

    const mockDeliverer = async (url: string, opts: any) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      capturedBody = opts.body;
      return { statusCode: 200, body: '{"received":true}' };
    };

    const mockJob: Partial<Job<DeliveryJobData>> = {
      data: { eventId: "evt_123", endpointId: "ep_123" },
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    await processDeliveryJob(mockJob as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      webhookDeliverer: mockDeliverer,
    });

    // Verify URL, payload, and HMAC signature
    assert.equal(capturedUrl, "https://example.com/webhook");
    const expectedPayload = JSON.stringify({
      id: mockEvent.id,
      type: mockEvent.eventType,
      createdAt: mockEvent.createdAt.toISOString(),
      data: mockEvent.payload,
    });
    assert.equal(capturedBody, expectedPayload);

    const expectedSignature = createHmac("sha256", mockEndpoint.secret)
      .update(expectedPayload)
      .digest("hex");

    assert.equal(
      capturedHeaders["X-Webhook-Signature"],
      `sha256=${expectedSignature}`,
    );
    assert.equal(capturedHeaders["X-Webhook-Event"], "payment.received");
    assert.equal(capturedHeaders["X-Webhook-Delivery"], "del_123");
    assert.equal(capturedHeaders["Content-Type"], "application/json");

    // Verify delivery transitioned from PROCESSING to SUCCEEDED
    assert.equal(updates[0].data.status, "PROCESSING");
    const lastUpdate = updates[updates.length - 1];
    assert.equal(lastUpdate.data.status, "SUCCEEDED");
    assert.equal(transactions.length, 1);
  });

  it("moves a permanent SSRF rejection into the dead-letter queue", async () => {
    const { mockPrisma, transactions, updates } = createMockPrisma();

    const mockDeliverer = async () => {
      throw new SsrfSecurityError("Blocked prohibited address 127.0.0.1");
    };

    const mockJob: Partial<Job<DeliveryJobData>> = {
      data: { eventId: "evt_123", endpointId: "ep_123" },
      opts: { attempts: 3 },
      attemptsMade: 1, // 1 of 3 -> retries remain
    };

    await processDeliveryJob(mockJob as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      webhookDeliverer: mockDeliverer,
    });

    // Permanent security failures must not be retried.
    assert.equal(updates[0].data.status, "PROCESSING");
    const lastUpdate = updates[updates.length - 1];
    assert.equal(lastUpdate.data.status, "DEAD_LETTERED");
    assert.equal(transactions.length, 1);
  });

  it("moves retry exhaustion on a 3xx redirect into the dead-letter queue", async () => {
    const { mockPrisma, transactions, updates } = createMockPrisma();

    const mockDeliverer = async () => {
      throw new HttpDeliveryError(302, "Redirecting");
    };

    const mockJob: Partial<Job<DeliveryJobData>> = {
      data: { eventId: "evt_123", endpointId: "ep_123" },
      opts: { attempts: 3 },
      attemptsMade: 3, // Final attempt -> exhausted
    };

    await processDeliveryJob(mockJob as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      webhookDeliverer: mockDeliverer,
    });

    const lastUpdate = updates[updates.length - 1];
    assert.equal(lastUpdate.data.status, "DEAD_LETTERED");
    assert.equal(transactions.length, 1);
  });

  it("handles inactive endpoints without invoking deliverer", async () => {
    let delivererCalled = false;
    const inactiveDelivery = {
      ...mockDelivery,
      endpoint: { ...mockEndpoint, isActive: false },
    };

    const { mockPrisma, transactions, updates } = createMockPrisma(inactiveDelivery);

    const mockDeliverer = async () => {
      delivererCalled = true;
      return { statusCode: 200, body: "ok" };
    };

    const mockJob: Partial<Job<DeliveryJobData>> = {
      data: { eventId: "evt_123", endpointId: "ep_123" },
    };

    await processDeliveryJob(mockJob as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      webhookDeliverer: mockDeliverer,
    });

    assert.equal(delivererCalled, false);
    assert.equal(updates[0].data.status, "DEAD_LETTERED");
    assert.equal(transactions.length, 1);
  });

  it("moves a final 5xx retry into the dead-letter queue", async () => {
    const exhaustedDelivery = { ...mockDelivery, attemptCount: 4 };
    const { mockPrisma, attempts, updates } = createMockPrisma(exhaustedDelivery);

    const mockJob: Partial<Job<DeliveryJobData>> = {
      data: { eventId: "evt_123", endpointId: "ep_123" },
      opts: { attempts: 5 },
      attemptsMade: 5,
    };

    await processDeliveryJob(mockJob as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      webhookDeliverer: async () => {
        throw new HttpDeliveryError(500, "Internal Server Error");
      },
    });

    assert.equal(updates[updates.length - 1].data.status, "DEAD_LETTERED");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].data.httpStatusCode, 500);
  });

  it("does not process or duplicate an already dead-lettered delivery", async () => {
    const deadDelivery = { ...mockDelivery, status: "DEAD_LETTERED" };
    const { mockPrisma, transactions, attempts } = createMockPrisma(deadDelivery);
    let delivererCalled = false;

    await processDeliveryJob({
      data: { eventId: "evt_123", endpointId: "ep_123" },
      opts: { attempts: 5 },
      attemptsMade: 5,
    } as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      webhookDeliverer: async () => {
        delivererCalled = true;
        return { statusCode: 200, body: "ok" };
      },
    });

    assert.equal(delivererCalled, false);
    assert.equal(attempts.length, 0);
    assert.equal(transactions.length, 0);
  });

  it("restores job correlation context and logs successful delivery identifiers", async () => {
    const { mockPrisma } = createMockPrisma();
    const logs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    let delivererContext: ReturnType<typeof getLogContext>;
    const testLogger = {
      info(fields: Record<string, unknown>, message: string) {
        logs.push({ fields, message });
      },
      warn(fields: Record<string, unknown>, message: string) {
        logs.push({ fields, message });
      },
    };

    await processDeliveryJob({
      data: {
        eventId: "evt_123",
        endpointId: "ep_123",
        deliveryId: "del_123",
        requestId: "request_123",
        correlationId: "correlation_123",
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      logger: testLogger,
      now: (() => {
        let value = 0n;
        return () => {
          value += 1_000_000n;
          return value;
        };
      })(),
      webhookDeliverer: async () => {
        delivererContext = getLogContext();
        return { statusCode: 200, body: '{"received":true}' };
      },
    });

    assert.deepEqual(delivererContext!, {
      requestId: "request_123",
      correlationId: "correlation_123",
      eventId: "evt_123",
      endpointId: "ep_123",
      deliveryId: "del_123",
    });

    const success = logs.find((log) => log.message === "delivery_succeeded");
    assert.ok(success);
    assert.equal(success.fields.requestId, "request_123");
    assert.equal(success.fields.correlationId, "correlation_123");
    assert.equal(success.fields.eventId, "evt_123");
    assert.equal(success.fields.deliveryId, "del_123");
    assert.equal(success.fields.endpointId, "ep_123");
    assert.equal(success.fields.httpStatusCode, 200);
  });

  it("falls back to requestId for legacy jobs without correlation metadata", async () => {
    const { mockPrisma } = createMockPrisma();
    let delivererContext: ReturnType<typeof getLogContext>;

    await processDeliveryJob({
      data: {
        eventId: "evt_123",
        endpointId: "ep_123",
        requestId: "legacy_request",
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      webhookDeliverer: async () => {
        delivererContext = getLogContext();
        return { statusCode: 200, body: "ok" };
      },
    });

    assert.equal(delivererContext!.requestId, "legacy_request");
    assert.equal(delivererContext!.correlationId, "legacy_request");
    assert.equal(delivererContext!.eventId, "evt_123");
    assert.equal(delivererContext!.endpointId, "ep_123");
    assert.equal(delivererContext!.deliveryId, "del_123");
  });

  it("isolates concurrent job contexts and logs safe terminal failure details", async () => {
    const logs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const testLogger = {
      info(fields: Record<string, unknown>, message: string) {
        logs.push({ fields, message });
      },
      warn(fields: Record<string, unknown>, message: string) {
        logs.push({ fields, message });
      },
    };

    const contexts = new Map<string, ReturnType<typeof getLogContext>>();
    const runJob = async (requestId: string, delayMs: number) => {
      const delivery = {
        ...mockDelivery,
        id: `del_${requestId}`,
      };
      const { mockPrisma } = createMockPrisma(delivery);

      await processDeliveryJob({
        data: {
          eventId: `evt_${requestId}`,
          endpointId: `ep_${requestId}`,
          requestId,
        },
        opts: { attempts: 5 },
        attemptsMade: 5,
      } as Job<DeliveryJobData>, {
        prismaClient: mockPrisma,
        logger: testLogger,
        webhookDeliverer: async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          contexts.set(requestId, getLogContext());
          throw new HttpDeliveryError(500, "sensitive response body");
        },
      });
    };

    await Promise.all([
      runJob("first", 10),
      runJob("second", 1),
    ]);

    assert.equal(contexts.get("first")!.requestId, "first");
    assert.equal(contexts.get("first")!.correlationId, "first");
    assert.equal(contexts.get("second")!.requestId, "second");
    assert.equal(contexts.get("second")!.correlationId, "second");

    assert.ok(logs.some((log) => log.message === "delivery_failed"));
    assert.ok(logs.some((log) => log.message === "delivery_dead_lettered"));
    for (const log of logs) {
      const serialized = JSON.stringify(log);
      assert.equal(serialized.includes("sensitive response body"), false);
      assert.equal(serialized.includes("example.com"), false);
      assert.equal(serialized.includes(mockEndpoint.secret), false);
      assert.equal(serialized.includes(mockEvent.payload.amount.toString()), false);
      assert.equal(serialized.includes("X-Webhook-Signature"), false);
    }
  });

  it("logs worker infrastructure and unexpected job failures with safe metadata", () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const worker = {
      on(event: string, listener: (...args: any[]) => void) {
        listeners.set(event, listener);
        return this;
      },
    };
    const logs: Array<{ fields: Record<string, unknown>; message: string; level: string }> = [];
    const workerLogger = {
      error(fields: Record<string, unknown>, message: string) {
        logs.push({ level: "error", fields, message });
      },
      warn(fields: Record<string, unknown>, message: string) {
        logs.push({ level: "warn", fields, message });
      },
    };

    registerDeliveryWorkerListeners(worker as any, workerLogger);

    listeners.get("error")!(new Error(
      "redis://user:password@host/path payload secret signature https://secret.example/webhook",
    ));
    listeners.get("failed")!({
      id: "delivery-job-1",
      attemptsMade: 2,
      data: {
        requestId: "request-1",
        correlationId: "correlation-1",
        eventId: "evt-1",
        endpointId: "ep-1",
        deliveryId: "del-1",
      },
    }, new Error("database response body and authorization header were exposed"));

    assert.equal(logs.length, 2);
    assert.equal(logs[0].message, "worker_error");
    assert.equal(logs[1].message, "worker_job_failed");
    assert.deepEqual(logs[0].fields.error, {
      type: "Error",
      name: "Error",
    });
    assert.equal(logs[1].fields.requestId, "request-1");
    assert.equal(logs[1].fields.correlationId, "correlation-1");
    assert.equal(logs[1].fields.eventId, "evt-1");
    assert.equal(logs[1].fields.endpointId, "ep-1");
    assert.equal(logs[1].fields.deliveryId, "del-1");

    const serialized = JSON.stringify(logs);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("payload"), false);
    assert.equal(serialized.includes("secret.example"), false);
    assert.equal(serialized.includes("authorization"), false);
    assert.equal(serialized.includes("response body"), false);
  });

  it("does not duplicate retryable HTTP failure logging in the BullMQ failed listener", async () => {
    const { mockPrisma } = createMockPrisma();
    const processorLogs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const workerLogs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const listeners = new Map<string, (...args: any[]) => void>();
    const worker = {
      on(event: string, listener: (...args: any[]) => void) {
        listeners.set(event, listener);
        return this;
      },
    };
    const processorLogger = {
      info() {},
      warn(fields: Record<string, unknown>, message: string) {
        processorLogs.push({ fields, message });
      },
    };
    const workerLogger = {
      error() {},
      warn(fields: Record<string, unknown>, message: string) {
        workerLogs.push({ fields, message });
      },
    };

    registerDeliveryWorkerListeners(worker as any, workerLogger);

    const originalError = Object.freeze(
      new HttpDeliveryError(503, "sensitive response body"),
    );
    let recordedError: unknown;
    try {
      await processDeliveryJob({
        data: {
          eventId: "evt_123",
          endpointId: "ep_123",
          deliveryId: "del_123",
          requestId: "request-retry",
          correlationId: "correlation-retry",
        },
        opts: { attempts: 3 },
        attemptsMade: 0,
      } as Job<DeliveryJobData>, {
        prismaClient: mockPrisma,
        logger: processorLogger,
        webhookDeliverer: async () => {
          throw originalError;
        },
      });
    } catch (error) {
      recordedError = error;
    }

    listeners.get("failed")!({
      id: "retry-job",
      attemptsMade: 0,
      data: {
        eventId: "evt_123",
        endpointId: "ep_123",
        requestId: "request-retry",
      },
    }, recordedError);

    assert.ok(recordedError instanceof HttpDeliveryError);
    assert.equal(recordedError, originalError);
    assert.ok(processorLogs.some((log) => log.message === "delivery_failed"));
    assert.equal(workerLogs.length, 0);
  });

  it("logs unexpected database and delivery-not-found failures through worker failed listener", async () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const worker = {
      on(event: string, listener: (...args: any[]) => void) {
        listeners.set(event, listener);
        return this;
      },
    };
    const workerLogs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    registerDeliveryWorkerListeners(worker as any, {
      error() {},
      warn(fields: Record<string, unknown>, message: string) {
        workerLogs.push({ fields, message });
      },
    });

    const databaseError = new Error("database connection details");
    const databaseDb: any = {
      delivery: {
        findUnique: async () => {
          throw databaseError;
        },
      },
    };
    let caughtDatabaseError: unknown;
    try {
      await processDeliveryJob({
        data: { eventId: "evt_db", endpointId: "ep_db" },
        opts: { attempts: 3 },
        attemptsMade: 0,
      } as Job<DeliveryJobData>, {
        prismaClient: databaseDb,
      });
    } catch (error) {
      caughtDatabaseError = error;
    }
    assert.equal(caughtDatabaseError, databaseError);
    listeners.get("failed")!({
      id: "database-job",
      attemptsMade: 0,
      data: { eventId: "evt_db", endpointId: "ep_db" },
    }, databaseError);

    const missingDb: any = {
      delivery: {
        findUnique: async () => null,
      },
    };
    const missingProcessorLogs: Array<{ message: string }> = [];
    let caughtMissingError: unknown;
    try {
      await processDeliveryJob({
        data: { eventId: "evt_missing", endpointId: "ep_missing" },
        opts: { attempts: 3 },
        attemptsMade: 1,
      } as Job<DeliveryJobData>, {
        prismaClient: missingDb,
        logger: {
          info() {},
          warn(_fields: Record<string, unknown>, message: string) {
            missingProcessorLogs.push({ message });
          },
        },
      });
    } catch (error) {
      caughtMissingError = error;
    }
    assert.ok(caughtMissingError instanceof Error);
    listeners.get("failed")!({
      id: "missing-job",
      attemptsMade: 1,
      data: { eventId: "evt_missing", endpointId: "ep_missing" },
    }, caughtMissingError);

    assert.equal(workerLogs.length, 2);
    assert.equal(workerLogs[0].message, "worker_job_failed");
    assert.equal(workerLogs[1].message, "worker_job_failed");
    assert.equal(workerLogs[0].fields.eventId, "evt_db");
    assert.equal(workerLogs[1].fields.eventId, "evt_missing");
    assert.equal(
      missingProcessorLogs.some((log) =>
        log.message === "delivery_failed" ||
        log.message === "delivery_dead_lettered"
      ),
      false,
    );
    assert.equal(
      JSON.stringify(workerLogs).includes("database connection details"),
      false,
    );
  });

  it("does not throw or emit BullMQ failure duplication for permanent HTTP failure", async () => {
    const { mockPrisma } = createMockPrisma();
    const processorLogs: Array<{ fields: Record<string, unknown>; message: string }> = [];

    await processDeliveryJob({
      data: {
        eventId: "evt_123",
        endpointId: "ep_123",
        deliveryId: "del_123",
      },
      opts: { attempts: 3 },
      attemptsMade: 3,
    } as Job<DeliveryJobData>, {
      prismaClient: mockPrisma,
      logger: {
        info() {},
        warn(fields: Record<string, unknown>, message: string) {
          processorLogs.push({ fields, message });
        },
      },
      webhookDeliverer: async () => {
        throw new HttpDeliveryError(400, "sensitive response body");
      },
    });

    assert.ok(processorLogs.some((log) => log.message === "delivery_failed"));
    assert.ok(processorLogs.some((log) => log.message === "delivery_dead_lettered"));
    assert.equal(
      processorLogs.some((log) =>
        JSON.stringify(log).includes("sensitive response body")
      ),
      false,
    );
  });
});
