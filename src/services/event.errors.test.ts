import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import { isDuplicateIdempotencyKeyError } from "./event.errors";

describe("isDuplicateIdempotencyKeyError", () => {
  it("recognizes P2002 errors for the idempotency key", () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["idempotencyKey"] },
      },
    );

    assert.equal(isDuplicateIdempotencyKeyError(error), true);
  });

  it("does not classify other unique constraints or errors as duplicates", () => {
    const otherConstraint = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["eventId", "endpointId"] },
      },
    );

    assert.equal(isDuplicateIdempotencyKeyError(otherConstraint), false);
    assert.equal(
      isDuplicateIdempotencyKeyError(new Error("Redis unavailable")),
      false,
    );
  });
});
