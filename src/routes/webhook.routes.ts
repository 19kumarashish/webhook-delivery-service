import { Router } from "express";
import { z } from "zod";
import {
  createWebhookEndpoint,
  WebhookUrlValidationError,
  type WebhookEndpointCreator,
} from "../services/webhook.service";

const createWebhookSchema = z.object({
  url: z.string().url(),
  subscribedEvents: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(50),
});

export function createWebhookRouter(
  endpointCreator: WebhookEndpointCreator = createWebhookEndpoint,
  logError: (message: string, error: unknown) => void = console.error,
) {
  const router = Router();

  router.post("/", async (req, res) => {
    const result = createWebhookSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Invalid request",
        details: result.error.issues,
      });
    }

    try {
      const endpoint = await endpointCreator(result.data);

      return res.status(201).json({
        message: "Webhook endpoint created successfully",
        data: endpoint,
      });
    } catch (error) {
      if (error instanceof WebhookUrlValidationError) {
        return res.status(400).json({
          error: "Invalid webhook URL: destination is not permitted or could not be resolved",
        });
      }

      logError("Failed to create webhook endpoint:", error);

      return res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  return router;
}

export default createWebhookRouter();
