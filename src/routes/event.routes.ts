
import { Router } from "express";
import { z } from "zod";
import { createEvent } from "../services/event.service";

const router = Router();

const createEventSchema = z.object({
  eventType: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(255),
});

router.post("/", async (req, res) => {
  const result = createEventSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: result.error.issues,
    });
  }

  try {
    const resultEvent = await createEvent(result.data);

    return res.status(202).json({
      message: "Event accepted for processing",
      data: {
        id: resultEvent.event.id,
        eventType: resultEvent.event.eventType,
        matchedEndpoints: resultEvent.matchedEndpoints,
        createdAt: resultEvent.event.createdAt,
      },
    });
  } catch (error) {
    console.error("Failed to create event:", error);

    return res.status(500).json({
      error: "Failed to accept event",
    });
  }
});

export default router;
