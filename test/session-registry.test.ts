import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/lib/session-registry.js";

describe("SessionRegistry", () => {
  it("does not persist keyless sessions", () => {
    const sessions = new SessionRegistry();

    sessions.remember(undefined, "session-1");

    expect(sessions.resolve(undefined)).toBeNull();
    expect(sessions.size).toBe(0);
  });

  it("isolates sessions by key", () => {
    const sessions = new SessionRegistry();

    sessions.remember("review-a", "session-a");
    sessions.remember("review-b", "session-b");

    expect(sessions.resolve("review-a")).toBe("session-a");
    expect(sessions.resolve("review-b")).toBe("session-b");
  });

  it("forgets failed sessions", () => {
    const sessions = new SessionRegistry();
    sessions.remember("review", "session-1");

    sessions.forget("review");

    expect(sessions.resolve("review")).toBeNull();
    expect(sessions.size).toBe(0);
  });
});
