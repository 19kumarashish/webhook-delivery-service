import { Router } from "express";
import {
  getDeliveryAttempts,
  getDeliveryById,
  listDeadLetteredDeliveries,
  replayDeadLetteredDelivery,
  DeadLetterNotFoundError,
  DeadLetterNotEligibleError,
  DeadLetterReplayConflictError,
} from "../services/delivery.service";

export function createDeliveryRouter(
  deliveryFinder: typeof getDeliveryById = getDeliveryById,
  logError: (message: string, error: unknown) => void = console.error,
  deliveryAttemptsFinder: typeof getDeliveryAttempts = getDeliveryAttempts,
  deadLetterLister: typeof listDeadLetteredDeliveries = listDeadLetteredDeliveries,
  deadLetterReplayer: typeof replayDeadLetteredDelivery = replayDeadLetteredDelivery,
) {
  const router = Router();

  router.get("/dlq", async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 10);
    const eventType = typeof req.query.eventType === "string"
      ? req.query.eventType
      : undefined;
    const endpointId = typeof req.query.endpointId === "string"
      ? req.query.endpointId
      : undefined;

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (eventType !== undefined && (eventType.length < 1 || eventType.length > 100)) ||
      (endpointId !== undefined && (endpointId.length < 1 || endpointId.length > 255))
    ) {
      return res.status(400).json({
        error: "Invalid pagination or filter parameters",
      });
    }

    try {
      const result = await deadLetterLister({
        page,
        limit,
        eventType,
        endpointId,
      });
      return res.status(200).json({
        data: result.deliveries,
        pagination: result.pagination,
      });
    } catch (error) {
      logError("Failed to list dead-lettered deliveries:", error);
      return res.status(500).json({
        error: "Failed to list dead-lettered deliveries",
      });
    }
  });

  router.post("/dlq/:deliveryId/replay", async (req, res) => {
    const deliveryId = req.params.deliveryId;
    try {
      const result = await deadLetterReplayer(deliveryId);
      return res.status(202).json({
        message: "Dead-lettered delivery replay accepted",
        data: result,
      });
    } catch (error) {
      if (error instanceof DeadLetterNotFoundError) {
        return res.status(404).json({ error: "Delivery not found" });
      }
      if (error instanceof DeadLetterNotEligibleError) {
        return res.status(409).json({
          error: "Delivery is not eligible for replay",
        });
      }
      if (error instanceof DeadLetterReplayConflictError) {
        return res.status(409).json({
          error: "Delivery replay is already in progress",
        });
      }
      logError("Failed to replay dead-lettered delivery:", error);
      return res.status(500).json({
        error: "Failed to replay dead-lettered delivery",
      });
    }
  });

  router.get("/dlq/:deliveryId", async (req, res) => {
    const { deliveryId } = req.params;
    try {
      const delivery = await deliveryFinder(deliveryId);
      if (!delivery || delivery.status !== "DEAD_LETTERED") {
        return res.status(404).json({
          error: "Dead-lettered delivery not found",
        });
      }
      return res.status(200).json({ data: delivery });
    } catch (error) {
      logError("Failed to retrieve dead-lettered delivery:", error);
      return res.status(500).json({
        error: "Failed to retrieve dead-lettered delivery",
      });
    }
  });

  router.get("/:deliveryId/attempts", async (req, res) => {
    const { deliveryId } = req.params;

    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return res.status(400).json({
        error:
          "page must be a positive integer and limit must be between 1 and 100",
      });
    }

    try {
      const result = await deliveryAttemptsFinder(
        deliveryId,
        page,
        limit,
      );

      if (!result) {
        return res.status(404).json({
          error: "Delivery not found",
        });
      }

      return res.status(200).json({
        data: result.attempts,
        pagination: result.pagination,
      });
    } catch (error) {
      logError("Failed to retrieve delivery attempts:", error);

      return res.status(500).json({
        error: "Failed to retrieve delivery attempts",
      });
    }
  });

  router.get("/:deliveryId", async (req, res) => {
    const { deliveryId } = req.params;

    try {
      const delivery = await deliveryFinder(deliveryId);

      if (!delivery) {
        return res.status(404).json({
          error: "Delivery not found",
        });
      }

      return res.status(200).json({
        data: delivery,
      });
    } catch (error) {
      logError("Failed to retrieve delivery:", error);

      return res.status(500).json({
        error: "Failed to retrieve delivery",
      });
    }
  });

  return router;
}

export default createDeliveryRouter();