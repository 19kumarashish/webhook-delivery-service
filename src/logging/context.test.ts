import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getCorrelationId,
  getLogContext,
  runWithLogContext,
  updateLogContext,
} from "./context";

describe("asynchronous logging context", () => {
  it("returns the context inside runWithLogContext", () => {
    const result = runWithLogContext(
      { requestId: "req_123", correlationId: "corr_123" },
      () => getLogContext(),
    );

    assert.deepEqual(result, {
      requestId: "req_123",
      correlationId: "corr_123",
    });
  });

  it("returns undefined outside an active context", () => {
    assert.equal(getLogContext(), undefined);
    assert.equal(getCorrelationId(), undefined);
  });

  it("retrieves the correlation ID", () => {
    runWithLogContext(
      { requestId: "req_123", correlationId: "corr_123" },
      () => {
        assert.equal(getCorrelationId(), "corr_123");
      },
    );
  });

  it("preserves existing fields when updating context", () => {
    runWithLogContext(
      { requestId: "req_123", eventId: "evt_123" },
      () => {
        updateLogContext({ deliveryId: "del_123" });
        assert.deepEqual(getLogContext(), {
          requestId: "req_123",
          eventId: "evt_123",
          deliveryId: "del_123",
        });
      },
    );
  });

  it("explicitly overwrites existing values", () => {
    runWithLogContext(
      { requestId: "req_old", correlationId: "corr_old" },
      () => {
        updateLogContext({
          requestId: "req_new",
          correlationId: "corr_new",
        });

        assert.deepEqual(getLogContext(), {
          requestId: "req_new",
          correlationId: "corr_new",
        });
      },
    );
  });

  it("isolates concurrent asynchronous contexts", async () => {
    const runOperation = async (id: string) =>
      runWithLogContext(
        { requestId: `req_${id}`, correlationId: `corr_${id}` },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, id === "a" ? 10 : 1));
          return getLogContext();
        },
      );

    const [first, second] = await Promise.all([
      runOperation("a"),
      runOperation("b"),
    ]);

    assert.deepEqual(first, {
      requestId: "req_a",
      correlationId: "corr_a",
    });
    assert.deepEqual(second, {
      requestId: "req_b",
      correlationId: "corr_b",
    });
  });

  it("retains context through nested asynchronous operations", async () => {
    await runWithLogContext(
      {
        requestId: "req_nested",
        correlationId: "corr_nested",
        eventId: "evt_nested",
      },
      async () => {
        updateLogContext({ deliveryId: "del_nested" });

        await new Promise((resolve) => setTimeout(resolve, 1));
        assert.deepEqual(getLogContext(), {
          requestId: "req_nested",
          correlationId: "corr_nested",
          eventId: "evt_nested",
          deliveryId: "del_nested",
        });
      },
    );
  });

  it("isolates sibling operations under the same initial context", async () => {
    await runWithLogContext(
      {
        requestId: "req_parent",
        correlationId: "corr_parent",
        eventId: "evt_parent",
      },
      async () => {
        const siblingA = Promise.resolve().then(async () => {
          await Promise.resolve();
          updateLogContext({
            deliveryId: "del_a",
            correlationId: "corr_a",
          });
          await new Promise((resolve) => setTimeout(resolve, 5));
          return getLogContext();
        });

        const siblingB = Promise.resolve().then(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return getLogContext();
        });

        const [contextA, contextB] = await Promise.all([siblingA, siblingB]);

        assert.deepEqual(contextA, {
          requestId: "req_parent",
          correlationId: "corr_a",
          eventId: "evt_parent",
          deliveryId: "del_a",
        });
        assert.deepEqual(contextB, {
          requestId: "req_parent",
          correlationId: "corr_parent",
          eventId: "evt_parent",
        });
      },
    );
  });

  it("keeps nested asynchronous context updates local to their branch", async () => {
    await runWithLogContext(
      { requestId: "req_root", correlationId: "corr_root" },
      async () => {
        await runWithLogContext(
          {
            requestId: "req_nested_root",
            eventId: "evt_nested_root",
          },
          async () => {
            updateLogContext({ deliveryId: "del_nested", endpointId: "ep_nested" });
            await Promise.resolve();
            assert.deepEqual(getLogContext(), {
              requestId: "req_nested_root",
              eventId: "evt_nested_root",
              deliveryId: "del_nested",
              endpointId: "ep_nested",
            });
          },
        );

        await Promise.resolve();
        assert.deepEqual(getLogContext(), {
          requestId: "req_root",
          correlationId: "corr_root",
        });
      },
    );
  });

  it("keeps independent runWithLogContext calls isolated", async () => {
    const first = runWithLogContext(
      { requestId: "req_first", correlationId: "corr_first" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        updateLogContext({ deliveryId: "del_first" });
        return getLogContext();
      },
    );

    const second = runWithLogContext(
      { requestId: "req_second", correlationId: "corr_second" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getLogContext();
      },
    );

    assert.deepEqual(await first, {
      requestId: "req_first",
      correlationId: "corr_first",
      deliveryId: "del_first",
    });
    assert.deepEqual(await second, {
      requestId: "req_second",
      correlationId: "corr_second",
    });
  });

  it("does not allow getLogContext() results to mutate stored context", () => {
    runWithLogContext(
      { requestId: "req_original", correlationId: "corr_original" },
      () => {
        const returnedContext = getLogContext();
        assert.ok(returnedContext);

        returnedContext.requestId = "req_mutated";
        returnedContext.deliveryId = "del_mutated";

        assert.deepEqual(getLogContext(), {
          requestId: "req_original",
          correlationId: "corr_original",
        });
      },
    );
  });

  it("does not allow the runWithLogContext input object to mutate stored context", () => {
    const input = {
      requestId: "req_original",
      correlationId: "corr_original",
      eventId: "evt_original",
    };

    runWithLogContext(input, () => {
      input.requestId = "req_mutated";
      input.correlationId = "corr_mutated";
      input.eventId = "evt_mutated";

      assert.deepEqual(getLogContext(), {
        requestId: "req_original",
        correlationId: "corr_original",
        eventId: "evt_original",
      });
    });
  });

  it("does not crash when updating outside an active context", () => {
    assert.doesNotThrow(() => {
      updateLogContext({
        requestId: "req_outside",
        correlationId: "corr_outside",
      });
    });
    assert.equal(getLogContext(), undefined);
  });

  it("preserves synchronous callback return values", () => {
    const value = runWithLogContext(
      { requestId: "req_sync" },
      () => 42,
    );
    assert.equal(value, 42);
  });

  it("preserves asynchronous callback return values and rejected promises", async () => {
    const value = await runWithLogContext(
      { requestId: "req_async" },
      async () => {
        await Promise.resolve();
        return "completed";
      },
    );
    assert.equal(value, "completed");

    await assert.rejects(
      runWithLogContext(
        { requestId: "req_rejected" },
        async () => {
          await Promise.resolve();
          throw new Error("expected failure");
        },
      ),
      /expected failure/,
    );
  });
});
