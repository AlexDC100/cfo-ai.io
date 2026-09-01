// THE CANVAS — STORE GATES (CV-P1 … CV-P4).
//
// The subject is `lib/canvasThread`, `canvasPin` and `canvasAttach`: the
// three modules that decide WHAT SURVIVES a reload. Every one of them is
// pure enough to test as a function, which is the point of having put
// them there.
//
// ══ WHAT EACH GATE WOULD LET THROUGH IF IT WERE VACUOUS (TC-9) ═════════
//
// "The serialized payload contains no figure" is the exact shape of an
// assertion that passes because there was no figure to begin with. So
// CV-P1 runs a POSITIVE CONTROL first, in the same test, on the same
// detector: it points `containsFigureOf` at an object that DOES carry
// the value and requires it to fire. A zero that is never contrasted
// with a one is not a measurement.
//
// Every census below asserts its floor AFTER the discovery loop and PER
// COMPONENT (per module, per command, per plan) — never one floor on a
// sum, which is the failure TC-6 records six times in this codebase.
//
// ══ PROVEN ABLE TO FAIL ════════════════════════════════════════════════
//
// Recorded plants, each observed RED and reverted:
//
//  P1  `serializeEntry` grew `evidence: e as unknown` →
//      RED: "CV-P1: the serialized payload contains 390000 — a figure
//      reached storage."
//  P2  `isEntryLive` returned `hasLiveTurn` only (scope check dropped) →
//      RED: "CV-P2: an entry answered against p:dec was reported LIVE
//      under scope p:jan."
//  P3  `/compare` given `generative: true` →
//      RED: "CV-S1: 5 of 6 commands are engine-only; the recorded
//      expectation is 5 free and 1 generative, and `compare` moved."
//  P4  `planFor` returning the first match rather than the longest →
//      the FIRST version of the assertion stayed GREEN, because for every
//      input it tested the two rules agree. A plant that produces no red
//      is not evidence (TC-2), so the assertion was moved to an input
//      carrying triggers for BOTH plans, where the rules must disagree.
//      Re-planted → RED: "…the longest trigger ("full review", 11) must
//      win over the shorter one that appears first…  Got board_pack."
//
// CV-P1 was never planted deliberately: it went RED on its FIRST RUN
// against the real implementation, because `looksLikeFigure("390000")`
// is false and a bare digit run reached storage through `titleParams`.
// `isSafeTitleParam` is the fix, and that red is the gate's proof.

import { beforeEach, describe, expect, it } from "vitest";

import {
  CANVAS_PERSISTED_KEYS,
  __resetCanvasStoreForTests,
  appendCanvasEntry,
  canvasStorageKey,
  deriveCanvasTitle,
  fitToBudget,
  getCanvasStore,
  isEntryLive,
  isSafeTitleParam,
  safeTitleParams,
  scopeKey,
  serializeStore,
  type CanvasEntry,
} from "@/lib/canvasThread";
import {
  __resetCanvasPinsForTests,
  getCanvasPins,
  isPinned,
  toggleCanvasPin,
} from "../canvasPin";
import {
  __resetCanvasAttachmentForTests,
  ATTACH_TTL_MS,
  attachmentLooksSupported,
  peekCanvasAttachment,
  stageCanvasAttachment,
  takeCanvasAttachment,
} from "../canvasAttach";
import { CANVAS_SLASH_COMMANDS, canvasSlashMenu, parseCanvasSlash } from "../canvasSlash";
import { CANVAS_PLANS, planFor, planIsGenerative } from "../canvasPlan";

const ORG = "org-canvas-test";

/** A figure that would betray a persisted value if one leaked. */
const SECRET_MINOR = 390000;

function entry(over: Partial<CanvasEntry> = {}): CanvasEntry {
  return {
    id: "e1",
    question: "total assets",
    askedAt: 1_700_000_000_000,
    scope: scopeKey("p-dec"),
    command: null,
    steps: [],
    artifacts: [
      { id: "e1", kind: "figures", titleKey: "canvas.artifact.figures" },
    ],
    attachment: null,
    ...over,
  };
}

