import pino, { type DestinationStream, type Logger } from "pino";

const SERVICE_NAME = "webhook-delivery-service";
const DEFAULT_LOG_LEVEL = "info";

export const PinoLogLevel = {
  trace: true,
  debug: true,
  info: true,
  warn: true,
  error: true,
  fatal: true,
  silent: true,
} as const;

export type PinoLogLevel = keyof typeof PinoLogLevel;

export interface SerializedError {
  type: string;
  name: string;
  message?: string;
  code?: string | number;
}

export interface CreateLoggerOptions {
  level?: string;
  environment?: string;
  destination?: DestinationStream;
}

const SENSITIVE_REDACTION_PATHS = [
  "authorization",
  "Authorization",
  "AUTHORIZATION",
  "*.authorization",
  "*.Authorization",
  "*.AUTHORIZATION",
  "req.headers.authorization",
  "req.headers.Authorization",
  "req.headers.AUTHORIZATION",
  "request.headers.authorization",
  "request.headers.Authorization",
  "request.headers.AUTHORIZATION",
  "cookie",
  "Cookie",
  "*.cookie",
  "*.Cookie",
  "req.headers.cookie",
  "req.headers.Cookie",
  "request.headers.cookie",
  "request.headers.Cookie",
  "set-cookie",
  "Set-Cookie",
  "SET-COOKIE",
  "*.set-cookie",
  "*.Set-Cookie",
  "*.SET-COOKIE",
  "secret",
  "*.secret",
  "*.Secret",
  "*.SECRET",
  "signature",
  "*.signature",
  "*.Signature",
  "*.SIGNATURE",
  "headers.X-Webhook-Signature",
  "headers.x-webhook-signature",
  "headers.X-WEBHOOK-SIGNATURE",
  "*.X-Webhook-Signature",
  "*.x-webhook-signature",
  "*.X-WEBHOOK-SIGNATURE",
  "payload",
  "*.payload",
  "*.Payload",
  "*.PAYLOAD",
  "responseBody",
  "*.responseBody",
  "*.ResponseBody",
  "*.RESPONSEBODY",
  "requestBody",
  "*.requestBody",
  "*.RequestBody",
  "*.REQUESTBODY",
  "req.body",
  "request.body",
  "body",
  "*.body",
  "*.Body",
  "*.BODY",
  "apiKey",
  "api-key",
  "*.apiKey",
  "*.api-key",
  "*.ApiKey",
  "*.APIKEY",
  "*.*.apiKey",
  "*.*.api-key",
  "*.*.ApiKey",
  "*.items.*.apiKey",
  "*.items.*.api-key",
  "accessToken",
  "*.accessToken",
  "*.AccessToken",
  "*.ACCESSTOKEN",
  "*.*.accessToken",
  "*.*.*.accessToken",
  "*.items.*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "*.RefreshToken",
  "*.REFRESHTOKEN",
  "*.*.refreshToken",
  "password",
  "*.password",
  "*.Password",
  "*.PASSWORD",
  "*.*.password",
  "*.*.*.password",
  "*.items.*.password",
  "headers",
  "*.headers",
  "req.headers",
  "request.headers",
] as const;

export function resolveLogLevel(value: string | undefined): PinoLogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized && normalized in PinoLogLevel) {
    return normalized as PinoLogLevel;
  }
  return DEFAULT_LOG_LEVEL as PinoLogLevel;
}

function safeErrorName(value: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    return value;
  }
  return undefined;
}

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return {
      type: typeof error,
      name: "UnknownError",
    };
  }

  const constructorName = safeErrorName(error.constructor.name) ?? "Error";
  const serialized: SerializedError = {
    type: constructorName,
    name:
      safeErrorName(error.name) ??
      constructorName,
  };

  const errorWithCode = error as Error & { code?: unknown };
  if (
    typeof errorWithCode.code === "string" ||
    typeof errorWithCode.code === "number"
  ) {
    if (
      typeof errorWithCode.code === "string" &&
      errorWithCode.code.length <= 128 &&
      /^[A-Za-z0-9_.:-]+$/.test(errorWithCode.code)
    ) {
      serialized.code = errorWithCode.code;
    } else if (
      typeof errorWithCode.code === "number" &&
      Number.isFinite(errorWithCode.code)
    ) {
      serialized.code = errorWithCode.code;
    }
  }

  return serialized;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const environment =
    options.environment ?? process.env.NODE_ENV?.trim() ?? "development";

  const loggerOptions = {
    name: SERVICE_NAME,
    level: resolveLogLevel(options.level ?? process.env.LOG_LEVEL),
    base: {
      service: SERVICE_NAME,
      environment,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: serializeError,
      error: serializeError,
    },
    redact: {
      paths: [...SENSITIVE_REDACTION_PATHS],
      censor: "[REDACTED]",
    },
  };

  return options.destination
    ? pino(loggerOptions, options.destination)
    : pino(loggerOptions);
}

export const logger = createLogger();
