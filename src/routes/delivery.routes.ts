import { Router } from "express";
import { getDeliveryById } from "../services/delivery.service";

export function createDeliveryRouter(
  deliveryFinder: typeof getDeliveryById = getDeliveryById,
  logError: (message: string, error: unknown) => void = console.error,
) {
  const router = Router();

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
