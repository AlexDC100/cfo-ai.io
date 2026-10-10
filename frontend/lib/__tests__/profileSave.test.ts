// A PROFILE SAVE IS AN UPDATE OF THE USER'S OWN ROW — NEVER AN UPSERT.
//
// `profiles` has an own-row SELECT policy and an own-row UPDATE policy and no
// INSERT policy (supabase/schema.sql; production's catalog read 2026-10-04
// shows the same two). An upsert is INSERT … ON CONFLICT DO UPDATE, and row
// level security refuses the INSERT half even when the row exists: Settings
// answered "Couldn't save profile" to every save.
//
// LAW. The save sends ONE update of `full_name`, filtered to the user's own
// id, and reads back the rows it touched; nothing in the frontend inserts
// or upserts into `profiles`; the table still has no insert policy in the
// repository's schema (if one is ever added, this law is re-read, not
// deleted); the two sentences Settings shows exist in both languages.
//
// Fails on: an upsert or insert into profiles anywhere in the frontend; an
// update with no id filter (every row the policy admits — today one, but
// the filter is the statement of intent); a save that reports success
// without reading back; an error swallowed; the page not using the helper.
// Cannot see: the database's own answer (no database in this suite — the
// policies are read from the schema file); whether the signup trigger made
// the row.
// Plant log: docs/engine_book/gates.md, "profile-save-own-row".
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { saveProfileName } from "@/lib/profileSave";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";

type Call = { op: string; args: unknown[] };
let checked = 0;

function fakeClient(answer: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const chain = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
    return builder;
  };
  const builder: Record<string, unknown> = {
    update: chain("update"),
    upsert: chain("upsert"),
    insert: chain("insert"),
    delete: chain("delete"),
    eq: chain("eq"),
    select: (...args: unknown[]) => {
      calls.push({ op: "select", args });
      return Promise.resolve(answer);
    },
  };
  const sb = {
    from: (table: string) => {
      calls.push({ op: "from", args: [table] });
      return builder;
    },
  };
  return { sb: sb as unknown as Parameters<typeof saveProfileName>[0], calls };
}

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK profile-save-own-row checks=${checked}`);
});

describe("the save is one update of the user's own row", () => {
  it("update(full_name) → eq(id, the user's) → select(id): nothing else is sent", async () => {
    const { sb, calls } = fakeClient({ data: [{ id: "user-1" }], error: null });
    const out = await saveProfileName(sb, "user-1", "Ana Maria Popescu");
    expect(calls).toEqual([
      { op: "from", args: ["profiles"] },
      { op: "update", args: [{ full_name: "Ana Maria Popescu" }] },
      { op: "eq", args: ["id", "user-1"] },
      { op: "select", args: ["id"] },
    ]);
    expect(out).toEqual({ error: null, rowUpdated: true });
    checked += 2;
  });

  it("a save that matched no row is not called a saved row — and is not an error", async () => {
    for (const data of [[], null, undefined]) {
      const { sb } = fakeClient({ data, error: null });
      expect(await saveProfileName(sb, "user-1", "Ana")).toEqual({ error: null, rowUpdated: false });
      checked += 1;
    }
  });

  it("the database's refusal reaches the caller in its own words", async () => {
    const { sb } = fakeClient({ data: null, error: { message: 'new row violates row-level security policy for table "profiles"' } });
    expect(await saveProfileName(sb, "user-1", "Ana")).toEqual({
      error: { message: 'new row violates row-level security policy for table "profiles"' },
      rowUpdated: false,
    });
    checked += 1;
  });
});

describe("nothing in the frontend inserts into profiles", () => {
  const ROOT = resolve(process.cwd(), "frontend");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name === "test") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
    }
  };
  walk(ROOT);

  it("every write to profiles in the frontend's source is an update", () => {
    expect(files.length).toBeGreaterThan(400);
    const writers: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Every statement that starts at from("profiles") — up to its `;`.
      for (const m of src.matchAll(/\.from\(\s*["'`]profiles["'`]\s*\)([\s\S]*?);/g)) {
        const verbs = [...m[1].matchAll(/\.(upsert|insert|update|delete)\(/g)].map((v) => v[1]);
        for (const verb of verbs) writers.push(`${file.slice(ROOT.length + 1)}:${verb}`);
      }
    }
    // POSITIVE CONTROL: the scan sees the writers that exist.
    expect(writers).toContain("lib/profileSave.ts:update");
    expect(writers.filter((w) => !w.endsWith(":update"))).toEqual([]);
    checked += writers.length;
  });

  it("the scan itself: an upsert, an insert and a multi-line chain are seen", () => {
    const seen = (src: string) =>
      [...src.matchAll(/\.from\(\s*["'`]profiles["'`]\s*\)([\s\S]*?);/g)]
        .flatMap((m) => [...m[1].matchAll(/\.(upsert|insert|update|delete)\(/g)].map((v) => v[1]));
    expect(seen('await sb.from("profiles").upsert({ id }, { onConflict: "id" });')).toEqual(["upsert"]);
    expect(seen("await sb\n  .from('profiles')\n  .insert({ id });")).toEqual(["insert"]);
    expect(seen('sb.from("profiles").select("full_name").eq("id", id).maybeSingle();')).toEqual([]);
    expect(seen('sb.from("profiles_archive").upsert({});')).toEqual([]);
    checked += 4;
  });

  it("Settings saves through the helper", () => {
    const page = readFileSync(join(ROOT, "pages/cfo/Settings.tsx"), "utf8");
    expect(page).toContain("await saveProfileName(sb, user.id, name)");
    expect(page).toContain('t("settings.profile_saved")');
    expect(page).toContain('t("settings.profile_save_failed")');
    expect(page).not.toContain('"Couldn\'t save profile"');
    checked += 1;
  });
});

describe("why an upsert cannot work: the table's policies", () => {
  it("the repository's schema gives profiles a select and an update policy, and no insert policy", () => {
    const dir = resolve(process.cwd(), "supabase");
    const policies: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".sql")) continue;
      const sql = readFileSync(join(dir, name), "utf8");
      for (const m of sql.matchAll(/create policy\s+"?([^"\n]+?)"?\s+on\s+(?:public\.)?profiles\s+for\s+(\w+)/gi)) {
        policies.push(m[2].toLowerCase());
      }
    }
    expect(policies.sort()).toEqual(["select", "update"]);
    checked += 1;
  });
});

describe("the two sentences", () => {
  it("exist in English and Romanian, and differ", () => {
    const s = (b: unknown) => (b as { settings: Record<string, string> }).settings;
    for (const k of ["profile_saved", "profile_save_failed"]) {
      expect(s(en)[k]).toBeTruthy();
      expect(s(ro)[k]).toBeTruthy();
      expect(s(ro)[k]).not.toBe(s(en)[k]);
      checked += 1;
    }
  });
});
