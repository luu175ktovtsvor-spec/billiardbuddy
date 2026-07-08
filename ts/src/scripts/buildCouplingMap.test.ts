import { expect, test } from "bun:test";

const bcm = await import("../../../scripts/build_coupling_map.mjs");

test("normalizeEndpoint collapses path params", () => {
  expect(bcm.normalizeEndpoint("/api/v1/members/${userId}/role")).toBe("/api/v1/members/{}/role");
  expect(bcm.normalizeEndpoint("/me/byok/profiles/{name}/activate")).toBe("/me/byok/profiles/{}/activate");
  expect(bcm.normalizeEndpoint("/api/v1/generations?x=1")).toBe("/api/v1/generations");
  expect(bcm.normalizeEndpoint("/api/v1/store-memory/")).toBe("/api/v1/store-memory");
});

test("extracts known live wiring", () => {
  const calls = bcm.extractFrontendCalls();
  const routes = bcm.extractBackendRoutes();
  const [wired] = bcm.match(calls, routes);
  const wiredPairs = new Set(wired.map(([call]: [typeof calls[number]]) => `${call.method}\0${call.endpoint}`));

  expect(wiredPairs.has("getMe\0/api/v1/auth/me")).toBe(true);
  expect(wiredPairs.has("getMyStore\0/api/v1/stores/me")).toBe(true);
  expect(wiredPairs.has("listSkills\0/api/v1/agent/skills")).toBe(true);
  expect(wiredPairs.has("getTodayDashboard\0/api/v1/dashboard/today")).toBe(true);
});

test("backend routes resolve to real funcs", () => {
  const routes = bcm.extractBackendRoutes();
  expect(routes.length).toBeGreaterThan(0);

  const endpoints = new Set(routes.map((route: { endpoint: string }) => route.endpoint));
  expect(endpoints.has("/api/v1/agent/chat")).toBe(true);
  expect(endpoints.has("/api/v1/canvas/edit")).toBe(true);
});

test("coupling map auto block is fresh", async () => {
  const text = await Bun.file(bcm.DOC).text();
  expect(text.includes(bcm.AUTO_BEGIN)).toBe(true);

  const start = text.indexOf(bcm.AUTO_BEGIN);
  const end = text.indexOf(bcm.AUTO_END) + bcm.AUTO_END.length;
  const docBlock = text.slice(start, end).trim();
  const fresh = bcm.render(bcm.extractFrontendCalls(), bcm.extractBackendRoutes()).trim();

  expect(docBlock).toBe(fresh);
});
