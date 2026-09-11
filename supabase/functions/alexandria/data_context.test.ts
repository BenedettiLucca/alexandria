import { assertEquals, assertRejects } from "@std/assert";
import { getDataClient, getDataContext } from "./data_context.ts";
import { runWithContext } from "./context.ts";

const jwtAuth = (userId: string) => ({
  auth: { method: "jwt" as const, userId, token: `token-${userId}` },
  callerClient: "test",
});

Deno.test("data context fails closed without request context", async () => {
  await assertRejects(
    () => Promise.resolve().then(() => getDataContext()),
    Error,
    "Request context is required",
  );
  await assertRejects(
    () => Promise.resolve().then(() => getDataClient()),
    Error,
    "Request context is required",
  );
});

Deno.test("concurrent request contexts keep distinct identities", async () => {
  const seen = await Promise.all([
    runWithContext(jwtAuth("owner-a"), async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return getDataContext().userId;
    }),
    runWithContext(jwtAuth("owner-b"), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getDataContext().userId;
    }),
  ]);

  assertEquals(seen, ["owner-a", "owner-b"]);
});

Deno.test("data client uses the request JWT", () => {
  const client = runWithContext(jwtAuth("owner-a"), () => getDataClient());
  assertEquals(typeof client.from, "function");
});
