
import { Prisma, type Event } from "@prisma/client";
import prisma from "../config/prisma";
import { deliveryQueue, retryPolicy } from "../config/queue";
import { createBullMqRetryOptions } from "../workers/retry-policy";
import { logger } from "../config/logger";
import { getLogContext, updateLogContext } from "../logging/context";
import {
  DuplicateIdempotencyKeyError,
  isDuplicateIdempotencyKeyError,
} from "./event.errors";

interface CreateEventInput {
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface CreateEventDependencies {
  prismaClient?: typeof prisma;
  queueClient?: typeof deliveryQueue;
  logger?: Pick<typeof logger, "info">;
}

export async function createEvent(
  input: CreateEventInput,
  dependencies: CreateEventDependencies = {},
) {
  const db = dependencies.prismaClient ?? prisma;
  const queue = dependencies.queueClient ?? deliveryQueue;
  const eventLogger = dependencies.logger ?? logger;
  const logContext = getLogContext();
  const requestId = logContext?.requestId;
  const correlationId = logContext?.correlationId ?? requestId;

  // Find endpoints subscribed to this event.
  const endpoints = await db.webhookEndpoint.findMany({
    where: {
      isActive: true,
      subscribedEvents: {
        has: input.eventType,
      },
    },
    select: {
      id: true,
    },
  });

  // Save the event and create its delivery records atomically.
  let event: Event;
  try {
    event = await db.$transaction(async (tx) => {
      const createdEvent = await tx.event.create({
        data: {
          eventType: input.eventType,
          payload: input.payload as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey,
        },
      });

      if (endpoints.length > 0) {
        await tx.delivery.createMany({
          data: endpoints.map((endpoint) => ({
            eventId: createdEvent.id,
            endpointId: endpoint.id,
          })),
        });
      }

      return createdEvent;
    });
  } catch (error) {
    if (isDuplicateIdempotencyKeyError(error)) {
      throw new DuplicateIdempotencyKeyError();
    }

    throw error;
  }

  updateLogContext({ eventId: event.id });
  eventLogger.info({
    ...logContext,
    requestId,
    correlationId,
    eventId: event.id,
    matchedEndpoints: endpoints.length,
  }, "event_ingested");

  // Queue delivery jobs after the database transaction commits.
  if (endpoints.length > 0) {
    await queue.addBulk(
      endpoints.map((endpoint) => ({
        name: "deliver-webhook",
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          ...(correlationId ? { correlationId } : {}),
          ...(requestId ? { requestId } : {}),
        },
        opts: {
          ...createBullMqRetryOptions(retryPolicy),
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      })),
    );

    for (const endpoint of endpoints) {
      eventLogger.info({
        requestId,
        correlationId,
        eventId: event.id,
        endpointId: endpoint.id,
      }, "event_delivery_queued");
    }
  }

  return {
    event,
    matchedEndpoints: endpoints.length,
  };
}
