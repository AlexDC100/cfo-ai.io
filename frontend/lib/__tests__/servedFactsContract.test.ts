// Served-envelope contract (docs/served_envelope.schema.json) — the FE half
// of the engine↔FE shared contract. For EVERY field servedFacts reads
// (SERVED_ENVELOPE_FIELDS_READ), assert the field exists in the schema at
// the pinned envelope version. A field the engine renames or drops fails
// HERE, before it can fail a user; a field the FE starts reading without
// adding it to the schema fails here too (the manifest is the module's
// read list — keep them in lockstep).
//
// The schema file is parsed directly (no ajv dependency): dotted paths are
// resolved through `properties` / `items`, following `$ref` into `$defs` —
// the same shapes the engine-side snapshot test walks.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  SERVED_ENVELOPE_FIELDS_READ,
  SERVED_ENVELOPE_VERSION,
} from "@/lib/servedFacts";

type SchemaNode = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  $defs?: Record<string, SchemaNode>;
  [key: string]: unknown;
};

const repoRoot = resolve(__dirname, "../../..");
const schemaPath = resolve(repoRoot, "docs/served_envelope.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as SchemaNode & {
  "x-envelope-version"?: string;
  envelope_version?: string;
};

/** Follow a $ref of the form "#/$defs/<name>" to its definition. */
function deref(node: SchemaNode): SchemaNode {
  if (node.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(node.$ref);
    if (!m) throw new Error(`Unsupported $ref shape: ${node.$ref}`);
    const target = (schema.$defs ?? {})[m[1]];
    if (!target) throw new Error(`$ref target missing: ${node.$ref}`);
    return deref(target);
  }
  return node;
}

/** Resolve a dotted path under statements.*; arrays step through `items`. */
function resolvePath(path: string): SchemaNode | null {
  const statements = deref(
    (schema.properties?.statements ?? {}) as SchemaNode,
  );
  let node: SchemaNode | null = statements;
  for (const part of path.split(".")) {
    if (!node) return null;
    node = deref(node);
    let next: SchemaNode | undefined = node.properties?.[part];
    if (!next && node.items) {
      const items = deref(node.items);
      next = items.properties?.[part];
    }
    if (!next) return null;
    node = next;
  }
  return deref(node);
}

describe("served envelope contract (docs/served_envelope.schema.json)", () => {
  it("is pinned at the version servedFacts was written against", () => {
    expect(schema["x-envelope-version"]).toBe(SERVED_ENVELOPE_VERSION);
  });

  it.each(SERVED_ENVELOPE_FIELDS_READ.map((p) => [p] as const))(
    "schema carries %s",
    (path) => {
      const node = resolvePath(path);
      expect(
        node,
        `servedFacts reads statements.${path} but the schema does not define it — either the engine dropped/renamed the field (bump envelope_version + migrate) or the FE read is stale`,
      ).not.toBeNull();
    },
  );

  it("status enum still carries all four machine states incl. RECONCILED", () => {
    const status = resolvePath("canonical_bs.status");
    expect(status?.enum).toEqual(
      expect.arrayContaining(["BALANCED", "MINOR_DRIFT", "MATERIAL_IMBALANCE", "RECONCILED"]),
    );
  });

  it("difference is exactly-0-on-RECONCILED per the schema description", () => {
    const diff = resolvePath("canonical_bs.difference");
    expect(String(diff?.description ?? "")).toContain("exactly 0 on RECONCILED");
  });
});

describe("shared fixtures satisfy the schema's required keys", () => {
  const requiredOf = (defName: string): string[] => {
    const def = (schema.$defs ?? {})[defName];
    return ((def?.required as string[] | undefined) ?? []);
  };

  const fixtures = [
    "served_balanced.json",
    "served_reconciled_bs.json",
    "served_reconciled_pnl.json",
  ] as const;

  it.each(fixtures.map((f) => [f] as const))("%s", (name) => {
    const fixture = JSON.parse(
      readFileSync(resolve(__dirname, "fixtures", name), "utf-8"),
    ) as Record<string, unknown>;
    const cbs = fixture.canonical_bs as Record<string, unknown>;
    for (const key of requiredOf("canonical_bs")) {
      expect(cbs, `canonical_bs.${key} required by schema`).toHaveProperty(key);
    }
    const totalsRequired =
      ((schema.$defs?.canonical_bs?.properties?.totals as SchemaNode | undefined)
        ?.required as string[] | undefined) ?? [];
    for (const key of totalsRequired) {
      expect(cbs.totals, `canonical_bs.totals.${key} required by schema`).toHaveProperty(key);
    }
    // RECONCILED fixtures must carry the receipt's required keys.
    if ((cbs.status as string) === "RECONCILED") {
      for (const key of requiredOf("reconciliation_receipt")) {
        expect(cbs.reconciliation, `reconciliation.${key} required by schema`).toHaveProperty(key);
      }
    }
  });
});
