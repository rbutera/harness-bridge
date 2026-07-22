import { describe, expect, it } from "vitest";
import { ThreadRegistry } from "../src/lib/thread-registry.js";

describe("ThreadRegistry", () => {
  it("does not resume when no key is given", () => {
    const registry = new ThreadRegistry();
    registry.remember(undefined, "thread-1", "read-only");

    // A keyless call must never pick up another call's thread. This is the
    // property that stops concurrent reviewers stomping each other.
    expect(registry.resolve(undefined, "read-only")).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("ignores existing records entirely when resolving without a key", () => {
    const registry = new ThreadRegistry();
    // Seeded under the exact key a naive `key ?? "GLOBAL"` fallback would use.
    // This pins the resolve-side guard on its own, so reintroducing a shared
    // global on that side is caught even while `remember`'s guard still holds.
    registry.remember("GLOBAL", "thread-1", "read-only");

    expect(registry.resolve(undefined, "read-only")).toBeNull();
  });

  it("stores nothing when remembering without a key", () => {
    const registry = new ThreadRegistry();
    registry.remember(undefined, "thread-1", "read-only");

    // Pins the remember-side guard independently of the resolve-side one.
    expect(registry.size).toBe(0);
  });

  it("resumes a thread for the same key and sandbox", () => {
    const registry = new ThreadRegistry();
    registry.remember("review-a", "thread-1", "read-only");

    expect(registry.resolve("review-a", "read-only")).toBe("thread-1");
  });

  it("keeps different keys isolated from each other", () => {
    const registry = new ThreadRegistry();
    registry.remember("review-a", "thread-a", "read-only");
    registry.remember("review-b", "thread-b", "read-only");

    expect(registry.resolve("review-a", "read-only")).toBe("thread-a");
    expect(registry.resolve("review-b", "read-only")).toBe("thread-b");
  });

  it("refuses to resume when the sandbox differs", () => {
    const registry = new ThreadRegistry();
    registry.remember("impl", "thread-1", "workspace-write");

    // `codex exec resume` takes no --sandbox flag, so resuming here would run
    // under workspace-write while the caller asked for danger-full-access, and
    // say nothing about it. Starting fresh is the only honest option.
    expect(registry.resolve("impl", "danger-full-access")).toBeNull();
  });

  it("resumes again once the sandbox matches the recorded one", () => {
    const registry = new ThreadRegistry();
    registry.remember("impl", "thread-1", "workspace-write");

    expect(registry.resolve("impl", "danger-full-access")).toBeNull();
    expect(registry.resolve("impl", "workspace-write")).toBe("thread-1");
  });

  it("forgets a key so the next call starts clean", () => {
    const registry = new ThreadRegistry();
    registry.remember("review-a", "thread-1", "read-only");
    registry.forget("review-a");

    expect(registry.resolve("review-a", "read-only")).toBeNull();
  });

  it("overwrites a key's thread when the same key runs again", () => {
    const registry = new ThreadRegistry();
    registry.remember("review-a", "thread-1", "read-only");
    registry.remember("review-a", "thread-2", "read-only");

    expect(registry.resolve("review-a", "read-only")).toBe("thread-2");
    expect(registry.size).toBe(1);
  });
});
