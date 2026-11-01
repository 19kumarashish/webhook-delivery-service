
import { Queue } from "bullmq";
import redis from "./redis";
import {
  retryPolicyFromEnvironment,
  type RetryPolicy,
} from "../workers/retry-policy";

export const retryPolicy: RetryPolicy = retryPolicyFromEnvironment();

let deliveryQueueInstance: Queue | null = null;

export function getDeliveryQueue(): Queue {
  if (!deliveryQueueInstance) {
    deliveryQueueInstance = new Queue("webhook-deliveries", {
      connection: redis,
    });
  }
  return deliveryQueueInstance;
}

export const deliveryQueue = new Proxy({} as Queue, {
  get(_target, property, receiver) {
    const queue = getDeliveryQueue();
    const value = Reflect.get(queue, property, receiver);
    return typeof value === "function" ? value.bind(queue) : value;
  },
});