/** Does this JSON text carry the figure? The DETECTOR — used both to
 *  prove a leak and to prove its absence, so the absence means
 *  something. */
function containsFigureOf(json: string, value: number): boolean {
  return json.includes(String(value));
}

beforeEach(() => {
  __resetCanvasStoreForTests();
  __resetCanvasPinsForTests();
  __resetCanvasAttachmentForTests();
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom always has storage here */
  }
});

// ══════════════════════════════════════════════════════════════════════
// CV-P1 — no figure is ever persisted
// ══════════════════════════════════════════════════════════════════════

describe("CV-P1 — the persisted payload carries no figure", () => {
  it("the detector fires on an object that DOES carry the value", () => {
    // POSITIVE CONTROL. Without this, the assertion below is satisfied
    // by a detector that can never fire.
    const leaked = JSON.stringify({
      question: "total assets",
      evidence: { facts: { total_assets: SECRET_MINOR } },
    });
    expect(
      containsFigureOf(leaked, SECRET_MINOR),
      "CV-P1 CONTROL: the detector did not see a figure in an object built " +
        "to contain one. The zero-figure assertion below would then be " +
        "measuring nothing.",
    ).toBe(true);
  });

  it("an appended entry serializes without any figure, and the allowlist is complete", () => {
    // The entry the surface would build for a Tier-0 answer about a
    // 3,900 RON total-assets figure. The FIGURE never enters the entry —
    // that is the design — so the gate additionally tries to smuggle one
    // in through every channel an entry exposes.
    const smuggled = entry({
      question: `why is total assets ${SECRET_MINOR}`, // the USER's words — allowed
      artifacts: [
        {
          id: "e1",
          kind: "figures",
          titleKey: "canvas.artifact.figures",
          // A figure-shaped title param. `safeTitleParams` must drop it.
          titleParams: { scope: String(SECRET_MINOR), label: "December" },
        },
      ],
    });
    appendCanvasEntry(ORG, "t1", smuggled, 1_700_000_000_000);

    const raw = window.localStorage.getItem(canvasStorageKey(ORG)) ?? "";
    expect(raw.length, "CV-P1: nothing was written at all — the gate has no subject.").toBeGreaterThan(
      20,
    );

    // ── WHAT IS LEGITIMATELY ALLOWED TO CARRY DIGITS ───────────────
    //
    // Two fields, and only two: the reader's own QUESTION, quoted back
    // verbatim, and the thread TITLE derived from it. Both are the
    // user's words rendered as the user's words — C1 bans a MODEL digit
    // presented as a fact, not a quotation of the person who typed it.
    // Everything else in the payload is chrome and must be figure-free.
    //
    // Stripping them is what makes the assertion below mean "a VALUE
    // leaked" rather than "the user typed a number".
    const title = deriveCanvasTitle(smuggled.question);
    const withoutQuestion = raw
      .replace(JSON.stringify(smuggled.question), '""')
      .replace(JSON.stringify(title), '""');
    expect(
      containsFigureOf(withoutQuestion, SECRET_MINOR),
      `CV-P1: the serialized payload contains ${SECRET_MINOR} — a figure ` +
        `reached storage. Restoring it later would put a digit on screen ` +
        `whose provenance is "a browser once wrote this down", which is ` +
        `indistinguishable at the DOM from a digit a model typed.\n` +
        `payload: ${withoutQuestion}`,
    ).toBe(false);

    // The allowlist is the mechanism. Assert it covers exactly the
    // fields an entry has — a new numeric field added upstream must show
    // up here as a FAILURE, not as a silent write.
    const entryKeys = Object.keys(entry()).sort();
    expect(
      [...CANVAS_PERSISTED_KEYS].sort(),
      "CV-P1: CanvasEntry's fields and CANVAS_PERSISTED_KEYS have diverged. " +
        "Add the field to the allowlist deliberately, or leave it out " +
        "deliberately — but decide.",
    ).toEqual(entryKeys);
    expect(entryKeys.length).toBeGreaterThanOrEqual(8);
  });

  it("safeTitleParams keeps prose and a year, drops every other numeric shape", () => {
    // The BARE DIGIT RUN is the case this gate was born from: CV-P1 went
    // red on its first run because `looksLikeFigure("390000")` is false
    // (correctly, for an account-code label) and 390000 is an amount in
    // minor units. `isSafeTitleParam` is the stricter rule that closed it.
    const cases: [string, boolean][] = [
      ["December 2024", true],
      ["Trading division", true],
      ["390000", false],
      ["3,900", false],
      ["12.4%", false],
      ["461", false],
      ["RON 1.553.210", false],
    ];
    let checked = 0;
    for (const [value, want] of cases) {
      expect(isSafeTitleParam(value), `CV-P1: isSafeTitleParam("${value}")`).toBe(want);
      checked += 1;
    }
    expect(checked, "CV-P1: the param table is empty.").toBe(7);
    const out = safeTitleParams({ label: "December 2024", bad: "3,900", n: "12.4%", raw: "390000" });
    expect(out).toEqual({ label: "December 2024" });
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-P2 — a stale entry shows no figure
// ══════════════════════════════════════════════════════════════════════

describe("CV-P2 — liveness needs BOTH a matching scope and a live turn", () => {
  it("is live only when both halves hold", () => {
    const e = entry({ scope: scopeKey("p-dec") });
    const cases: { scope: string; live: boolean; expect: boolean; why: string }[] = [
      { scope: scopeKey("p-dec"), live: true, expect: true, why: "same period, turn in memory" },
      {
        scope: scopeKey("p-jan"),
        live: true,
        expect: false,
        why: "period moved on — December's answer over January's page",
      },
      {
        scope: scopeKey("p-dec"),
        live: false,
        expect: false,
        why: "restored record — the figures were never written down",
      },
      { scope: scopeKey("p-jan"), live: false, expect: false, why: "both" },
    ];
    let checked = 0;
    for (const c of cases) {
      expect(
        isEntryLive(e, c.scope, c.live),
        `CV-P2: an entry answered against ${e.scope} was reported ` +
          `${isEntryLive(e, c.scope, c.live) ? "LIVE" : "STALE"} under scope ` +
          `${c.scope} with hasLiveTurn=${c.live} (${c.why}).`,
      ).toBe(c.expect);
      checked += 1;
    }
    // FLOOR, after the loop (TC-3): a table that shrank to nothing must
    // fail rather than pass.
    expect(checked, "CV-P2: the case table is empty.").toBe(4);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-P3 — titles, budget, pins, attach
// ══════════════════════════════════════════════════════════════════════

describe("CV-P3 — derived titles", () => {
  it("strips openers, trims punctuation, caps on a word boundary", () => {
    const cases: [string, string][] = [
      ["what is total assets?", "Total assets"],
      ["can you build me a board pack for December", "Build me a board pack for December"],
      ["/chart revenue by month", "Revenue by month"],
      ["cât e cifra de afaceri?", "Cifra de afaceri"],
      ["", ""],
    ];
    let checked = 0;
    for (const [input, want] of cases) {
      expect(deriveCanvasTitle(input), `CV-P3: "${input}"`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(5);
    // Deterministic: same input, same output, always.
    expect(deriveCanvasTitle("what is total assets?")).toBe(
      deriveCanvasTitle("what is total assets?"),
    );
    // Long titles cap without cutting a word in half.
    const long = deriveCanvasTitle(
      "explain the movement in working capital across every month of the year",
    );
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith(" ")).toBe(false);
  });
});

describe("CV-P3 — the storage budget evicts rather than throwing", () => {
  it("drops the oldest thread when the payload exceeds the cap", () => {
    const big = "x".repeat(4000);
    const store = {
      version: 1,
      currentThreadId: null,
      threads: Array.from({ length: 80 }, (_, i) => ({
        id: `t${i}`,
        title: big,
        createdAt: i,
        updatedAt: i,
        entries: [entry({ id: `e${i}`, question: big })],
      })),
    };
    const fitted = fitToBudget(store);
    expect(
      fitted.threads.length,
      "CV-P3: nothing was evicted — the budget is not being applied.",
    ).toBeLessThan(80);
    expect(serializeStore(fitted).length).toBeLessThanOrEqual(192_000);
    // Newest survives, oldest goes.
    expect(fitted.threads[0].id).toBe("t79");
  });
});

describe("CV-P4 — a pin is a standing question, never a stored figure", () => {
  it("round-trips through storage carrying no value", () => {
    toggleCanvasPin(ORG, {
      id: "p1",
      question: "total assets",
      kind: "figures",
      titleKey: "canvas.artifact.figures",
      titleParams: { label: "December", leak: String(SECRET_MINOR) },
      pinnedAt: 1,
      threadId: "t1",
      entryId: "e1",
    });
    const pins = getCanvasPins(ORG);
    expect(pins.length).toBe(1);
    expect(isPinned(pins, "e1", "figures")).toBe(true);
    expect(pins[0].titleParams).toEqual({ label: "December" });

    const raw = window.localStorage.getItem("cfo-canvas-pins-v1:" + ORG) ?? "";
    expect(raw.length).toBeGreaterThan(20);
    expect(
      containsFigureOf(raw, SECRET_MINOR),
      "CV-P4: a pinned card carried a figure into storage. A pin recomputes " +
        "with the period; a pin that remembers a number is a screenshot " +
        "pretending to be live.",
    ).toBe(false);

    // Toggling off removes it.
    toggleCanvasPin(ORG, {
      id: "p1",
      question: "total assets",
      kind: "figures",
      titleKey: "canvas.artifact.figures",
      pinnedAt: 2,
      threadId: "t1",
      entryId: "e1",
    });
    expect(getCanvasPins(ORG).length).toBe(0);
  });
});

describe("CV-P4 — attach hands off exactly once", () => {
  it("is consuming, TTL'd, and filters by extension", () => {
    const file = new File(["x"], "balanta.xlsx");
    stageCanvasAttachment(file, 1000);
    expect(peekCanvasAttachment(1000)).toBe("balanta.xlsx");
    expect(takeCanvasAttachment(1000)?.name).toBe("balanta.xlsx");
    expect(
      takeCanvasAttachment(1000),
      "CV-P4: the staged file survived being taken. Two mounts of the " +
        "upload surface would both start an upload of the same document.",
    ).toBeNull();

    stageCanvasAttachment(file, 1000);
    expect(
      takeCanvasAttachment(1000 + ATTACH_TTL_MS + 1),
      "CV-P4: an expired staged file was still handed over.",
    ).toBeNull();

    expect(attachmentLooksSupported("balanta.xlsx")).toBe(true);
    expect(attachmentLooksSupported("photo.jpg")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-S1 / CV-S2 — slash commands
// ══════════════════════════════════════════════════════════════════════

describe("CV-S1 — the slash table", () => {
  it("parses every command, and the free/generative split is the recorded one", () => {
    let parsed = 0;
    let free = 0;
    let generative = 0;
    for (const c of CANVAS_SLASH_COMMANDS) {
      const p = parseCanvasSlash(`/${c.id} revenue`);
      expect(p, `CV-S1: /${c.id} did not parse.`).not.toBeNull();
      expect(p!.command.id).toBe(c.id);
      expect(p!.subject).toBe("revenue");
      expect(p!.ready).toBe(true);
      parsed += 1;
      if (c.generative) generative += 1;
      else free += 1;
    }
    // PER-COMPONENT floors, AFTER the loop. A table that lost five of
    // six commands would still satisfy "no violations"; it cannot
    // satisfy these.
    expect(parsed, "CV-S1: the command table is empty — DISCOVERY BROKEN.").toBe(6);
    expect(
      free,
      `CV-S1: ${free} of 6 commands are engine-only; the recorded ` +
        `expectation is 5 free and 1 generative. A command that quietly ` +
        `became generative starts spending on a shortcut that promised not to.`,
    ).toBe(5);
    expect(generative).toBe(1);
    // The CANARY: a named command that must exist.
    expect(
      CANVAS_SLASH_COMMANDS.map((c) => c.id),
      "CV-S1: DISCOVERY BROKEN — the canary command /chart is absent.",
    ).toContain("chart");
  });

  it("a command with no subject is not ready, and an unknown one is not a command", () => {
    expect(parseCanvasSlash("/chart")!.ready).toBe(false);
    expect(parseCanvasSlash("/export")!.ready).toBe(true); // needsSubject: false
    expect(parseCanvasSlash("/nosuch")).toBeNull();
    expect(parseCanvasSlash("/")).toBeNull();
    expect(parseCanvasSlash("chart revenue")).toBeNull();
  });
});

describe("CV-S2 — the slash menu", () => {
  it("lists all on '/', narrows on a prefix, and closes once a word is committed", () => {
    expect(canvasSlashMenu("/").length).toBe(6);
    expect(canvasSlashMenu("/c").map((c) => c.id)).toEqual(["chart", "compare"]);
    expect(canvasSlashMenu("/chart ").length).toBe(0);
    expect(canvasSlashMenu("revenue").length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-PL1 — plans
// ══════════════════════════════════════════════════════════════════════

describe("CV-PL1 — plans are deterministic and free", () => {
  it("claims the shapes it names, refuses everything else, and never spends", () => {
    let claimed = 0;
    for (const entryDef of CANVAS_PLANS) {
      for (const trig of entryDef.triggers) {
        const got = planFor(`please ${trig} for december`);
        expect(got, `CV-PL1: "${trig}" claimed no plan.`).not.toBeNull();
        claimed += 1;
      }
      expect(
        planIsGenerative(entryDef.plan),
        `CV-PL1: plan "${entryDef.plan.id}" has a generative step. Every ` +
          `shipped plan is engine reads arranged — a generative one would ` +
          `spend on work the engine already does.`,
      ).toBe(false);
      // PER-PLAN floor: a plan that lost its steps would still "claim".
      expect(
        entryDef.plan.steps.length,
        `CV-PL1: plan "${entryDef.plan.id}" has fewer than 3 steps.`,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(claimed, "CV-PL1: DISCOVERY BROKEN — no trigger claimed a plan.").toBeGreaterThanOrEqual(
      14,
    );

    expect(planFor("total assets")).toBeNull();
    expect(planFor("")).toBeNull();

    // ── THE ORDERING RULE, ON A CASE THAT CAN SEE IT BREAK ─────────
    //
    // The first draft asserted `planFor("build me a board pack")` was
    // stable and equal to "board_pack". It was, and it stayed green with
    // the longest-wins rule REPLACED by first-match — because for every
    // input it tested, the two rules agree. A plant that produces no red
    // is not evidence (TC-2), so the assertion moved to an input where
    // the rules disagree:
    //
    //   "board pack"  → board_pack   (10 chars, and FIRST in the table)
    //   "full review" → period_review (11 chars, and second)
    //
    // A query carrying both must resolve to period_review under
    // longest-wins and to board_pack under first-match. Re-planted after
    // this change: first-match → RED, naming both plans.
    const ambiguous = "board pack for the full review";
    const a = planFor(ambiguous);
    const b = planFor(ambiguous);
    expect(a?.id, "CV-PL1: planFor is not a function of its input.").toBe(b?.id);
    expect(
      a?.id,
      `CV-PL1: "${ambiguous}" carries triggers for BOTH plans. The longest ` +
        `trigger ("full review", 11) must win over the shorter one that ` +
        `appears first in the table ("board pack", 10). Got ${a?.id}. ` +
        `First-match ordering makes the plan depend on table position, ` +
        `which is not reproducible from the reader's point of view.`,
    ).toBe("period_review");
    expect(planFor("build me a board pack")?.id).toBe("board_pack");
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-P5 — the store is per workspace
// ══════════════════════════════════════════════════════════════════════

describe("CV-P5 — threads do not cross workspaces", () => {
  it("a second org sees none of the first org's threads", () => {
    appendCanvasEntry("org-a", "t1", entry(), 1);
    expect(getCanvasStore("org-a").threads.length).toBe(1);
    expect(
      getCanvasStore("org-b").threads.length,
      "CV-P5: one company's conversation appeared inside another's " +
        "workspace. Same reasoning that splits company preferences from " +
        "personal ones — this is not a cosmetic bug.",
    ).toBe(0);
  });
});
