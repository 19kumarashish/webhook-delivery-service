import express from "express";
import webhookRoutes from "./routes/webhook.routes";
import eventRoutes from "./routes/event.routes";
import deliveryRoutes from "./routes/delivery.routes";

const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "webhook-delivery-service",
  });
});

app.use("/api/v1/webhook-endpoints", webhookRoutes);
app.use("/api/v1/events", eventRoutes);
app.use("/api/v1/deliveries", deliveryRoutes);

export default app;