import { Counter, Histogram, Registry } from "@prometheus-io/client";

export type DeliveryOutcome = "success" | "failure";
export type HttpStatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";

export interface HttpRequestMetric {
  method: string;
  route: string;
  statusClass: HttpStatusClass;
  durationSeconds: number;
}

export interface MetricsServiceOptions {
  registry?: Registry;
}

export class MetricsService {
  private readonly registry: Registry;
  private readonly eventsReceived: Counter<string>;
  private readonly deliveryAttempts: Counter<string>;
  private readonly deliverySuccesses: Counter<string>;
  private readonly deliveryFailures: Counter<string>;
  private readonly deliveryDeadLettered: Counter<string>;
  private readonly deliveryRetries: Counter<string>;
  private readonly httpRequests: Counter<string>;
  private readonly deliveryDuration: Histogram<"outcome">;
  private readonly httpRequestDuration: Histogram<
    "method" | "route" | "status_class"
  >;

  constructor(options: MetricsServiceOptions = {}) {
    this.registry = options.registry ?? new Registry();

    this.eventsReceived = new Counter({
      name: "webhook_events_received_total",
      help: "Total number of webhook events successfully received",
      registers: [this.registry],
    });
    this.deliveryAttempts = new Counter({
      name: "webhook_delivery_attempts_total",
      help: "Total number of webhook delivery attempts",
      registers: [this.registry],
    });
    this.deliverySuccesses = new Counter({
      name: "webhook_delivery_success_total",
      help: "Total number of successful webhook deliveries",
      registers: [this.registry],
    });
    this.deliveryFailures = new Counter({
      name: "webhook_delivery_failed_total",
      help: "Total number of failed webhook delivery attempts",
      registers: [this.registry],
    });
    this.deliveryDeadLettered = new Counter({
      name: "webhook_delivery_dead_lettered_total",
      help: "Total number of webhook deliveries moved to dead-lettered state",
      registers: [this.registry],
    });
    this.deliveryRetries = new Counter({
      name: "webhook_delivery_retries_total",
      help: "Total number of webhook delivery retry attempts",
      registers: [this.registry],
    });
    this.httpRequests = new Counter({
      name: "webhook_http_requests_total",
      help: "Total number of HTTP requests handled by the webhook service",
      labelNames: ["method", "route", "status_class"] as const,
      registers: [this.registry],
    });
    this.deliveryDuration = new Histogram({
      name: "webhook_delivery_duration_seconds",
      help: "Duration of webhook delivery attempts in seconds",
      labelNames: ["outcome"] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });
    this.httpRequestDuration = new Histogram({
      name: "webhook_http_request_duration_seconds",
      help: "Duration of HTTP requests handled by the webhook service in seconds",
      labelNames: ["method", "route", "status_class"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
  }

  incrementEventsReceived(): void {
    this.eventsReceived.inc();
  }

  incrementDeliveryAttempts(): void {
    this.deliveryAttempts.inc();
  }

  recordDeliverySuccess(durationSeconds?: number): void {
    this.deliverySuccesses.inc();
    if (durationSeconds !== undefined) {
      this.recordDeliveryDuration("success", durationSeconds);
    }
  }

  recordDeliveryFailure(durationSeconds?: number): void {
    this.deliveryFailures.inc();
    if (durationSeconds !== undefined) {
      this.recordDeliveryDuration("failure", durationSeconds);
    }
  }

  recordDeadLetteredDelivery(): void {
    this.deliveryDeadLettered.inc();
  }

  incrementRetryCount(): void {
    this.deliveryRetries.inc();
  }

  recordDeliveryDuration(outcome: DeliveryOutcome, durationSeconds: number): void {
    this.deliveryDuration.observe({ outcome }, durationSeconds);
  }

  recordHttpRequest(metric: HttpRequestMetric): void {
    const labels = {
      method: metric.method,
      route: metric.route,
      status_class: metric.statusClass,
    };
    this.httpRequests.inc(labels);
    this.httpRequestDuration.observe(labels, metric.durationSeconds);
  }

  async exportMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
