
import { Queue } from "bullmq";
import redis from "./redis";

export const deliveryQueue = new Queue("webhook-deliveries", {
  connection: redis,
});
