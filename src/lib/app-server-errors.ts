/**
 * Typed errors for the `codex app-server` client.
 *
 * Why a taxonomy rather than bare `Error`s: every failure here surfaces verbatim
 * in the bridge's tool-result `errors[]` (see `runViaAppServer` in
 * codex-server.ts), so the message is the only thing the calling agent gets.
 * "app-server request failed" teaches nothing; "is codex installed? run
 * `codex --version`" is something the agent, or the human reading its transcript,
 * can act on. Each class exists to carry the context needed to say what to do.
 */

/**
 * Minimum `codex` version whose `app-server` protocol these generated bindings
 * (src/generated) were produced against. Probed at first use: a spawn failure or
 * a handshake that dies immediately usually means an older CLI without the
 * subcommand, so the actionable errors name this version and how to check it.
 */
export const MINIMUM_CODEX_VERSION = "0.147.0";

/**
 * JSON-RPC error code the app-server returns for "server overloaded; retry
 * later". Distinct from a wedge: the server is alive and the request should be
 * retried with backoff, not failed. See `AppServerClient.request`.
 */
export const OVERLOADED_ERROR_CODE = -32001;

const VERSION_HINT = `harness-bridge needs codex >= ${MINIMUM_CODEX_VERSION}; check yours with \`codex --version\`.`;

/** Base class so callers can `instanceof AppServerError` for any client failure. */
export abstract class AppServerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Name each instance after its concrete subclass without repeating it in
    // every constructor; `new.target` is the subclass being constructed.
    this.name = new.target.name;
  }
}

/**
 * The `codex` binary could not be spawned at all (typically ENOENT: not on
 * PATH). The message points at the most likely fix.
 */
export class SpawnError extends AppServerError {
  constructor(cause?: unknown) {
    super(
      `Failed to spawn \`codex app-server\`. Is codex installed and on your PATH? ${VERSION_HINT}`,
      { cause },
    );
  }
}

/**
 * The process spawned but the `initialize` handshake never succeeded — it errored
 * or the child exited before answering. The usual cause is a codex too old to
 * expose `app-server`, so the message names the minimum version.
 */
export class HandshakeError extends AppServerError {
  constructor(detail?: string, options?: { cause?: unknown }) {
    const tail = detail ? ` (${detail})` : "";
    super(
      `codex app-server failed to initialize${tail}. This usually means your codex is too old or lacks the app-server subcommand. ${VERSION_HINT}`,
      options,
    );
  }
}

/**
 * A single JSON-RPC request did not come back inside its bound. The server is
 * treated as wedged (often swapped out under memory pressure) and torn down, so
 * the message says so and promises a respawn on the next call.
 */
export class RequestTimeoutError extends AppServerError {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(
      `codex app-server request '${method}' timed out after ${timeoutMs}ms. The server looked wedged (often memory pressure) and was torn down; the next call will respawn it.`,
    );
  }
}

/**
 * The child exited while requests were in flight, or a request was issued with no
 * live child. In-flight calls are failed with this so nothing hangs; the client
 * resets so the next call respawns cleanly.
 */
export class ServerCrashedError extends AppServerError {
  constructor(
    readonly code: number | null,
    options?: { cause?: unknown },
  ) {
    const where = code === null ? "is not running" : `exited with code ${code}`;
    super(
      `codex app-server ${where}. Any in-flight requests were failed; the next call respawns a fresh server.`,
      options,
    );
  }
}

/**
 * The server answered, but the payload did not match the protocol we expect
 * (e.g. a start response carrying no threadId). Names what was wrong.
 */
export class ProtocolError extends AppServerError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`codex app-server protocol error: ${detail}.`, options);
  }
}

/**
 * A JSON-RPC error response that is not one of the specially-handled codes
 * (overload, etc.). Preserves the server's own message and code.
 */
export class RequestError extends AppServerError {
  constructor(
    readonly method: string,
    readonly code: number,
    serverMessage: string,
    readonly data?: unknown,
  ) {
    super(`codex app-server error on '${method}': ${serverMessage} (code ${code})`);
  }
}

/**
 * The server reported overload (`OVERLOADED_ERROR_CODE`) and did not recover
 * within the retry budget. Retrying the whole call shortly is the fix.
 */
export class OverloadedError extends AppServerError {
  constructor(
    readonly method: string,
    readonly attempts: number,
  ) {
    super(
      `codex app-server is overloaded (JSON-RPC ${OVERLOADED_ERROR_CODE}) and did not recover after ${attempts} attempt(s) on '${method}'. Retry the call shortly.`,
    );
  }
}

/**
 * Map a JSON-RPC error response to a typed error. Overload is surfaced as
 * `OverloadedError` so the request layer can recognise and retry it; everything
 * else becomes a `RequestError` carrying the server's code and message.
 */
export function mapRequestError(
  method: string,
  error: { code: number; message: string; data?: unknown },
): AppServerError {
  if (error.code === OVERLOADED_ERROR_CODE) return new OverloadedError(method, 1);
  return new RequestError(method, error.code, error.message, error.data);
}
