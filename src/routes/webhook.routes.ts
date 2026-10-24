import { Router } from "express";
import { z } from "zod";
import { createWebhookEndpoint } from "../services/webhook.service";

const router = Router();

const createWebhookSchema = z.object({
  url: z.string().url(),
  subscribedEvents: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(50),
});

router.post("/", async (req, res) => {
  const result = createWebhookSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: result.error.issues,
    });
  }

  try {
    const endpoint = await createWebhookEndpoint(result.data);

    return res.status(201).json({
      message: "Webhook endpoint created successfully",
      data: endpoint,
    });
  } catch (error) {
    console.error("Failed to create webhook endpoint:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

export default router;