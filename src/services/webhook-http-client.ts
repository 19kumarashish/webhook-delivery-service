import { isIP } from "node:net";
import net from "node:net";
import tls from "node:tls";
import { request, Agent, type Dispatcher } from "undici";
import {
  defaultLookup,
  isLocalHostname,
  isPublicIp,
  isPublicIpv4,
  isPublicIpv6,
  type LookupHost,
  type ResolvedAddress,
} from "./webhook-url";

export class HttpDeliveryError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    super(`Destination returned HTTP ${statusCode}`);
    this.name = "HttpDeliveryError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class SsrfSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfSecurityError";
  }
}

export interface SafeConnectorOptions {
  lookupHost?: LookupHost;
  tlsOptions?: tls.ConnectionOptions;
}

export type UndiciConnectOptions = {
  hostname: string;
  host: string;
  protocol: string;
  port: string | number;
  servername?: string | null;
  localAddress?: string | null;
};

export type UndiciConnectCallback = (
  err: Error | null,
  socket?: net.Socket | tls.TLSSocket,
) => void;

/**
 * Builds an Undici-compatible connector that validates the destination host/IP
 * immediately before socket connection and pins the TCP/TLS connection directly
 * to the explicitly validated IP address, preventing DNS rebinding.
 */
export function buildSafeConnector(options?: SafeConnectorOptions) {
  const lookupHost = options?.lookupHost ?? defaultLookup;

  return function safeConnect(
    opts: UndiciConnectOptions,
    callback: UndiciConnectCallback,
  ): void {
    void (async () => {
      try {
        if (opts.protocol !== "http:" && opts.protocol !== "https:") {
          callback(new SsrfSecurityError(`Unsupported protocol: ${opts.protocol}`));
          return;
        }

        const rawHostname = opts.hostname.toLowerCase().replace(/^\[|\]$/g, "");

        if (!rawHostname || isLocalHostname(rawHostname)) {
          callback(
            new SsrfSecurityError(
              `Destination host is local or invalid: ${rawHostname}`,
            ),
          );
          return;
        }

        let targetIp: string;
        let isLiteralIp = false;
        const ipFamily = isIP(rawHostname);

        if (ipFamily !== 0) {
          isLiteralIp = true;
          if (!isPublicIp(rawHostname)) {
            callback(
              new SsrfSecurityError(
                `Destination IP address is prohibited: ${rawHostname}`,
              ),
            );
            return;
          }
          targetIp = rawHostname;
        } else {
          let addresses: ResolvedAddress[];
          try {
            addresses = await lookupHost(rawHostname);
          } catch (lookupErr) {
            callback(
              new SsrfSecurityError(
                `DNS resolution failed for ${rawHostname}: ${
                  lookupErr instanceof Error ? lookupErr.message : String(lookupErr)
                }`,
              ),
            );
            return;
          }

          if (!addresses || addresses.length === 0) {
            callback(
              new SsrfSecurityError(
                `DNS returned no addresses for host: ${rawHostname}`,
              ),
            );
            return;
          }

          // Validate EVERY resolved address and reject mixed public/private answers.
          for (const item of addresses) {
            const allowed =
              item.family === 4
                ? isPublicIpv4(item.address)
                : item.family === 6
                  ? isPublicIpv6(item.address)
                  : false;

            if (!allowed) {
              callback(
                new SsrfSecurityError(
                  `Blocked prohibited address ${item.address} returned by DNS for ${rawHostname}`,
                ),
              );
              return;
            }
          }

          // Connect strictly to a validated IP address.
          targetIp = addresses[0].address;
        }

        const port = opts.port
          ? Number(opts.port)
          : opts.protocol === "https:"
            ? 443
            : 80;

        let socket: net.Socket | tls.TLSSocket;

        if (opts.protocol === "https:") {
          // Preserve the original hostname for SNI and TLS certificate verification.
          // RFC 6066 states literal IPs should not be passed in servername.
          const servername = isLiteralIp
            ? undefined
            : (opts.servername || rawHostname);

          socket = tls.connect({
            host: targetIp,
            port,
            servername,
            rejectUnauthorized: true, // Strict certificate validation is always enforced.
            ...(options?.tlsOptions ?? {}),
          });

          socket.setNoDelay(true);
          socket.once("secureConnect", function (this: tls.TLSSocket) {
            callback(null, this);
          });
          socket.once("error", function (err: Error) {
            callback(err);
          });
        } else {
          socket = net.connect({
            host: targetIp,
            port,
          });

          socket.setNoDelay(true);
          socket.once("connect", function (this: net.Socket) {
            callback(null, this);
          });
          socket.once("error", function (err: Error) {
            callback(err);
          });
        }
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    })();
  };
}

/**
 * Creates an Undici Agent with safe connector and connection-pooling protection.
 */
export function createSafeAgent(options?: SafeConnectorOptions): Agent {
  return new Agent({
    connect: buildSafeConnector(options) as any,
    pipelining: 0,
  });
}

/**
 * Reads up to maxChars characters from response body and destroys the stream
 * to avoid memory exhaustion from oversized or infinite streaming responses.
 */
export async function readLimitedResponseBody(
  body: Dispatcher.ResponseData["body"],
  maxChars = 10_000,
): Promise<string> {
  let text = "";

  try {
    for await (const chunk of body) {
      text += (chunk as Buffer).toString("utf8");
      if (text.length >= maxChars) {
        text = text.slice(0, maxChars);
        body.destroy();
        break;
      }
    }
  } catch {
    // Gracefully handle body destroy or stream abort.
  }

  return text;
}

export interface SendWebhookRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  lookupHost?: LookupHost;
  dispatcher?: Dispatcher;
  tlsOptions?: tls.ConnectionOptions;
}

