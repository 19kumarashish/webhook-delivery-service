import { randomBytes } from "node:crypto";
import prisma from "../config/prisma";
import { validateWebhookUrl, type LookupHost } from "./webhook-url";

export interface CreateWebhookInput {
  url: string;
  subscribedEvents: string[];
}

export class WebhookUrlValidationError extends Error {
  constructor(message = "Invalid or prohibited webhook URL") {
    super(message);
    this.name = "WebhookUrlValidationError";
  }
}

export type WebhookEndpointCreator = typeof createWebhookEndpoint;

export async function createWebhookEndpoint(
  input: CreateWebhookInput,
  urlValidator: (
    url: string,
    lookupHost?: LookupHost,
  ) => Promise<boolean> = validateWebhookUrl,
  lookupHost?: LookupHost,
) {
  const isValid = await urlValidator(input.url, lookupHost);

  if (!isValid) {
    throw new WebhookUrlValidationError();
  }

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
