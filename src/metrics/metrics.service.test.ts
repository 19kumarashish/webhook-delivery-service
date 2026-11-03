import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import { MetricsService } from "./metrics.service";

const metricNames = [
  "webhook_events_received_total",
  "webhook_delivery_attempts_total",
  "webhook_delivery_success_total",
  "webhook_delivery_failed_total",
  "webhook_delivery_dead_lettered_total",
  "webhook_delivery_retries_total",
  "webhook_http_requests_total",
  "webhook_delivery_duration_seconds",
  "webhook_http_request_duration_seconds",
];

describe("MetricsService", () => {
  it("registers every required metric in an isolated registry", async () => {
    const registry = new Registry();
    const metrics = new MetricsService({ registry });

    assert.deepEqual(
      registry.getMetricsAsArray().map((metric) => metric.name),
      metricNames,
    );
    assert.match(await metrics.exportMetrics(), /webhook_events_received_total/);
  });

  it("counters start at zero and increment correctly", async () => {
    const metrics = new MetricsService({ registry: new Registry() });
    let output = await metrics.exportMetrics();

    for (const name of metricNames.slice(0, 6)) {
      assert.match(output, new RegExp(`^${name}(?:\\{[^}]*\\})? 0(?:\\.0)?$`, "m"));
    }

    metrics.incrementEventsReceived();
    metrics.incrementDeliveryAttempts();
    metrics.recordDeliverySuccess();
    metrics.recordDeliveryFailure();
    metrics.recordDeadLetteredDelivery();
    metrics.incrementRetryCount();
    metrics.recordHttpRequest({
      method: "POST",
      route: "/api/v1/events",
      statusClass: "2xx",
      durationSeconds: 0.125,
    });

    output = await metrics.exportMetrics();
    for (const name of metricNames.slice(0, 7)) {
      assert.match(output, new RegExp(`^${name}(?:\\{[^}]*\\})? 1(?:\\.0)?$`, "m"));
    }
  });

  it("records delivery duration for success and failure outcomes", async () => {
    const metrics = new MetricsService({ registry: new Registry() });

    metrics.recordDeliverySuccess(0.25);
    metrics.recordDeliveryFailure(1.5);

    const output = await metrics.exportMetrics();
    assert.match(output, /webhook_delivery_duration_seconds_count\{outcome="success"\} 1/);
    assert.match(output, /webhook_delivery_duration_seconds_sum\{outcome="success"\} 0\.25/);
    assert.match(output, /webhook_delivery_duration_seconds_count\{outcome="failure"\} 1/);
    assert.match(output, /webhook_delivery_duration_seconds_sum\{outcome="failure"\} 1\.5/);
  });

  it("records HTTP request count and duration with bounded labels", async () => {
    const metrics = new MetricsService({ registry: new Registry() });

    metrics.recordHttpRequest({
      method: "POST",
      route: "/api/v1/events",
      statusClass: "2xx",
      durationSeconds: 0.125,
    });

    let output = await metrics.exportMetrics();
    assert.match(output, /webhook_http_requests_total\{method="POST",route="\/api\/v1\/events",status_class="2xx"\} 1/);

    metrics.recordHttpRequest({
      method: "GET",
      route: "/api/v1/deliveries/:deliveryId",
      statusClass: "4xx",
      durationSeconds: 0.01,
    });
    output = await metrics.exportMetrics();
    assert.match(output, /webhook_http_requests_total\{method="GET",route="\/api\/v1\/deliveries\/:deliveryId",status_class="4xx"\} 1/);

    assert.match(output, /webhook_http_request_duration_seconds_count\{method="POST",route="\/api\/v1\/events",status_class="2xx"\} 1/);
    assert.match(output, /webhook_http_request_duration_seconds_sum\{method="POST",route="\/api\/v1\/events",status_class="2xx"\} 0\.125/);
    assert.match(output, /webhook_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/deliveries\/:deliveryId",status_class="4xx"\} 1/);
    assert.match(output, /webhook_http_request_duration_seconds_sum\{method="GET",route="\/api\/v1\/deliveries\/:deliveryId",status_class="4xx"\} 0\.01/);

    const histogramCounts = [...output.matchAll(/^webhook_http_request_duration_seconds_count\{[^}]+\} ([0-9]+(?:\.[0-9]+)?)/gm)]
      .map((match) => Number(match[1]));
    const histogramSums = [...output.matchAll(/^webhook_http_request_duration_seconds_sum\{[^}]+\} ([0-9]+(?:\.[0-9]+)?)/gm)]
      .map((match) => Number(match[1]));

    assert.equal(histogramCounts.reduce((total, count) => total + count, 0), 2);
    assert.ok(Math.abs(histogramSums.reduce((total, sum) => total + sum, 0) - 0.135) < 0.0000001);
  });

  it("separate metrics service instances use independent registries", async () => {
    const first = new MetricsService({ registry: new Registry() });
    const second = new MetricsService({ registry: new Registry() });

    first.incrementEventsReceived();

    assert.match(await first.exportMetrics(), /^webhook_events_received_total 1(?:\.0)?$/m);
    assert.match(await second.exportMetrics(), /^webhook_events_received_total 0(?:\.0)?$/m);
  });

  it("does not export sensitive identifiers or payload labels", async () => {
    const metrics = new MetricsService({ registry: new Registry() });
    metrics.recordHttpRequest({
      method: "POST",
      route: "/api/v1/events",
      statusClass: "4xx",
      durationSeconds: 0.02,
    });
    metrics.recordDeliveryDuration("failure", 0.5);

    const output = await metrics.exportMetrics();
    for (const sensitive of [
      "request_123",
      "correlation_123",
      "delivery_123",
      "event_123",
      "endpoint_123",
      "https://example.com/webhook",
      "payload-secret",
    ]) {
      assert.equal(output.includes(sensitive), false);
    }
  });

  it("defaults to a fresh private registry for each instance", async () => {
    const first = new MetricsService();
    const second = new MetricsService();

    first.incrementDeliveryAttempts();
    first.incrementDeliveryAttempts();

    assert.match(await first.exportMetrics(), /^webhook_delivery_attempts_total 2(?:\.0)?$/m);
    assert.match(await second.exportMetrics(), /^webhook_delivery_attempts_total 0(?:\.0)?$/m);
  });
});