export interface WebhookDeliveryResponse {
  statusCode: number;
  body: string;
}

/**
 * Executes a secure outbound webhook request with:
 * - Pre-connection URL and protocol validation.
 * - IP pinning and DNS rebinding protection via custom connector.
 * - Explicitly disabled redirects (3xx is treated as a delivery failure).
 * - Overall timeout enforcement (default 10 seconds).
 * - Truncation of response body to 10,000 characters.
 * - No connection reuse across deliveries that could bypass DNS validation.
 */
export async function sendWebhookRequest(
  destinationUrl: string,
  options: SendWebhookRequestOptions = {},
): Promise<WebhookDeliveryResponse> {
  let url: URL;
  try {
    url = new URL(destinationUrl);
  } catch {
    throw new SsrfSecurityError(`Invalid webhook destination URL: ${destinationUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfSecurityError(`Unsupported protocol: ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new SsrfSecurityError("Webhook URL must not contain credentials");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || isLocalHostname(hostname)) {
    throw new SsrfSecurityError(`Blocked destination hostname: ${hostname}`);
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const shouldCloseDispatcher = !options.dispatcher;
  const dispatcher =
    options.dispatcher ??
    createSafeAgent({
      lookupHost: options.lookupHost,
      tlsOptions: options.tlsOptions,
    });

  try {
    const response = await request(url.toString(), {
      method: options.method ?? "POST",
      headers: {
        ...(options.headers ?? {}),
        // Enforce connection close to ensure each request forces fresh DNS validation
        connection: "close",
      },
      body: options.body,
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher,
    });

    const statusCode = response.statusCode;
    const body = await readLimitedResponseBody(response.body, 10_000);

    if (statusCode < 200 || statusCode >= 300) {
      throw new HttpDeliveryError(statusCode, body);
    }

    return {
      statusCode,
      body,
    };
  } finally {
    if (shouldCloseDispatcher) {
      try {
        await dispatcher.close();
      } catch {
        // Ignore dispatcher close errors on shutdown
      }
    }
  }
}
