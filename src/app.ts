import express from "express";
import { requestContextMiddleware } from "./middleware/request-context.middleware";
import { createHttpMetricsMiddleware } from "./middleware/http-metrics.middleware";
import { authMiddleware } from "./middleware/auth.middleware";
import { MetricsService } from "./metrics/metrics.service";
import webhookRoutes from "./routes/webhook.routes";
import eventRoutes from "./routes/event.routes";
import deliveryRoutes from "./routes/delivery.routes";
import healthRoutes from "./routes/health.routes";

const app = express();
export const metricsService = new MetricsService();

app.use(requestContextMiddleware);
app.use(createHttpMetricsMiddleware({ metrics: metricsService }));
app.use(express.json({ limit: "1mb" }));
app.use("/health", healthRoutes);

app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", metricsService.contentType);
  res.send(await metricsService.exportMetrics());
});

app.use("/api/v1", authMiddleware);

app.use("/api/v1/webhook-endpoints", webhookRoutes);
app.use("/api/v1/events", eventRoutes);
app.use("/api/v1/deliveries", deliveryRoutes);

export default app;
