import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { createHmac } from "node:crypto";
import prisma from "../config/prisma";
import redis from "../config/redis";
import { calculateRetryDelay, hasRetriesExhausted } from "./retry-policy";
import { retryPolicy } from "../config/queue";
import {
  sendWebhookRequest,
  HttpDeliveryError,
  SsrfSecurityError,
  type SendWebhookRequestOptions,
  type WebhookDeliveryResponse,
} from "../services/webhook-http-client";

export interface DeliveryJobData {
  eventId: string;
  endpointId: string;
}

export type WebhookDeliverer = (
  destinationUrl: string,
  options?: SendWebhookRequestOptions,
) => Promise<WebhookDeliveryResponse>;

export interface ProcessDeliveryDependencies {
  prismaClient?: typeof prisma;
  webhookDeliverer?: WebhookDeliverer;
}

export function isPermanentDeliveryFailure(error: unknown): boolean {
  if (error instanceof SsrfSecurityError) {
    return true;
  }
  if (error instanceof HttpDeliveryError) {
    const status = error.statusCode;
    return (
      (status >= 300 && status < 400) ||
      (status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429)
    );
  }
  return false;
}

export async function processDeliveryJob(
  job: Job<DeliveryJobData>,
  dependencies: ProcessDeliveryDependencies = {},
) {
  const db = dependencies.prismaClient ?? prisma;
  const deliverer = dependencies.webhookDeliverer ?? sendWebhookRequest;
  const { eventId, endpointId } = job.data;

  // Load the event and destination.
  const delivery = await db.delivery.findUnique({
    where: {
      eventId_endpointId: {
        eventId,
        endpointId,
      },
    },
    include: {
      event: true,
      endpoint: true,
    },
  });

  if (!delivery) {
    throw new Error(
      `Delivery not found for event ${eventId} and endpoint ${endpointId}`,
    );
  }

  // Record failures for inactive endpoints.
  if (!delivery.endpoint.isActive) {
    await db.$transaction([
      db.deliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          errorMessage: "Webhook endpoint is inactive",
        },
      }),
      db.delivery.update({
        where: { id: delivery.id },
        data: {
          status: "FAILED",
          nextAttemptAt: null,
        },
      }),
    ]);

    return;
  }

  // Mark delivery as processing and increment attempts.
  await db.delivery.update({
    where: { id: delivery.id },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
    },
  });

  let httpStatusCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  let payload: string;

  try {
    payload = JSON.stringify({
      id: delivery.event.id,
      type: delivery.event.eventType,
      createdAt: delivery.event.createdAt.toISOString(),
      data: delivery.event.payload,
    });

    const signature = createHmac("sha256", delivery.endpoint.secret)
      .update(payload)
      .digest("hex");

    const deliveryResponse = await deliverer(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": delivery.event.eventType,
        "X-Webhook-Delivery": delivery.id,
        "X-Webhook-Signature": `sha256=${signature}`,
      },
      body: payload,
      timeoutMs: 10_000,
    });

    httpStatusCode = deliveryResponse.statusCode;
    responseBody = deliveryResponse.body;
  } catch (error) {
    if (error instanceof HttpDeliveryError) {
      httpStatusCode = error.statusCode;
      responseBody = error.responseBody;
    }

    errorMessage =
      error instanceof Error ? error.message : "Unknown delivery error";

    const maxAttempts = job.opts.attempts ?? 1;
    const permanentFailure = isPermanentDeliveryFailure(error);
    const retriesExhausted = hasRetriesExhausted(
      job.attemptsMade,
      maxAttempts,
    );
    const finalFailure = permanentFailure || retriesExhausted;

    await db.$transaction([
      db.deliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          httpStatusCode,
          responseBody,
          errorMessage,
        },
      }),
      db.delivery.update({
        where: { id: delivery.id },
        data: {
          status: finalFailure ? "FAILED" : "PENDING",
          nextAttemptAt: null,
        },
      }),
    ]);

    if (!permanentFailure) {
      throw error;
    }
    return;
  }

  // Persist success outside the HTTP catch so database errors
  // are not misclassified as HTTP delivery failures.
  await db.$transaction([
    db.deliveryAttempt.create({
      data: {
        deliveryId: delivery.id,
        httpStatusCode,
        responseBody,
      },
    }),
    db.delivery.update({
      where: { id: delivery.id },
      data: {
        status: "SUCCEEDED",
        nextAttemptAt: null,
      },
    }),
  ]);
}

export function createDeliveryWorker(
  redisClient = redis,
  prismaClient = prisma,
  deliverer = sendWebhookRequest,
) {
  const worker = new Worker<DeliveryJobData>(
    "webhook-deliveries",
    (job) => processDeliveryJob(job, { prismaClient, webhookDeliverer: deliverer }),
    {
      connection: redisClient,
      concurrency: 5,
      settings: {
        backoffStrategy: (attemptsMade: number) =>
          calculateRetryDelay(attemptsMade, retryPolicy),
      },
    },
  );

  worker.on("completed", (job) => {
    console.log(`Delivery job ${job.id} completed`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Delivery job ${job?.id} failed:`, error.message);
  });

  return worker;
}

let workerInstance: Worker<DeliveryJobData> | null = null;

// Only start the worker process when executed directly as the main module
if (require.main === module) {
  workerInstance = createDeliveryWorker();
  console.log("Webhook delivery worker started");

  async function shutdown() {
    console.log("Shutting down webhook worker...");
    if (workerInstance) {
      await workerInstance.close();
    }
    await redis.quit();
    await prisma.$disconnect();
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
