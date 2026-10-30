import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, describe, it } from "node:test";
import type { Job } from "bullmq";
import {
  processDeliveryJob,
  type DeliveryJobData,
} from "./delivery.worker";
import {
  HttpDeliveryError,
  SsrfSecurityError,
} from "../services/webhook-http-client";
import prisma from "../config/prisma";
import redis from "../config/redis";

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

  it("records delivery failure and status FAILED on permanent SSRF rejection", async () => {
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
    assert.equal(lastUpdate.data.status, "FAILED");
    assert.equal(transactions.length, 1);
  });

  it("records delivery failure and status FAILED when retries are exhausted on 3xx redirect", async () => {
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
    assert.equal(lastUpdate.data.status, "FAILED");
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
    assert.equal(updates[0].data.status, "FAILED");
    assert.equal(transactions.length, 1);
  });
});
