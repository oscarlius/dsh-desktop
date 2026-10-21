/**
 * Wire types for the P7 desktop search contract (`POST {origin}/v1/desktop/web-search`).
 * Types only — no runtime code. The gateway owns the search policy and the
 * self-hosted SearXNG target, so a desktop client sends a query and at most a
 * page number and receives four portable fields per result. `url` is always
 * present and absolute http(s) on a success; `title`, `snippet`, and
 * `publishedAt` may be absent, and no other key is promised — so the mapper
 * narrows every value against `unknown` instead of trusting this envelope.
 *
 * @module dsh-plugin-p7-web-search/types
 */

/** Request body of the contract. `pageno` is a page number (1..10), never a result count. */
export interface P7SearchRequestBody {
  query: string
  pageno?: number
}

/** One entry of the gateway's `results[]`. */
export interface P7ResultEntry {
  url?: unknown
  title?: unknown
  snippet?: unknown
  publishedAt?: unknown
}

/** The success envelope: `{ schemaVersion: 1, requestId, results[], truncated }`. */
export interface P7SearchResponseBody {
  schemaVersion?: unknown
  requestId?: unknown
  results?: unknown
  truncated?: unknown
}

/** The failure envelope: `{"error":{"code","message"},"requestId"}`. */
export interface P7ErrorResponseBody {
  error?: { code?: unknown; message?: unknown } | string
  requestId?: unknown
}

/**
 * FastAPI's own 422 envelope, which the gateway emits beside its documented
 * `{"error":…}` shape for the same validation failure. Its `detail[]` entries
 * echo submitted values, so this client reads only the fact of rejection and
 * never their contents.
 */
export interface P7ValidationResponseBody {
  detail?: unknown
}
