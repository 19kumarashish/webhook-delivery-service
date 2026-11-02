import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { createHmac } from "node:crypto";
import prisma from "../config/prisma";
import redis from "../config/redis";
import { calculateRetryDelay, hasRetriesExhausted } from "./retry-policy";
import { retryPolicy } from "../config/queue";
import { logger, serializeError } from "../config/logger";
import { runWithLogContext, updateLogContext } from "../logging/context";
import {
  sendWebhookRequest,
  HttpDeliveryError,
  SsrfSecurityError,
  type SendWebhookRequestOptions,
  type WebhookDeliveryResponse,
} from "../services/webhook-http-client";

const retryableProcessorRecordedErrors = new WeakSet<object>();

function markDeliveryProcessorFailure(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    retryableProcessorRecordedErrors.add(error);
  }
}

function wasDeliveryProcessorRecorded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    retryableProcessorRecordedErrors.has(error)
  );
}

export interface DeliveryJobData {
  eventId: string;
  endpointId: string;
  deliveryId?: string;
  requestId?: string;
  correlationId?: string;
}

export type WebhookDeliverer = (
  destinationUrl: string,
  options?: SendWebhookRequestOptions,
) => Promise<WebhookDeliveryResponse>;

export interface ProcessDeliveryDependencies {
  prismaClient?: typeof prisma;
  webhookDeliverer?: WebhookDeliverer;
  logger?: {
    info: (fields: Record<string, unknown>, message: string) => unknown;
    warn: (fields: Record<string, unknown>, message: string) => unknown;
  };
  now?: () => bigint;
}

export interface DeliveryWorkerLogger {
  error: (fields: Record<string, unknown>, message: string) => unknown;
  warn: (fields: Record<string, unknown>, message: string) => unknown;
}

export function registerDeliveryWorkerListeners(
  worker: Worker<DeliveryJobData>,
  workerLogger: DeliveryWorkerLogger = logger,
): void {
  worker.on("error", (error) => {
    workerLogger.error({
      error: serializeError(error),
    }, "worker_error");
  });

  worker.on("failed", (job, error) => {
    if (wasDeliveryProcessorRecorded(error)) {
      return;
    }

    const data = job?.data;
    workerLogger.warn({
      ...(data?.requestId ? { requestId: data.requestId } : {}),
      ...(data?.correlationId || data?.requestId
        ? { correlationId: data.correlationId ?? data.requestId }
        : {}),
      ...(data?.eventId ? { eventId: data.eventId } : {}),
      ...(data?.endpointId ? { endpointId: data.endpointId } : {}),
      ...(data?.deliveryId ? { deliveryId: data.deliveryId } : {}),
      jobId: job?.id,
      attemptNumber: (job?.attemptsMade ?? 0) + 1,
      error: serializeError(error),
    }, "worker_job_failed");
  });
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
  const { eventId, endpointId, deliveryId, requestId } = job.data;
  const correlationId = job.data.correlationId ?? requestId;

  return runWithLogContext(
    {
      ...(requestId ? { requestId } : {}),
      ...(correlationId ? { correlationId } : {}),
      eventId,
      endpointId,
      ...(deliveryId ? { deliveryId } : {}),
    },
    () => processDeliveryJobWithContext(job, dependencies),
  );
}

async function processDeliveryJobWithContext(
  job: Job<DeliveryJobData>,
  dependencies: ProcessDeliveryDependencies,
) {
  const db = dependencies.prismaClient ?? prisma;
  const deliverer = dependencies.webhookDeliverer ?? sendWebhookRequest;
  const deliveryLogger = dependencies.logger ?? logger;
  const now = dependencies.now ?? (() => process.hrtime.bigint());
  const startedAt = now();
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

  if (
    delivery.status === "DEAD_LETTERED" ||
    delivery.status === "SUCCEEDED"
  ) {
    return;
  }

  updateLogContext({
    eventId,
    endpointId,
    deliveryId: delivery.id,
  });

  const attemptNumber = (job.attemptsMade ?? 0) + 1;
  const maxAttempts = job.opts?.attempts ?? 1;
  const lifecycleFields = () => ({
    requestId: job.data.requestId,
    correlationId: job.data.correlationId ?? job.data.requestId,
    eventId,
    deliveryId: delivery.id,
    endpointId,
    attemptNumber,
  });
  const durationMs = () =>
    Math.max(0, Number(now() - startedAt) / 1_000_000);

  deliveryLogger.info({
    ...lifecycleFields(),
    maxAttempts,
  }, "delivery_started");

  // Record failures for inactive endpoints.
  if (!delivery.endpoint.isActive) {
    if (delivery.status !== "PENDING") {
      return;
    }

    const deliveryModel = db.delivery as typeof db.delivery & {
      updateMany?: typeof db.delivery.updateMany;
    };
    if (typeof deliveryModel.updateMany === "function") {
      const claim = await deliveryModel.updateMany({
        where: { id: delivery.id, status: "PENDING" },
        data: {
          status: "PROCESSING",
          attemptCount: { increment: 1 },
        },
      });
      if (claim.count !== 1) {
        return;
      }
    }

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
          status: "DEAD_LETTERED",
          nextAttemptAt: null,
        },
      }),
    ]);

    deliveryLogger.warn({
      ...lifecycleFields(),
      durationMs: durationMs(),
      httpStatusCode: null,
      errorType: "InactiveEndpoint",
      retryable: false,
    }, "delivery_dead_lettered");

    return;
  }

  // Mark delivery as processing and increment attempts.
  if (
    typeof (db.delivery as typeof db.delivery & {
      updateMany?: typeof db.delivery.updateMany;
    }).updateMany === "function"
  ) {
    const claim = await db.delivery.updateMany({
      where: { id: delivery.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
      },
    });
    if (claim.count !== 1) {
      return;
    }
  } else {
    await db.delivery.update({
      where: { id: delivery.id },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
      },
    });
  }

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

    const maxAttempts = job.opts?.attempts ?? 1;
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
          status: finalFailure ? "DEAD_LETTERED" : "PENDING",
          nextAttemptAt: null,
        },
      }),
    ]);

    deliveryLogger.warn({
      ...lifecycleFields(),
      durationMs: durationMs(),
      httpStatusCode,
      errorType: serializeError(error).name,
      retryable: !permanentFailure && !retriesExhausted,
      maxAttempts,
    }, "delivery_failed");

    if (!permanentFailure && !finalFailure) {
      markDeliveryProcessorFailure(error);
      throw error;
    }
    if (finalFailure) {
      deliveryLogger.warn({
        ...lifecycleFields(),
        durationMs: durationMs(),
        httpStatusCode,
        errorType: serializeError(error).name,
        maxAttempts,
      }, "delivery_dead_lettered");
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

  deliveryLogger.info({
    ...lifecycleFields(),
    durationMs: durationMs(),
    httpStatusCode,
    maxAttempts,
  }, "delivery_succeeded");
}

export function createDeliveryWorker(
  redisClient = redis,
  prismaClient = prisma,
  deliverer = sendWebhookRequest,
  workerLogger: DeliveryWorkerLogger = logger,
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
  registerDeliveryWorkerListeners(worker, workerLogger);

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
