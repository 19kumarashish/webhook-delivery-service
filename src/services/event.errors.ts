import { Prisma } from "@prisma/client";

export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super("An event with this idempotency key already exists");
    this.name = "DuplicateIdempotencyKeyError";
  }
}

export function isDuplicateIdempotencyKeyError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;

  return Array.isArray(target)
    ? target.includes("idempotencyKey")
    : typeof target === "string" && target.includes("idempotencyKey");
}
