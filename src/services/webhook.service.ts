import { randomBytes } from "node:crypto";
import prisma from "../config/prisma";

interface CreateWebhookInput {
  url: string;
  subscribedEvents: string[];
}

export async function createWebhookEndpoint(
  input: CreateWebhookInput
) {
  const secret = randomBytes(32).toString("hex");

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      url: input.url,
      secret,
      subscribedEvents: input.subscribedEvents,
    },
    select: {
      id: true,
      url: true,
      subscribedEvents: true,
      isActive: true,
      createdAt: true,
    },
  });

  return {
    ...endpoint,
    secret,
  };
}