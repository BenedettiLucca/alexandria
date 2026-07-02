import { assertEquals } from "@std/assert";
import {
  extractClaims,
  detectClaimConflicts,
  formatConflicts,
  ClaimConflict,
  BriefClaim,
} from "./conflict_radar.ts";

Deno.test("Claim extraction — basic", () => {
  const body = "ETH YTD: +39%\nBTC market cap: $1.2T";
  const entityRefs = ["ETH", "BTC"];
  const claims = extractClaims(body, entityRefs);

  assertEquals(claims.length >= 2, true);

  const ethClaim = claims.find((c) => c.entity === "ETH");
  assertEquals(ethClaim !== undefined, true);
  assertEquals(ethClaim!.value_numeric, 39);
  assertEquals(ethClaim!.unit, "%");

  const btcClaim = claims.find((c) => c.entity === "BTC");
  assertEquals(btcClaim !== undefined, true);
  assertEquals(btcClaim!.value_numeric, 1.2);
  assertEquals(btcClaim!.unit, "T");
});

Deno.test("Claim extraction — filters noise keywords", () => {
  const body = "The price is 100 and the total is 200";
  const claims = extractClaims(body, []);
  assertEquals(claims.length, 0);
});

Deno.test("Conflict detection — contradictory values", () => {
  const claims = [
    {
      brief_id: "brief-a",
      brief_title: "Brief A",
      brief_date: "2026-07-01",
      source_job: "job-1",
      claim: {
        entity: "ETH",
        metric: "ytd",
        value_numeric: 39,
        value_text: "39",
        unit: "%",
        time_scope: "",
        source_snippet: "ETH YTD: +39%",
      },
    },
    {
      brief_id: "brief-b",
      brief_title: "Brief B",
      brief_date: "2026-07-02",
      source_job: "job-2",
      claim: {
        entity: "ETH",
        metric: "ytd",
        value_numeric: -12,
        value_text: "-12",
        unit: "%",
        time_scope: "",
        source_snippet: "ETH YTD: -12%",
      },
    },
  ];

  const conflicts = detectClaimConflicts(claims);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].severity, "high");
  assertEquals(conflicts[0].description.includes("ETH"), true);
  assertEquals(conflicts[0].description.includes("ytd"), true);
});

Deno.test("Conflict detection — no conflict when values agree", () => {
  const claims = [
    {
      brief_id: "brief-a",
      brief_title: "Brief A",
      brief_date: "2026-07-01",
      source_job: "job-1",
      claim: {
        entity: "BTC",
        metric: "price",
        value_numeric: 100000,
        value_text: "100000",
        unit: "",
        time_scope: "",
        source_snippet: "BTC price: 100000",
      },
    },
    {
      brief_id: "brief-b",
      brief_title: "Brief B",
      brief_date: "2026-07-02",
      source_job: "job-2",
      claim: {
        entity: "BTC",
        metric: "price",
        value_numeric: 100000.005,
        value_text: "100000.005",
        unit: "",
        time_scope: "",
        source_snippet: "BTC price: 100000.005",
      },
    },
  ];

  const conflicts = detectClaimConflicts(claims);
  assertEquals(conflicts.length, 0);
});

Deno.test("Conflict detection — different entities don't conflict", () => {
  const claims = [
    {
      brief_id: "brief-a",
      brief_title: "Brief A",
      brief_date: "2026-07-01",
      source_job: "job-1",
      claim: {
        entity: "ETH",
        metric: "price",
        value_numeric: 3000,
        value_text: "3000",
        unit: "",
        time_scope: "",
        source_snippet: "ETH price: 3000",
      },
    },
    {
      brief_id: "brief-b",
      brief_title: "Brief B",
      brief_date: "2026-07-02",
      source_job: "job-2",
      claim: {
        entity: "BTC",
        metric: "price",
        value_numeric: 100000,
        value_text: "100000",
        unit: "",
        time_scope: "",
        source_snippet: "BTC price: 100000",
      },
    },
  ];

  const conflicts = detectClaimConflicts(claims);
  assertEquals(conflicts.length, 0);
});

Deno.test("Format test", () => {
  const conflict: ClaimConflict = {
    entity: "ETH",
    metric: "ytd",
    claims: [
      {
        brief_id: "brief-a",
        brief_title: "Brief A",
        brief_date: "2026-07-01",
        source_job: "job-1",
        value_numeric: 39,
        value_text: "39",
        unit: "%",
        source_snippet: "ETH YTD: +39%",
      },
    ],
    max_delta_pct: 425,
    severity: "high",
    description: "ETH ytd: 2 conflicting values (39% vs -12%, 425% delta)",
  };

  const output = formatConflicts([conflict]);
  assertEquals(output.includes("ETH"), true);
  assertEquals(output.includes("HIGH"), true);
  assertEquals(output.includes("ETH YTD: +39%"), true);
});

Deno.test("Format test — no conflicts", () => {
  const output = formatConflicts([]);
  assertEquals(output, "No conflicting claims detected.");
});
