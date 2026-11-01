import { randomUUID } from "node:crypto";
import prisma from "../config/prisma";
import { deliveryQueue, retryPolicy } from "../config/queue";
import { createBullMqRetryOptions } from "../workers/retry-policy";
import { validateWebhookUrl } from "./webhook-url";

export class DeadLetterReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadLetterReplayError";
  }
}

export class DeadLetterNotFoundError extends DeadLetterReplayError {
  constructor() {
    super("Dead-lettered delivery not found");
    this.name = "DeadLetterNotFoundError";
  }
}

export class DeadLetterNotEligibleError extends DeadLetterReplayError {
  constructor() {
    super("Delivery is not eligible for replay");
    this.name = "DeadLetterNotEligibleError";
  }
}

export class DeadLetterReplayConflictError extends DeadLetterReplayError {
  constructor() {
    super("Delivery replay is already in progress");
    this.name = "DeadLetterReplayConflictError";
  }
}

export interface ListDeadLetteredInput {
  page: number;
  limit: number;
  eventType?: string;
  endpointId?: string;
}

export interface ListDeadLetteredDependencies {
  prismaClient?: typeof prisma;
}

export async function listDeadLetteredDeliveries(
  input: ListDeadLetteredInput,
  dependencies: ListDeadLetteredDependencies = {},
) {
  const db = dependencies.prismaClient ?? prisma;
  const skip = (input.page - 1) * input.limit;
  const where = {
    status: "DEAD_LETTERED" as const,
    ...(input.endpointId ? { endpointId: input.endpointId } : {}),
    ...(input.eventType
      ? { event: { eventType: { contains: input.eventType, mode: "insensitive" as const } } }
      : {}),
  };

  const [deliveries, total] = await db.$transaction([
    db.delivery.findMany({
      where,
      skip,
      take: input.limit,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        attemptCount: true,
        createdAt: true,
        updatedAt: true,
        event: {
          select: { id: true, eventType: true, createdAt: true },
        },
        endpoint: {
          select: { id: true, url: true, isActive: true },
        },
        attempts: {
          orderBy: { attemptedAt: "desc" },
          take: 1,
          select: {
            id: true,
            httpStatusCode: true,
            responseBody: true,
            errorMessage: true,
            attemptedAt: true,
          },
        },
      },
    }),
    db.delivery.count({ where }),
  ]);

  return {
    deliveries,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
}

export interface ReplayDeadLetterDependencies {
  prismaClient?: typeof prisma;
  queueClient?: typeof deliveryQueue;
  urlValidator?: typeof validateWebhookUrl;
}

export async function replayDeadLetteredDelivery(
  deliveryId: string,
  dependencies: ReplayDeadLetterDependencies = {},
) {
  const db = dependencies.prismaClient ?? prisma;
  const queue = dependencies.queueClient ?? deliveryQueue;
  const urlValidator = dependencies.urlValidator ?? validateWebhookUrl;

  const delivery = await db.delivery.findUnique({
    where: { id: deliveryId },
    include: {
      event: true,
      endpoint: true,
    },
  });

  if (!delivery) {
    throw new DeadLetterNotFoundError();
  }
  if (delivery.status !== "DEAD_LETTERED") {
    throw new DeadLetterNotEligibleError();
  }
  if (!delivery.endpoint.isActive) {
    throw new DeadLetterNotEligibleError();
  }

  if (!(await urlValidator(delivery.endpoint.url))) {
    throw new DeadLetterNotEligibleError();
  }

  const replayed = await db.$transaction(async (tx) => {
    const result = await tx.delivery.updateMany({
      where: {
        id: deliveryId,
        status: "DEAD_LETTERED",
        endpointId: delivery.endpointId,
      },
      data: {
        status: "PENDING",
        nextAttemptAt: null,
      },
    });

    if (result.count !== 1) {
      throw new DeadLetterReplayConflictError();
    }

    return true;
  });

  if (!replayed) {
    throw new DeadLetterReplayConflictError();
  }

  try {
    await queue.add(
      "deliver-webhook",
      {
        eventId: delivery.eventId,
        endpointId: delivery.endpointId,
      },
      {
        ...createBullMqRetryOptions(retryPolicy),
        jobId: `delivery:${deliveryId}:replay:${randomUUID()}`,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  } catch (error) {
    await db.delivery.updateMany({
      where: { id: deliveryId, status: "PENDING" },
      data: {
        status: "DEAD_LETTERED",
        nextAttemptAt: null,
      },
    });
    throw error;
  }

  return {
    id: delivery.id,
    status: "PENDING" as const,
    eventId: delivery.eventId,
    endpointId: delivery.endpointId,
  };
}

export async function getDeliveryById(
  deliveryId: string,
  dependencies: { prismaClient?: typeof prisma } = {},
) {
  const db = dependencies.prismaClient ?? prisma;
  return db.delivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true,
      status: true,
      attemptCount: true,
      nextAttemptAt: true,
      createdAt: true,
      updatedAt: true,
      event: {
        select: {
          id: true,
          eventType: true,
          createdAt: true,
          payload: true,
        },
      },
      endpoint: {
        select: {
          id: true,
          url: true,
          isActive: true,
        },
      },
      attempts: {
        orderBy: {
          attemptedAt: "desc",
        },
        select: {
          id: true,
          httpStatusCode: true,
          responseBody: true,
          errorMessage: true,
          attemptedAt: true,
        },
      },
    },
  });
}
export async function getDeliveryAttempts(
  deliveryId: string,
  page: number,
  limit: number,
  dependencies: { prismaClient?: typeof prisma } = {},
) {
  const db = dependencies.prismaClient ?? prisma;
  const skip = (page - 1) * limit;

  const delivery = await db.delivery.findUnique({
    where: { id: deliveryId },
    select: { id: true },
  });

  if (!delivery) {
    return null;
  }

  const [attempts, total] = await db.$transaction([
    db.deliveryAttempt.findMany({
      where: { deliveryId },
      orderBy: [
        { attemptedAt: "desc" },
        { id: "desc" },
      ],
      skip,
      take: limit,
      select: {
        id: true,
        httpStatusCode: true,
        responseBody: true,
        errorMessage: true,
        attemptedAt: true,
      },
    }),
    db.deliveryAttempt.count({
      where: { deliveryId },
    }),
  ]);

  return {
    attempts,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}