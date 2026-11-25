// Bind-address auth policy. The rule that matters: an open-by-default proxy is
// only acceptable when nothing but this machine can reach it.

import { expect, test } from "bun:test";
import { isLoopbackHost, resolveAuthPolicy } from "../src/config.ts";

test("loopback binds are recognised and everything else is public", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost", "[::1]"]) {
    expect(isLoopbackHost(host)).toBe(true);
  }
  for (const host of ["0.0.0.0", "::", "10.0.0.5", "192.168.1.20", "proxy.example.com"]) {
    expect(isLoopbackHost(host)).toBe(false);
  }
});

test("localhost defaults to no auth at all", () => {
  const policy = resolveAuthPolicy("127.0.0.1", undefined, undefined, undefined);
  expect(policy.isPublic).toBe(false);
  expect(policy.dashboardAuth).toBeNull();
  expect(policy.requireApiKey).toBe(false);
});

test("dashboard credentials on localhost close both the dashboard and the API", () => {
  const policy = resolveAuthPolicy("127.0.0.1", "ada", "hunter2", undefined);
  expect(policy.dashboardAuth).toEqual({ user: "ada", password: "hunter2" });
  // Half-guarded is not a state anyone asks for: opting into a password closes
  // the API too, so a local proxy is either open or wholly closed.
  expect(policy.requireApiKey).toBe(true);
});

test("the API key can still be required on localhost without a dashboard password", () => {
  const policy = resolveAuthPolicy("127.0.0.1", undefined, undefined, "on");
  expect(policy.dashboardAuth).toBeNull();
  expect(policy.requireApiKey).toBe(true);
});

test("a public bind refuses to start without dashboard credentials", () => {
  expect(() => resolveAuthPolicy("0.0.0.0", undefined, undefined, undefined)).toThrow(/WARM2API_DASHBOARD_USER/);
  expect(() => resolveAuthPolicy("10.0.0.5", undefined, undefined, "on")).toThrow(/WARM2API_DASHBOARD_USER/);
});

test("a public bind never runs with API auth disabled", () => {
  expect(() => resolveAuthPolicy("0.0.0.0", "ada", "hunter2", "off")).toThrow(/open relay/);
  const policy = resolveAuthPolicy("0.0.0.0", "ada", "hunter2", undefined);
  expect(policy.isPublic).toBe(true);
  expect(policy.requireApiKey).toBe(true);
});

test("half-configured credentials are rejected on any bind", () => {
  expect(() => resolveAuthPolicy("127.0.0.1", "ada", undefined, undefined)).toThrow(/together/);
  expect(() => resolveAuthPolicy("127.0.0.1", undefined, "hunter2", undefined)).toThrow(/together/);
});
