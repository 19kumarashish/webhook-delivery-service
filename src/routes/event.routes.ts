
import { Router } from "express";
import { z } from "zod";
import { createEvent } from "../services/event.service";
import { DuplicateIdempotencyKeyError } from "../services/event.errors";

const createEventSchema = z.object({
  eventType: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(255),
});

export function createEventRouter(
  eventCreator: typeof createEvent = createEvent,
  logError: (message: string, error: unknown) => void = console.error,
) {
  const router = Router();

  router.post("/", async (req, res) => {
    const result = createEventSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Invalid request",
        details: result.error.issues,
      });
    }

    try {
      const resultEvent = await eventCreator(result.data);

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
      if (error instanceof DuplicateIdempotencyKeyError) {
        return res.status(409).json({
          error: "An event with this idempotency key already exists",
        });
      }

      logError("Failed to create event:", error);

      return res.status(500).json({
        error: "Failed to accept event",
      });
    }
  });

  return router;
}

export default createEventRouter();
