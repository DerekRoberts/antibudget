import type { IncomingMessage } from "node:http";

import { ApiError } from "./api.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Blocks cross-site browser mutations against the loopback UI (CSRF). */
export function assertSafeMutationRequest(req: IncomingMessage): void {
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite === "cross-site") {
    throw new ApiError(403, "Forbidden");
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      throw new ApiError(403, "Forbidden");
    }
    if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
      throw new ApiError(403, "Forbidden");
    }
  }
}
