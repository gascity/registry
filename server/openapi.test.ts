import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Spec-first drift gate (contract §7). openapi-typescript derives server/openapi.gen.ts from
// the spec (committed → git-diff catches drift). Here we assert the spec is valid 3.0 with the
// x-gc governance vocab, and that every STATIC documented route is grounded in server/app.ts
// (documented-route-exists), with a floor guard so a refactor that breaks extraction fails loud.
const spec = JSON.parse(
  readFileSync(join(import.meta.dir, "../docs/reference/schema/registry.openapi.json"), "utf8"),
);
const app = readFileSync(join(import.meta.dir, "app.ts"), "utf8");

test("spec is OpenAPI 3.0 with paths", () => {
  expect(String(spec.openapi).startsWith("3.0")).toBe(true);
  expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
});

test("every operation carries the x-gc governance vocabulary", () => {
  const verbs = new Set(["get", "put", "post", "delete", "patch"]);
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const [m, op] of Object.entries<any>(item)) {
      if (!verbs.has(m)) continue;
      expect(op["x-gc-enforcement"], `${m} ${p} x-gc-enforcement`).toBeDefined();
      expect(op["x-gc-plane"], `${m} ${p} x-gc-plane`).toBeDefined();
    }
  }
});

test("route extraction from app.ts meets the floor guard (>= 30)", () => {
  const staticPaths = new Set([...app.matchAll(/url\.pathname\s*===\s*"([^"]+)"/g)].map((m) => m[1]));
  const paramMatches = [...app.matchAll(/url\.pathname\.match\(/g)].length;
  const extracted = staticPaths.size + paramMatches;
  expect(extracted, `only ${extracted} routes extracted — did app.ts's route syntax change?`).toBeGreaterThanOrEqual(30);
});

test("every static documented route is grounded in app.ts", () => {
  const staticPaths = new Set([...app.matchAll(/url\.pathname\s*===\s*"([^"]+)"/g)].map((m) => m[1]));
  const missing: string[] = [];
  for (const p of Object.keys(spec.paths)) {
    if (p.includes("{")) continue; // param'd routes use the .match() form, checked by the floor
    if (!staticPaths.has(p)) missing.push(p);
  }
  expect(missing, `documented routes not found as a pathname literal in app.ts: ${missing.join(", ")}`).toEqual([]);
});

test("publish validation responses describe every durable error outcome without an ambiguous oneOf", () => {
  const createResponses = spec.paths["/api/publish-requests"].post.responses;
  const retryResponses = spec.paths["/api/publish-requests/{id}/validate"].post.responses;
  const create422 = createResponses["422"].content["application/json"].schema;

  expect(create422.oneOf).toBeUndefined();
  expect(create422.anyOf).toEqual([
    { $ref: "#/components/schemas/ApiError" },
    { $ref: "#/components/schemas/PublishValidationErrorResponse" },
  ]);

  for (const responses of [createResponses, retryResponses]) {
    for (const status of ["500", "502"]) {
      expect(responses[status].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/PublishValidationErrorResponse",
      });
    }
  }
});
