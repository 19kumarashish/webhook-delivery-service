
import { Prisma, type Event } from "@prisma/client";
import prisma from "../config/prisma";
import { deliveryQueue } from "../config/queue";
import {
  DuplicateIdempotencyKeyError,
  isDuplicateIdempotencyKeyError,
} from "./event.errors";

interface CreateEventInput {
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export async function createEvent(input: CreateEventInput) {
  // Find endpoints subscribed to this event.
  const endpoints = await prisma.webhookEndpoint.findMany({
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
    event = await prisma.$transaction(async (tx) => {
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

  // Queue delivery jobs after the database transaction commits.
  if (endpoints.length > 0) {
    await deliveryQueue.addBulk(
      endpoints.map((endpoint) => ({
        name: "deliver-webhook",
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
        },
        opts: {
          attempts: 5,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      })),
    );
  }

  return {
    event,
    matchedEndpoints: endpoints.length,
  };
}
