
import { Queue } from "bullmq";
import redis from "./redis";
import {
  retryPolicyFromEnvironment,
  type RetryPolicy,
} from "../workers/retry-policy";

export const retryPolicy: RetryPolicy = retryPolicyFromEnvironment();

export const deliveryQueue = new Queue("webhook-deliveries", {
  connection: redis,
});
