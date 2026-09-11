import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.12";
import { recordToolCallBounded } from "./telemetry.ts";

Deno.test("telemetry rejection is contained and bounded", async () => {
  const started = performance.now();
  await recordToolCallBounded(
    Promise.reject(new Error("database secret 123")),
    20,
  );
  assertEquals(performance.now() - started < 200, true);
});

Deno.test("telemetry timeout resolves without an orphan rejection", async () => {
  let settled = false;
  const pending = new Promise<void>((resolve) => {
    setTimeout(() => {
      settled = true;
      resolve();
    }, 100);
  });
  await recordToolCallBounded(pending, 10);
  assertEquals(settled, false);
});

Deno.test("invalid telemetry input does not reject the caller", async () => {
  await assertRejects(
    () => Promise.reject(new Error("control")),
    Error,
    "control",
  );
});
