import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  requestId?: string;
  correlationId?: string;
  eventId?: string;
  deliveryId?: string;
  endpointId?: string;
  replayRequestId?: string;
}

const logContextStorage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(
  context: LogContext,
  callback: () => T,
): T {
  return logContextStorage.run({ ...context }, callback);
}

export function getLogContext(): LogContext | undefined {
  const context = logContextStorage.getStore();
  return context ? { ...context } : undefined;
}

export function updateLogContext(fields: Partial<LogContext>): void {
  const currentContext = logContextStorage.getStore();
  if (!currentContext) {
    return;
  }

  const updatedContext: LogContext = {
    ...currentContext,
    ...fields,
  };
  // Enter with a new object so this call does not mutate either the stored
  // context or context objects inherited by sibling asynchronous branches.
  logContextStorage.enterWith(updatedContext);
}

export function getCorrelationId(): string | undefined {
  return logContextStorage.getStore()?.correlationId;
}
