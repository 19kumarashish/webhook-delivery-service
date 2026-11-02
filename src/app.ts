import express from "express";
import { requestContextMiddleware } from "./middleware/request-context.middleware";
import webhookRoutes from "./routes/webhook.routes";
import eventRoutes from "./routes/event.routes";
import deliveryRoutes from "./routes/delivery.routes";
import healthRoutes from "./routes/health.routes";

const app = express();

app.use(requestContextMiddleware);
app.use(express.json({ limit: "1mb" }));
app.use("/health", healthRoutes);

app.use("/api/v1/webhook-endpoints", webhookRoutes);
app.use("/api/v1/events", eventRoutes);
app.use("/api/v1/deliveries", deliveryRoutes);

export default app;