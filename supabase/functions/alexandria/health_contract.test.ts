import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CONTRACT_VERSION, normalizeHealthEntry, projectHealthEntries } from "./health_contract.ts";

const FIXTURE_DIR = new URL("../../../tests/fixtures/", import.meta.url);

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(new URL(name, FIXTURE_DIR)));
}

Deno.test("dataset projects to golden (cross-language conformance)", async () => {
  const dataset = await loadFixture("health_contract_dataset.json");
  const golden = await loadFixture("health_contract_golden.json");
  assertEquals(projectHealthEntries(dataset as Record<string, unknown>[]), golden);
});

Deno.test("golden identities stable and versioned", async () => {
  const golden = await loadFixture("health_contract_golden.json") as Record<string, unknown>[];
  assertEquals(
    golden.map((g) => g.identity as string),
    [...golden.map((g) => g.identity as string)].sort(),
  );
  for (const g of golden) {
    assertEquals(g.contract_version, CONTRACT_VERSION);
    assertEquals((g.raw_content as Record<string, unknown>).untrusted, true);
  }
});

Deno.test("alias normalization is idempotent", async () => {
  const dataset = await loadFixture("health_contract_dataset.json") as Record<string, unknown>[];
  const once = normalizeHealthEntry(dataset[2]);
  const twice = normalizeHealthEntry(once as Record<string, unknown>);
  assertEquals(twice.identity, once.identity);
  assertEquals(twice.entry_type, once.entry_type);
  assertEquals(twice.value, once.value);
  assertEquals(twice.contract_version, once.contract_version);
  // raw_content is per-call provenance: the second call wraps the first output.
  assertEquals((twice.raw_content as Record<string, unknown>).value, once);
});

Deno.test("conflicting duplicate identity rejected", async () => {
  const dataset = await loadFixture("health_contract_dataset.json") as Record<string, unknown>[];
  const clash = { ...dataset[0], value: { steps: 999 } };
  await assertRejects(
    () => Promise.resolve().then(() => projectHealthEntries([...dataset, clash])),
    Error,
    "conflicting duplicate identity",
  );
});

Deno.test("invalid entries rejected", () => {
  const bad: Record<string, unknown>[] = [
    { entry_type: "telepathy", timestamp: "2026-09-10T00:00:00Z" },
    { entry_type: "steps", timestamp: "no-offset", value: { count: 1 } },
    { entry_type: "steps", timestamp: "2026-09-10T00:00:00Z", value: { count: -5 } },
    { entry_type: "weight", timestamp: "2026-09-10T00:00:00Z", value: { weight: "x" } },
    { entry_type: "steps", timestamp: "2026-09-10T00:00:00Z", value: { count: 1 }, source: 1 },
  ];
  for (const record of bad) {
    let accepted = false;
    try {
      normalizeHealthEntry(record);
      accepted = true;
    } catch {
      // expected
    }
    if (accepted) throw new Error(`invalid entry accepted: ${JSON.stringify(record)}`);
  }
});
