import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Request, Response } from "express";
import { describe, it } from "node:test";
import type { HttpRequestMetric } from "../metrics/metrics.service";
import {
  createHttpMetricsMiddleware,
  getRouteTemplate,
  normalizeHttpMethod,
  normalizeHttpStatus,
  safeDurationSeconds,
} from "./http-metrics.middleware";

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("HTTP metrics middleware", () => {
  it("records a successful response with its route template", async () => {
    const recorded: HttpRequestMetric[] = [];
    const app = express();
    app.use(createHttpMetricsMiddleware({
      metrics: { recordHttpRequest: (metric) => recorded.push(metric) },
      now: (() => {
        let call = 0;
        return () => BigInt(call++ === 0 ? 1_000_000_000 : 1_250_000_000);
      })(),
    }));
    app.get("/deliveries/:deliveryId", (_req, res) => res.status(204).end());

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/deliveries/delivery_123?secret=value`);
      assert.equal(response.status, 204);
    });

    assert.deepEqual(recorded, [{
      method: "GET",
      route: "/deliveries/:deliveryId",
      statusClass: "2xx",
      durationSeconds: 0.25,
    }]);
  });

  it("records errors and unmatched routes with safe labels", async () => {
    const recorded: HttpRequestMetric[] = [];
    const app = express();
    app.use(createHttpMetricsMiddleware({
      metrics: { recordHttpRequest: (metric) => recorded.push(metric) },
    }));
    app.get("/events/:eventId", (_req, res) => res.status(500).json({ error: "failed" }));

    await withServer(app, async (baseUrl) => {
      await fetch(`${baseUrl}/events/event_123?payload=secret`);
      await fetch(`${baseUrl}/not-found/secret-id`);
    });

    assert.equal(recorded[0].method, "GET");
    assert.equal(recorded[0].route, "/events/:eventId");
    assert.equal(recorded[0].statusClass, "5xx");
    assert.equal(recorded[0].durationSeconds >= 0, true);
    assert.equal(recorded[1].route, "unmatched");
    assert.equal(recorded[1].statusClass, "4xx");
  });

  it("normalizes methods to a bounded set", () => {
    assert.equal(normalizeHttpMethod("get"), "GET");
    assert.equal(normalizeHttpMethod("POST"), "POST");
    assert.equal(normalizeHttpMethod("PROPFIND"), "OTHER");
    assert.equal(normalizeHttpMethod(""), "OTHER");
  });

  it("normalizes status codes into bounded classes", () => {
    assert.equal(normalizeHttpStatus(200), "2xx");
    assert.equal(normalizeHttpStatus(302), "3xx");
    assert.equal(normalizeHttpStatus(404), "4xx");
    assert.equal(normalizeHttpStatus(503), "5xx");
    assert.equal(normalizeHttpStatus(101), "other");
  });

  it("uses OTHER for an unknown HTTP method", async () => {
    const recorded: HttpRequestMetric[] = [];
    const app = express();
    app.use(createHttpMetricsMiddleware({
      metrics: { recordHttpRequest: (metric) => recorded.push(metric) },
    }));
    app.all("/unknown-method", (_req, res) => res.status(200).end());

    await withServer(app, async (baseUrl) => {
      const address = new URL(baseUrl);
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({
          hostname: address.hostname,
          port: address.port,
          path: "/unknown-method?secret=value",
          method: "PROPFIND",
        }, (res) => {
          res.resume();
          res.once("end", () => resolve());
        });
        req.once("error", reject);
        req.end();
      });
    });

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].method, "OTHER");
    assert.equal(recorded[0].route, "/unknown-method");
  });

  it("does not expose query strings, parameter values, or unmatched URLs", () => {
    const req = {
      route: { path: "/deliveries/:deliveryId" },
      baseUrl: "/api/v1",
      originalUrl: "/api/v1/deliveries/secret-id?apiKey=secret",
    } as Request;

    assert.equal(getRouteTemplate(req), "/api/v1/deliveries/:deliveryId");
  });

  it("records duration from a monotonic nanosecond clock", async () => {
    const recorded: HttpRequestMetric[] = [];
    let call = 0;
    const app = express();
    app.use(createHttpMetricsMiddleware({
      metrics: { recordHttpRequest: (metric) => recorded.push(metric) },
      now: () => BigInt(call++ === 0 ? 0 : 750_000_000),
    }));
    app.get("/duration", (_req, res) => res.status(200).end());

    await withServer(app, async (baseUrl) => {
      await fetch(`${baseUrl}/duration`);
    });

    assert.equal(recorded[0].durationSeconds, 0.75);
  });

  it("records aborted and duplicate completion events only once", () => {
    const recorded: HttpRequestMetric[] = [];
    const req = { method: "GET", route: { path: "/abort" }, baseUrl: "" } as unknown as Request;

    const handler = createHttpMetricsMiddleware({
      metrics: { recordHttpRequest: (metric) => recorded.push(metric) },
      now: (() => {
        let call = 0;
        return () => BigInt(call++ === 0 ? 10_000_000 : 35_000_000);
      })(),
    });
    const duplicateRes = Object.assign(new EventEmitter(), { statusCode: 499 }) as unknown as Response;
    handler(req, duplicateRes, () => undefined);
    duplicateRes.emit("finish");
    duplicateRes.emit("close");
    duplicateRes.emit("error");

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].durationSeconds, 0.025);
    assert.equal(recorded[0].statusClass, "4xx");
  });

  it("derives safe route templates for nested routers and mounted paths", () => {
    const req = {
      route: { path: "/deliveries/:deliveryId" },
      baseUrl: "/api/v1",
      originalUrl: "/api/v1/deliveries/abc?secret=1",
    } as Request;

    assert.equal(getRouteTemplate(req), "/api/v1/deliveries/:deliveryId");
    assert.equal(getRouteTemplate({ route: { path: "/" }, baseUrl: "/v1" } as Request), "/v1");
  });

  it("returns unmatched when no safe route template is available", () => {
    assert.equal(getRouteTemplate({ route: undefined, baseUrl: "" } as Request), "unmatched");
    assert.equal(getRouteTemplate({ route: { path: "bad?value=1" }, baseUrl: "" } as Request), "unmatched");
    assert.equal(getRouteTemplate({ route: { path: "<script>" }, baseUrl: "" } as Request), "unmatched");
    assert.equal(getRouteTemplate({ route: { path: "bad?value=1" }, baseUrl: "/api" } as Request), "/api");
  });

  it("returns zero for invalid clock values and negative durations", () => {
    assert.equal(safeDurationSeconds("NaN", "1"), 0);
    assert.equal(safeDurationSeconds(5n, 1n), 0);
    assert.equal(safeDurationSeconds("123", "456"), 0.000000333);
  });
});
