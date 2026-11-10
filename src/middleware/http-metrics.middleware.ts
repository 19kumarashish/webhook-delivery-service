import type { Request, RequestHandler } from "express";
import type { HttpStatusClass } from "../metrics/metrics.service";
import type { MetricsService } from "../metrics/metrics.service";

const SAFE_ROUTE_TEMPLATE_PATTERN = /^[A-Za-z0-9/_.:-]+$/;

export interface HttpMetricsMiddlewareOptions {
  metrics: Pick<MetricsService, "recordHttpRequest">;
  now?: () => bigint;
}

const BOUND_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);

function sanitizeRouteTemplate(value: string): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/\\/g, "/");
  if (
    normalized.includes("?") ||
    normalized.includes("#") ||
    !SAFE_ROUTE_TEMPLATE_PATTERN.test(normalized)
  ) {
    return "";
  }

  return normalized;
}

export function normalizeHttpMethod(method: string): string {
  const normalized = method.trim().toUpperCase();
  return BOUND_METHODS.has(normalized) ? normalized : "OTHER";
}

export function normalizeHttpStatus(statusCode: number): HttpStatusClass {
  if (statusCode >= 200 && statusCode < 300) {
    return "2xx";
  }
  if (statusCode >= 300 && statusCode < 400) {
    return "3xx";
  }
  if (statusCode >= 400 && statusCode < 500) {
    return "4xx";
  }
  if (statusCode >= 500 && statusCode < 600) {
    return "5xx";
  }
  return "other";
}

export function safeDurationSeconds(startNs: unknown, endNs: unknown): number {
  const toBigInt = (value: unknown): bigint | undefined => {
    if (typeof value === "bigint") {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return BigInt(Math.trunc(parsed));
      }
    }

    return undefined;
  };

  const startBigInt = toBigInt(startNs);
  const endBigInt = toBigInt(endNs);
  if (startBigInt === undefined || endBigInt === undefined) {
    return 0;
  }

  const elapsedNs = endBigInt - startBigInt;
  if (elapsedNs < 0n) {
    return 0;
  }

  const durationSeconds = Number(elapsedNs) / 1_000_000_000;
  if (!Number.isFinite(durationSeconds)) {
    return 0;
  }

  return durationSeconds;
}

export function getRouteTemplate(req: Request): string {
  const routePath = req.route?.path;
  const baseUrl = typeof req.baseUrl === "string" ? req.baseUrl : "";

  const safeBaseUrl = sanitizeRouteTemplate(baseUrl);
  const safeRoutePath = sanitizeRouteTemplate(
    typeof routePath === "string" ? routePath : "",
  );

  if (!safeBaseUrl && !safeRoutePath) {
    return "unmatched";
  }

  let routeTemplate = "";
  if (safeBaseUrl && safeRoutePath) {
    routeTemplate = `${safeBaseUrl}${safeRoutePath === "/" ? "" : safeRoutePath}`;
  } else if (safeBaseUrl) {
    routeTemplate = safeBaseUrl;
  } else if (safeRoutePath) {
    routeTemplate = safeRoutePath;
  }

  const normalized = sanitizeRouteTemplate(routeTemplate || "/");
  return normalized || "unmatched";
}

export function createHttpMetricsMiddleware(
  options: HttpMetricsMiddlewareOptions,
): RequestHandler {
  const now = options.now ?? (() => process.hrtime.bigint());

  return (req, res, next) => {
    const startTime = now();
    let completed = false;

    const complete = () => {
      if (completed) {
        return;
      }
      completed = true;

      const durationSeconds = safeDurationSeconds(startTime, now());

      options.metrics.recordHttpRequest({
        method: normalizeHttpMethod(req.method),
        route: getRouteTemplate(req),
        statusClass: normalizeHttpStatus(res.statusCode),
        durationSeconds,
      });
    };

    res.once("finish", complete);
    res.once("close", complete);
    res.once("error", complete);

    next();
  };
}
