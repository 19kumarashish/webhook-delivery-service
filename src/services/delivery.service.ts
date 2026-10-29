import prisma from "../config/prisma";

export async function getDeliveryById(deliveryId: string) {
  return prisma.delivery.findUnique({
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
) {
  const skip = (page - 1) * limit;

  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    select: { id: true },
  });

  if (!delivery) {
    return null;
  }

  const [attempts, total] = await prisma.$transaction([
    prisma.deliveryAttempt.findMany({
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
    prisma.deliveryAttempt.count({
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