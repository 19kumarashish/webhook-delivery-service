import { Router } from "express";
import {
  getDeliveryAttempts,
  getDeliveryById,
} from "../services/delivery.service";

export function createDeliveryRouter(
  deliveryFinder: typeof getDeliveryById = getDeliveryById,
  logError: (message: string, error: unknown) => void = console.error,
  deliveryAttemptsFinder: typeof getDeliveryAttempts = getDeliveryAttempts,
) {
  const router = Router();

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