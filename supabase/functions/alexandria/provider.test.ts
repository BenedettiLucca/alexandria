// deno-lint-ignore no-import-prefix
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.12";
import {
  OpenRouterProvider,
  ProviderAuthError,
  ProviderMalformedResponseError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderTransportError,
} from "./provider.ts";

Deno.test("provider: successful classification returns model status and no error class", async () => {
  const mockFetch: typeof fetch = () => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  category: "idea",
                  importance: 8,
                  tags: ["ai", "mcp"],
                  title: "New AI Architecture",
                  people: ["Alice"],
                  dates_mentioned: ["2026-09-15"],
                  entities: [
                    { name: "Alexandria", type: "project", context: "Working on Alexandria" },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    fetchFn: mockFetch,
    sleepFn: () => Promise.resolve(),
  });

  const result = await provider.classifyMemory("Working on Alexandria with Alice");
  assertEquals(result.status, "model");
  assertEquals(result.source, "model");
  assertEquals(result.error_class, null);
  assertEquals(result.category, "idea");
  assertEquals(result.importance, 8);
  assertEquals(result.tags, ["ai", "mcp"]);
  assertEquals(result.people, ["Alice"]);
  assertEquals(result.entities.length, 1);
  assertEquals(result.entities[0].name, "Alexandria");
});

Deno.test("provider: HTTP 401 does not retry and returns fallback with auth_error", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = () => {
    callCount++;
    return Promise.resolve(
      new Response("Unauthorized", { status: 401 }),
    );
  };

  const provider = new OpenRouterProvider({
    apiKey: "bad-key",
    maxRetries: 3,
    fetchFn: mockFetch,
    sleepFn: () => Promise.resolve(),
  });

  const result = await provider.classifyMemory("Note about meeting");
  assertEquals(callCount, 1, "HTTP 401 must not trigger retries");
  assertEquals(result.status, "fallback");
  assertEquals(result.source, "fallback");
  assertEquals(result.error_class, "auth_error");
});

Deno.test("provider: HTTP 403 does not retry and returns fallback with auth_error", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = () => {
    callCount++;
    return Promise.resolve(
      new Response("Forbidden", { status: 403 }),
    );
  };

  const provider = new OpenRouterProvider({
    apiKey: "forbidden-key",
    maxRetries: 3,
    fetchFn: mockFetch,
    sleepFn: () => Promise.resolve(),
  });

  const result = await provider.classifyMemory("Note about meeting");
  assertEquals(callCount, 1, "HTTP 403 must not trigger retries");
  assertEquals(result.status, "fallback");
  assertEquals(result.source, "fallback");
  assertEquals(result.error_class, "auth_error");
});

Deno.test("provider: HTTP 429 performs bounded retry and returns fallback with rate_limit if exhausted", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = () => {
    callCount++;
    return Promise.resolve(
      new Response("Rate limit exceeded", { status: 429 }),
    );
  };

  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    maxRetries: 2,
    fetchFn: mockFetch,
    sleepFn: () => Promise.resolve(),
  });

  const result = await provider.classifyMemory("Note content");
  assertEquals(callCount, 3, "Should try initial + 2 retries = 3 calls");
  assertEquals(result.status, "fallback");
  assertEquals(result.source, "fallback");
  assertEquals(result.error_class, "rate_limit");
});

Deno.test("provider: HTTP 500 performs bounded retry and returns fallback with server_error if exhausted", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = () => {
    callCount++;
    return Promise.resolve(
      new Response("Internal Server Error", { status: 500 }),
    );
  };

  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    maxRetries: 2,
    fetchFn: mockFetch,
    sleepFn: () => Promise.resolve(),
  });

  const result = await provider.classifyMemory("Note content");
  assertEquals(callCount, 3);
  assertEquals(result.status, "fallback");
  assertEquals(result.source, "fallback");
  assertEquals(result.error_class, "server_error");
});

Deno.test("provider: transport network error performs bounded retry and returns fallback with transport_error", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = () => {
    callCount++;
    return Promise.reject(new TypeError("Network connection reset"));
  };

  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    maxRetries: 2,
    fetchFn: mockFetch,
    sleepFn: () => Promise.resolve(),
  });

  const result = await provider.classifyMemory("Note content");
  assertEquals(callCount, 3);
  assertEquals(result.status, "fallback");
  assertEquals(result.source, "fallback");
  assertEquals(result.error_class, "transport_error");
});

Deno.test("provider: timeout exceeded returns fallback with timeout error_class", async () => {
  let time = 0;
  const mockFetch: typeof fetch = (_url, init) => {
    return new Promise((_, reject) => {
      // simulate timeout via abort signal
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "TimeoutError"));
      });
    });
  };

  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    totalDeadlineMs: 500,
    perAttemptTimeoutMs: 100,
    maxRetries: 1,
    nowFn: () => {
      time += 300;
      return time;
    },
    fetchFn: mockFetch,
    sleepFn: () => Promise.resolve(),
  });

  const result = await provider.classifyMemory("Timeout test content");
  assertEquals(result.status, "fallback");
  assertEquals(result.source, "fallback");
  assertEquals(result.error_class, "timeout");
});

Deno.test("provider: malformed JSON returns fallback with malformed_response without infinite retry", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = () => {
    callCount++;
    return Promise.resolve(
      new Response("{ invalid json content", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    maxRetries: 2,
    fetchFn: mockFetch,
    sleepFn: () => Promise.resolve(),
  });

  const result = await provider.classifyMemory("Testing malformed response");
  assertEquals(callCount, 1, "Malformed JSON should not retry endlessly");
  assertEquals(result.status, "fallback");
  assertEquals(result.source, "fallback");
  assertEquals(result.error_class, "malformed_response");
});

Deno.test("provider: getEmbedding returns embedding on success and throws typed error on 401", async () => {
  const successFetch: typeof fetch = () => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ embedding: Array(2048).fill(0.1) }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const successProvider = new OpenRouterProvider({
    apiKey: "test-key",
    fetchFn: successFetch,
    sleepFn: () => Promise.resolve(),
  });

  const embedding = await successProvider.getEmbedding("test text");
  assertEquals(embedding.length, 2048);

  const failFetch: typeof fetch = () => {
    return Promise.resolve(new Response("Unauthorized", { status: 401 }));
  };

  const failProvider = new OpenRouterProvider({
    apiKey: "bad-key",
    fetchFn: failFetch,
    sleepFn: () => Promise.resolve(),
  });

  await assertRejects(
    () => failProvider.getEmbedding("test text"),
    ProviderAuthError,
  );
});
