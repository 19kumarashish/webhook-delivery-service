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
