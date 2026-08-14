import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthContext } from "./config.ts";

export interface RequestContext {
  auth: AuthContext;
  callerClient: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getAuth(): AuthContext | undefined {
  return storage.getStore()?.auth;
}
