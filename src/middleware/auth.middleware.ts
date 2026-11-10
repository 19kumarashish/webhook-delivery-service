import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface AuthMiddlewareOptions {
  apiKey?: string;
}

export function createApiKeyAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expectedKey =
      options.apiKey ?? (process.env.API_KEY || "dev_secret_key_123");
    const headerValue = req.headers["x-api-key"];
    const providedKey =
      typeof headerValue === "string"
        ? headerValue
        : Array.isArray(headerValue)
          ? headerValue[0]
          : undefined;

    if (!providedKey) {
      res.status(401).json({
        status: "error",
        message: "Unauthorized: Invalid or missing API Key",
      });
      return;
    }

    const expectedBuffer = Buffer.from(expectedKey, "utf8");
    const providedBuffer = Buffer.from(providedKey, "utf8");

    if (expectedBuffer.length !== providedBuffer.length) {
      res.status(401).json({
        status: "error",
        message: "Unauthorized: Invalid or missing API Key",
      });
      return;
    }

    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      res.status(401).json({
        status: "error",
        message: "Unauthorized: Invalid or missing API Key",
      });
      return;
    }

    next();
  };
}

export const authMiddleware = createApiKeyAuthMiddleware();
export default authMiddleware;

