import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { logger as baseLogger } from "../config/logger";
import { runWithLogContext } from "../logging/context";

const REQUEST_ID_HEADER = "X-Request-ID";
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_SAFE_PATH_LENGTH = 2048;

export interface RequestContextMiddlewareOptions {
  logger?: Pick<Logger, "info">;
  generateRequestId?: () => string;
  now?: () => bigint;
}

function isValidRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID_PATTERN.test(value)
  );
}

function getSafePath(originalUrl: string): string {
  const queryIndex = originalUrl.indexOf("?");
  const pathOnly = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
  const printablePath = pathOnly.replace(/[\u0000-\u0020\u007f]/g, "");
  const truncatedPath = printablePath.slice(0, MAX_SAFE_PATH_LENGTH);
  return truncatedPath || "/";
}

export function createRequestContextMiddleware(
  options: RequestContextMiddlewareOptions = {},
): RequestHandler {
  const completionLogger = options.logger ?? baseLogger;
  const generateRequestId = options.generateRequestId ?? randomUUID;
  const now = options.now ?? (() => process.hrtime.bigint());

  return (req, res, next) => {
    const headerValue = req.headers["x-request-id"];
    const requestId = isValidRequestId(headerValue)
      ? headerValue
      : generateRequestId();
    const startTime = now();
    let completed = false;

    res.setHeader(REQUEST_ID_HEADER, requestId);

    const complete = () => {
      if (completed) {
        return;
      }
      completed = true;

      const elapsedNs = now() - startTime;
      const durationMs = Math.max(0, Number(elapsedNs) / 1_000_000);

      completionLogger.info({
        requestId,
        method: req.method,
        route: getSafePath(req.originalUrl),
        statusCode: res.statusCode,
        durationMs,
      }, "http_request_completed");
    };

    res.once("finish", complete);
    res.once("close", complete);
    res.once("error", complete);

    runWithLogContext({ requestId, correlationId: requestId }, () => {
      next();
    });
  };
}

export const requestContextMiddleware = createRequestContextMiddleware();
