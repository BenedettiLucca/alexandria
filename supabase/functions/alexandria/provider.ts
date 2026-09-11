import {
  CLASSIFICATION_MODEL,
  EMBEDDING_MODEL,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE,
  PROVIDER_INITIAL_BACKOFF_MS,
  PROVIDER_MAX_RETRIES,
  PROVIDER_PER_ATTEMPT_TIMEOUT_MS,
  PROVIDER_TOTAL_DEADLINE_MS,
} from "./config.ts";
import {
  sanitizeClassification,
  simpleClassify,
  type ValidatedEntity,
} from "./lib.ts";

export type ErrorClass =
  | "timeout"
  | "auth_error"
  | "rate_limit"
  | "server_error"
  | "transport_error"
  | "malformed_response";

export type ClassificationStatus = "model" | "fallback" | "failed";

export class ProviderError extends Error {
  readonly errorClass: ErrorClass;
  readonly status: number | null;
  readonly isRetryable: boolean;

  constructor(
    message: string,
    errorClass: ErrorClass,
    status: number | null = null,
    isRetryable: boolean = false,
  ) {
    super(message);
    this.name = "ProviderError";
    this.errorClass = errorClass;
    this.status = status;
    this.isRetryable = isRetryable;
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message: string = "Provider request timed out") {
    super(message, "timeout", null, false);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(
    message: string = "Provider authentication failed",
    status: number = 401,
  ) {
    super(message, "auth_error", status, false);
    this.name = "ProviderAuthError";
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(
    message: string = "Provider rate limit exceeded",
    status: number = 429,
  ) {
    super(message, "rate_limit", status, true);
    this.name = "ProviderRateLimitError";
  }
}

export class ProviderServerError extends ProviderError {
  constructor(
    message: string = "Provider server error",
    status: number = 500,
  ) {
    super(message, "server_error", status, true);
    this.name = "ProviderServerError";
  }
}

export class ProviderTransportError extends ProviderError {
  constructor(message: string = "Provider transport error") {
    super(message, "transport_error", null, true);
    this.name = "ProviderTransportError";
  }
}

export class ProviderMalformedResponseError extends ProviderError {
  constructor(message: string = "Provider returned malformed response") {
    super(message, "malformed_response", null, false);
    this.name = "ProviderMalformedResponseError";
  }
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  classificationModel?: string;
  embeddingModel?: string;
  totalDeadlineMs?: number;
  perAttemptTimeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  backoffFactor?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

export interface ClassificationResult {
  category: string;
  tags: string[];
  people: string[];
  importance: number;
  title: string | null;
  dates_mentioned: string[];
  entities: ValidatedEntity[];
  status: ClassificationStatus;
  source: ClassificationStatus;
  error_class: ErrorClass | null;
  errorClass?: ErrorClass | null;
}

export class OpenRouterProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly classificationModel: string;
  private readonly embeddingModel: string;
  private readonly totalDeadlineMs: number;
  private readonly perAttemptTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly backoffFactor: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;

  constructor(options?: ProviderConfig) {
    this.baseUrl = options?.baseUrl || OPENROUTER_BASE;
    this.apiKey = options?.apiKey || OPENROUTER_API_KEY;
    this.classificationModel = options?.classificationModel ||
      CLASSIFICATION_MODEL;
    this.embeddingModel = options?.embeddingModel || EMBEDDING_MODEL;
    this.totalDeadlineMs = options?.totalDeadlineMs ?? PROVIDER_TOTAL_DEADLINE_MS;
    this.perAttemptTimeoutMs = options?.perAttemptTimeoutMs ??
      PROVIDER_PER_ATTEMPT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? PROVIDER_MAX_RETRIES;
    this.initialBackoffMs = options?.initialBackoffMs ??
      PROVIDER_INITIAL_BACKOFF_MS;
    this.backoffFactor = options?.backoffFactor ?? 2;
    this.fetchFn = options?.fetchFn || ((url, init) => globalThis.fetch(url, init));
    this.sleepFn = options?.sleepFn ||
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowFn = options?.nowFn || (() => Date.now());
  }

  private async executeBoundedFetch(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const startTime = this.nowFn();
    let attempt = 0;
    let lastError: ProviderError | null = null;

    while (true) {
      const elapsed = this.nowFn() - startTime;
      const remainingTotal = this.totalDeadlineMs - elapsed;
      if (remainingTotal <= 0) {
        throw (
          lastError ||
          new ProviderTimeoutError(
            `Total deadline of ${this.totalDeadlineMs}ms exceeded`,
          )
        );
      }

      const attemptTimeout = Math.min(remainingTotal, this.perAttemptTimeoutMs);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort("timeout");
      }, attemptTimeout);

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          ...init,
          signal: controller.signal,
        });
      } catch (e: unknown) {
        clearTimeout(timer);
        const isAbort = controller.signal.aborted ||
          (e instanceof Error &&
            (e.name === "AbortError" || e.name === "TimeoutError"));

        if (isAbort) {
          lastError = new ProviderTimeoutError("Request timed out");
        } else {
          lastError = new ProviderTransportError(
            e instanceof Error ? e.message : "Network transport error",
          );
        }

        if (attempt >= this.maxRetries) {
          throw lastError;
        }

        const backoff = this.initialBackoffMs *
          Math.pow(this.backoffFactor, attempt);
        const timeAfterBackoff = (this.nowFn() - startTime) + backoff;
        if (timeAfterBackoff >= this.totalDeadlineMs) {
          throw new ProviderTimeoutError(
            `Total deadline of ${this.totalDeadlineMs}ms exceeded during retry backoff`,
          );
        }

        await this.sleepFn(backoff);
        attempt++;
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        return response;
      }

      // 401 or 403: Never retry!
      if (response.status === 401 || response.status === 403) {
        await response.text().catch(() => "");
        throw new ProviderAuthError(
          `Authentication failed with HTTP ${response.status}`,
          response.status,
        );
      }

      if (response.status === 429) {
        await response.text().catch(() => "");
        lastError = new ProviderRateLimitError(
          "Rate limit exceeded (HTTP 429)",
          429,
        );
      } else if (response.status >= 500 && response.status < 600) {
        await response.text().catch(() => "");
        lastError = new ProviderServerError(
          `Server error (HTTP ${response.status})`,
          response.status,
        );
      } else {
        const text = await response.text().catch(() => "");
        throw new ProviderError(
          `Request failed with HTTP ${response.status}: ${text}`,
          "transport_error",
          response.status,
          false,
        );
      }

      if (attempt >= this.maxRetries) {
        throw lastError;
      }

      const backoff = this.initialBackoffMs *
        Math.pow(this.backoffFactor, attempt);
      const timeAfterBackoff = (this.nowFn() - startTime) + backoff;
      if (timeAfterBackoff >= this.totalDeadlineMs) {
        throw new ProviderTimeoutError(
          `Total deadline of ${this.totalDeadlineMs}ms exceeded during retry backoff`,
        );
      }

      await this.sleepFn(backoff);
      attempt++;
    }
  }

  async classifyMemory(
    text: string,
    options?: { fallback?: boolean },
  ): Promise<ClassificationResult> {
    const allowFallback = options?.fallback ?? true;

    try {
      const response = await this.executeBoundedFetch(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.classificationModel,
            messages: [
              {
                role: "system",
                content:
                  `Classify the given memory note. Return JSON with:
- category: one of note, idea, decision, observation, reference, task, person, recipe, travel, purchase, quote
- tags: array of 1-5 lowercase strings
- people: array of people names mentioned
- importance: 1-10 integer
- title: concise title under 60 chars or null
- dates_mentioned: array of YYYY-MM-DD strings or empty
- entities: array of {name: string, type: "person"|"project"|"concept"|"location"|"technology"|"organization"|"event"|"other", context: string|null}`,
              },
              { role: "user", content: text },
            ],
            response_format: { type: "json_object" },
          }),
        },
      );

      let data: Record<string, unknown>;
      try {
        data = await response.json();
      } catch {
        throw new ProviderMalformedResponseError(
          "Malformed response: invalid JSON body",
        );
      }

      const choices = data.choices as Array<{
        message?: { content?: string };
      }> | undefined;
      const rawContent = choices?.[0]?.message?.content;
      if (!rawContent || typeof rawContent !== "string") {
        throw new ProviderMalformedResponseError(
          "Malformed response: choices[0].message.content missing",
        );
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        throw new ProviderMalformedResponseError(
          "Malformed response: content is not valid JSON",
        );
      }

      const sanitized = sanitizeClassification(parsed);
      return {
        category: sanitized.category as string,
        tags: sanitized.tags as string[],
        people: sanitized.people as string[],
        importance: sanitized.importance as number,
        title: (sanitized.title as string | null) ?? null,
        dates_mentioned: sanitized.dates_mentioned as string[],
        entities: (sanitized.entities as ValidatedEntity[]) || [],
        status: "model",
        source: "model",
        error_class: null,
        errorClass: null,
      };
    } catch (err: unknown) {
      let errorClass: ErrorClass = "transport_error";
      if (err instanceof ProviderError) {
        errorClass = err.errorClass;
      } else if (
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        errorClass = "timeout";
      }

      if (!allowFallback) {
        throw err;
      }

      const fallback = sanitizeClassification(simpleClassify(text));
      return {
        category: fallback.category as string,
        tags: fallback.tags as string[],
        people: fallback.people as string[],
        importance: fallback.importance as number,
        title: (fallback.title as string | null) ?? null,
        dates_mentioned: fallback.dates_mentioned as string[],
        entities: (fallback.entities as ValidatedEntity[]) || [],
        status: "fallback",
        source: "fallback",
        error_class: errorClass,
        errorClass: errorClass,
      };
    }
  }

  async getEmbedding(text: string): Promise<number[]> {
    const response = await this.executeBoundedFetch(
      `${this.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: text,
        }),
      },
    );

    let data: Record<string, unknown>;
    try {
      data = await response.json();
    } catch {
      throw new ProviderMalformedResponseError(
        "Malformed response: invalid JSON body",
      );
    }

    const dataArr = data.data as Array<{ embedding?: number[] }> | undefined;
    const embedding = dataArr?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new ProviderMalformedResponseError(
        "Malformed response: embedding array missing",
      );
    }

    return embedding;
  }
}
