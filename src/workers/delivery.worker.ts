
import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { createHmac } from "node:crypto";
import prisma from "../config/prisma";
import redis from "../config/redis";
import { hasRetriesExhausted } from "./retry-policy";
interface DeliveryJobData {
  eventId: string;
  endpointId: string;
}

const worker = new Worker<DeliveryJobData>(
  "webhook-deliveries",
  async (job: Job<DeliveryJobData>) => {
    const { eventId, endpointId } = job.data;

    // Load the event and destination.
    const delivery = await prisma.delivery.findUnique({
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
      await prisma.$transaction([
        prisma.deliveryAttempt.create({
          data: {
            deliveryId: delivery.id,
            errorMessage: "Webhook endpoint is inactive",
          },
        }),
        prisma.delivery.update({
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
    await prisma.delivery.update({
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

      const response = await fetch(delivery.endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": delivery.event.eventType,
          "X-Webhook-Delivery": delivery.id,
          "X-Webhook-Signature": `sha256=${signature}`,
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });

      httpStatusCode = response.status;
      responseBody = (await response.text()).slice(0, 10_000);

      if (!response.ok) {
        throw new Error(`Destination returned HTTP ${response.status}`);
      }
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : "Unknown delivery error";

      const maxAttempts = job.opts.attempts ?? 1;
      const retriesExhausted = hasRetriesExhausted(
        job.attemptsMade,
        maxAttempts,
      );

      await prisma.$transaction([
        prisma.deliveryAttempt.create({
          data: {
            deliveryId: delivery.id,
            httpStatusCode,
            responseBody,
            errorMessage,
          },
        }),
        prisma.delivery.update({
          where: { id: delivery.id },
          data: {
            status: retriesExhausted ? "FAILED" : "PENDING",
            nextAttemptAt: null,
          },
        }),
      ]);

      throw error;
    }

    // Persist success outside the HTTP catch so database errors
    // are not misclassified as HTTP delivery failures.
    await prisma.$transaction([
      prisma.deliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          httpStatusCode,
          responseBody,
        },
      }),
      prisma.delivery.update({
        where: { id: delivery.id },
        data: {
          status: "SUCCEEDED",
          nextAttemptAt: null,
        },
      }),
    ]);
  },
  {
    connection: redis,
    concurrency: 5,
  },
);

worker.on("completed", (job) => {
  console.log(`Delivery job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`Delivery job ${job?.id} failed:`, error.message);
});

console.log("Webhook delivery worker started");

async function shutdown() {
  console.log("Shutting down webhook worker...");
  await worker.close();
  await redis.quit();
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
