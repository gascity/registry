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

test("every parameterized v1 feedback operation declares its required path parameters", () => {
  const verbs = new Set(["get", "put", "post", "delete", "patch"]);
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    if (!path.startsWith("/api/v1/") || !path.includes("{")) continue;
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    for (const [method, operation] of Object.entries<any>(item)) {
      if (!verbs.has(method)) continue;
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
      for (const name of placeholders) {
        expect(
          parameters.some((parameter) =>
            parameter.in === "path" && parameter.name === name && parameter.required === true
          ),
          `${method} ${path} must declare required path parameter ${name}`,
        ).toBe(true);
      }
    }
  }
});

test("feedback operations document their authentication, conflict, rate-limit, and server errors", () => {
  const expected: Record<string, string[]> = {
    "get /api/v1/me/publish-requests": ["200", "401", "403", "429", "500"],
    "get /api/v1/me/publish-requests/{id}": ["200", "401", "403", "404", "429", "500"],
    "post /api/v1/me/publish-requests/{id}/comments":
      ["201", "400", "401", "403", "404", "409", "413", "422", "429", "500"],
    "post /api/v1/me/publish-requests/{id}/read":
      ["204", "400", "401", "403", "404", "413", "422", "429", "500"],
    "get /api/v1/admin/publish-requests/{id}": ["200", "401", "403", "404", "429", "500"],
    "post /api/v1/admin/publish-requests/{id}/comments":
      ["201", "400", "401", "403", "404", "409", "413", "422", "429", "500"],
  };
  for (const [operation, statuses] of Object.entries(expected)) {
    const [method, path] = operation.split(" ", 2);
    expect(
      Object.keys(spec.paths[path][method].responses).sort(),
      `${operation} response statuses`,
    ).toEqual(statuses.sort());
  }
});

test("staff feedback schemas cannot expose submitter notification timestamps", () => {
  const schemas = spec.components.schemas;
  const dereference = (schema: any) =>
    schema?.$ref ? schemas[String(schema.$ref).split("/").pop()!] : schema;
  const propertyNames = (schema: any, seen = new Set<any>()): Set<string> => {
    const resolved = dereference(schema);
    if (!resolved || seen.has(resolved)) return new Set();
    seen.add(resolved);
    const names = new Set(Object.keys(resolved.properties ?? {}));
    for (const member of resolved.allOf ?? []) {
      for (const name of propertyNames(member, seen)) names.add(name);
    }
    return names;
  };

  const ownerNames = propertyNames(schemas.PublishRequestFeedbackDetail);
  expect(ownerNames.has("submitterUnreadAt")).toBe(true);
  expect(ownerNames.has("submitterReadAt")).toBe(false);

  const staffDetailNames = propertyNames(schemas.StaffPublishRequestFeedbackDetail);
  expect(staffDetailNames.has("submitterUnreadAt")).toBe(false);
  expect(staffDetailNames.has("submitterReadAt")).toBe(false);
  expect(staffDetailNames.has("unread")).toBe(false);

  expect(
    schemas.AdminPublishRequestFeedbackDetailResponse.properties.publishRequest,
  ).toEqual({ $ref: "#/components/schemas/StaffPublishRequestFeedbackDetail" });
  expect(
    spec.paths["/api/v1/admin/publish-requests/{id}/comments"].post.responses["201"]
      .content["application/json"].schema,
  ).toEqual({ $ref: "#/components/schemas/PublishRequestCommentMutationResponse" });
});
