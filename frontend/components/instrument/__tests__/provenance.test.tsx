// THE AFFORDANCE, MEASURED — hover, focus, Escape, and the refusal.
//
// The claim "it works on hover and on focus and dismisses with Escape"
// is three separate behaviours from a third-party primitive. Reading
// Radix's source and asserting the wiring is not the same as watching
// the card appear and disappear, so each one is DRIVEN here: an event
// goes in, the card's own text is asserted out.
//
// The refusal half matters at least as much. A card that appears over a
// payload carrying nothing is the defect this lane exists to remove, so
// an empty object, a null and a period-only payload are each planted and
// each expected to render plain.
//
// And the OTHER refusal: a payload can be complete and true while the
// FIGURE it describes is absent from this envelope. The affordance used
// to open a full card over "—" because it never saw the value (critic
// finding #2, commit ea6df1f). Now the value is a required prop, and a
// null / undefined / non-finite figure renders plain whatever the
// payload says — planted below with the fullest payload this file has.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ProvenanceAffordance,
  hasProvenance,
  isAbsentFigure,
  provenanceOf,
} from "../Provenance";

// Radix's Popper positions through floating-ui, which needs both of
// these; jsdom ships neither. Stubbed locally rather than in the shared
// setup file so nothing else in the suite changes behaviour.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!("DOMRect" in globalThis)) {
    (globalThis as unknown as { DOMRect: unknown }).DOMRect = class {
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0,
      ) {}
      get top() { return this.y; }
      get left() { return this.x; }
      get right() { return this.x + this.width; }
      get bottom() { return this.y + this.height; }
      static fromRect() { return new (globalThis as never as { DOMRect: new () => unknown }).DOMRect(); }
      toJSON() { return {}; }
    };
  }
});

const FULL = {
  source: "sheet Anon_2bb7638cfd",
  accounts: "2131, 2132, 2133",
  period: "FY 2025",
  method: "deterministic",
  pack: "ro_omfp1802_v2",
  snapshot: "sv1",
};

const PRESENT = 66_280_871.31;

// An OPTIONS object, not a defaulted positional: `mount(FULL, undefined)`
// against a defaulted parameter silently mounts the default, so the
// undefined case was never planted at all (measured — the assertion went
// red on a rendered affordance). An explicit key survives the call.
function mount(
  p: Parameters<typeof ProvenanceAffordance>[0]["provenance"],
  opts: { value: number | null | undefined } = { value: PRESENT },
) {
  const { value } = opts;
  return render(
    <TooltipProvider>
      <ProvenanceAffordance provenance={p} value={value} exact="66.280.871,31 RON">
        <span>{isAbsentFigure(value) ? "—" : "66,3 M"}</span>
      </ProvenanceAffordance>
    </TooltipProvider>,
  );
}

function trigger() {
  const el = document.querySelector('[data-provenance="true"]');
  if (!el) throw new Error("no affordance rendered");
  return el as HTMLElement;
}

describe("the affordance opens on HOVER", () => {
  it("a pointer over the figure reveals the source", async () => {
    mount(FULL);
    fireEvent.pointerMove(trigger());
    // delayDuration is 150ms — waitFor polls past it rather than the
    // test asserting on the same tick and calling a race a pass.
    await waitFor(() =>
      expect(screen.getAllByText("sheet Anon_2bb7638cfd").length).toBeGreaterThan(0),
    );
  });
});

describe("the affordance opens on FOCUS — a keyboard user gets the same thing", () => {
  // MEASURED, not assumed: deleting `tabIndex={0}` from the trigger was
  // planted and only THIS assertion went red. The two `fireEvent.focus`
  // tests below stayed green, because dispatching a focus event at a
  // span works whether or not a keyboard could ever put focus there.
  // So the reachability half of "it works on focus" is guarded here and
  // nowhere else — the behavioural tests alone would have passed over a
  // figure no keyboard user can reach.
  it("the figure is reachable by keyboard", () => {
    mount(FULL);
    expect(trigger().getAttribute("tabindex")).toBe("0");
  });

  it("focusing it reveals the same card, with no delay", async () => {
    mount(FULL);
    fireEvent.focus(trigger());
    await waitFor(() =>
      expect(screen.getAllByText("2131, 2132, 2133").length).toBeGreaterThan(0),
    );
  });
});

describe("the affordance dismisses with ESCAPE", () => {
  it("Escape closes a card opened by focus", async () => {
    mount(FULL);
    fireEvent.focus(trigger());
    await waitFor(() =>
      expect(screen.getAllByText("ro_omfp1802_v2").length).toBeGreaterThan(0),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("ro_omfp1802_v2")).toBeNull());
  });
});

describe("only the fields the payload carries are rendered", () => {
  it("a payload with a source and nothing else names no pack and no snapshot", async () => {
    mount({ source: "10-K" });
    fireEvent.focus(trigger());
    await waitFor(() => expect(screen.getAllByText("10-K").length).toBeGreaterThan(0));
    // No placeholder for an absent field — a card that lists "Pack —"
    // has invented a fact about the pack.
    expect(screen.queryByText(/Pack/)).toBeNull();
    expect(screen.queryByText(/Snapshot/i)).toBeNull();
    expect(screen.queryByText(/Accounts/)).toBeNull();
  });
});

describe("NEVER FAKE IT — the refusals", () => {
  it("an empty payload renders the figure plain", () => {
    mount({});
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
    expect(screen.getByText("66,3 M")).toBeInTheDocument();
  });

  it("a null payload renders the figure plain", () => {
    mount(null);
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
  });

  it("a PERIOD alone is not provenance", () => {
    // Every fact in the index carries a period label. If a period bought
    // the affordance, every figure in the product would wear it and none
    // of them would be saying anything — which is precisely how the
    // affordance stops meaning something. This was a live defect in
    // CapsuleTier0Preview: `{ source: fact.periodLabel }` put "FY 2025"
    // in a field the card labels "Source".
    mount({ period: "FY 2025" });
    expect(hasProvenance({ period: "FY 2025" })).toBe(false);
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
  });

  it("whitespace is not substance", () => {
    expect(provenanceOf({ source: "   ", pack: "" })).toBeNull();
    expect(hasProvenance({ source: "" })).toBe(false);
  });

  it("provenanceOf keeps what is real and drops what is empty", () => {
    const p = provenanceOf({
      source: "sheet Balanta",
      accounts: "",
      period: "FY 2025",
      pack: undefined,
      confidence: Number.NaN,
    });
    expect(p).toEqual({ source: "sheet Balanta", period: "FY 2025" });
  });
});

describe("A CARD NEEDS A FIGURE — the absent refusals", () => {
  // The fullest payload this file has, over a figure that is not there.
  // Before 2026-09-04 this opened a card reading Source / Accounts /
  // Period / Method / Pack / snapshot over a dash.
  it("a full payload over a NULL figure renders the dash plain", () => {
    mount(FULL, { value: null });
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("undefined, NaN and ±Infinity are absent too", () => {
    for (const v of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { unmount } = mount(FULL, { value: v });
      expect(document.querySelector('[data-provenance="true"]'), String(v)).toBeNull();
      unmount();
    }
  });

  it("`absent` refuses explicitly, for a caller with no single number to hand over", () => {
    render(
      <TooltipProvider>
        <ProvenanceAffordance provenance={FULL} value={1} absent>
          <span>1–2 M</span>
        </ProvenanceAffordance>
      </TooltipProvider>,
    );
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
    expect(screen.getByText("1–2 M")).toBeInTheDocument();
  });

  it("a real ZERO is a figure — it keeps its card", async () => {
    // The positive control beside the refusals: a refusal-of-everything
    // would pass the three tests above and fail this one.
    mount(FULL, { value: 0 });
    fireEvent.focus(trigger());
    await waitFor(() =>
      expect(screen.getAllByText("sheet Anon_2bb7638cfd").length).toBeGreaterThan(0),
    );
  });

  it("isAbsentFigure is the same rule the affordance applies", () => {
    expect(isAbsentFigure(null)).toBe(true);
    expect(isAbsentFigure(undefined)).toBe(true);
    expect(isAbsentFigure(Number.NaN)).toBe(true);
    expect(isAbsentFigure(Number.POSITIVE_INFINITY)).toBe(true);
    expect(isAbsentFigure(0)).toBe(false);
    expect(isAbsentFigure(-1.5)).toBe(false);
  });
});

// ── AN ABSENT FIELD YIELDS NO ROW ──────────────────────────────────────
//
// THE HOLE THIS CLOSES. The witness above ("only the fields the payload
// carries are rendered") drives ONE payload — a full one — and checks
// three labels are missing from a source-only card. Nothing asserted the
// general rule, so the card could invent a value for any field and stay
// green. MEASURED: changing line 176 of Provenance.tsx from
//
//     {p.period && <Row label="Period">{p.period}</Row>}
// to  {p.period ?? "FY 2025"}
//
// labels a 2023 sheet's figure "FY 2025" in the card, and the whole unit
// suite plus the provenance census stayed GREEN. The same edit works on
// Source, and on every other field.
//
// The file's own header states the rule this enforces: "Fields render
// ONLY when present. There is no '—' for an absent field and no
// 'unknown': a card that lists Pack with a dash has invented a fact
// about the pack." A rule stated in a comment and asserted nowhere is a
// rule the next edit deletes.
//
// Two assertions per field, because either alone is escapable:
//   1. LEAVE-ONE-OUT — drop exactly one field from a full payload; that
//      field's own value must vanish from the card. Catches a plant that
//      substitutes a plausible constant.
//   2. CLOSURE — a minimal payload's card must contain EXACTLY the text
//      its payload justifies, character for character. Catches a plant
//      that invents ANY text, including one no leave-one-out probe
//      guessed.

const CARD_FIELDS = [
  "source",
  "accounts",
  "period",
  "method",
  "confidence",
  "pack",
  "computedAt",
  "snapshot",
] as const;

const FULL_CARD: Record<string, string | number> = {
  source: "sheet Anon_2bb7638cfd",
  accounts: "2131, 2132, 2133",
  period: "FY 2025",
  method: "deterministic",
  confidence: 0.97,
  pack: "ro_omfp1802_v2",
  computedAt: "2026-09-04T10:00:00Z",
  snapshot: "sv1",
};

/** The rendered card's text, whitespace-normalised. Radix portals the
 *  content, so this reads the whole document rather than the container
 *  the render call returned. */
function cardText(): string {
  const nodes = Array.from(document.querySelectorAll('[role="tooltip"]'));
  const el = nodes.length > 0 ? nodes[nodes.length - 1] : null;
  if (!el) throw new Error("no provenance card is open");
  return (el.textContent ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

async function openCard(p: Record<string, unknown>) {
  mount(p as Parameters<typeof mount>[0]);
  fireEvent.focus(trigger());
  await waitFor(() => {
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  });
}

describe("AN ABSENT FIELD YIELDS NO ROW — the card never invents a fact", () => {
  for (const field of CARD_FIELDS) {
    it(`drops '${field}' entirely when the payload does not carry it`, async () => {
      const partial: Record<string, string | number> = { ...FULL_CARD };
      delete partial[field];
      await openCard(partial);
      const text = cardText();

      // 1. LEAVE-ONE-OUT: the omitted field's own value is gone.
      const omitted =
        field === "confidence" ? "97%" : String(FULL_CARD[field]);
      expect(
        text,
        `THE CARD INVENTED A FACT — '${field}' was absent from the payload, ` +
          `but the card still renders ${JSON.stringify(omitted)}. A figure ` +
          `read off a 2023 sheet must never be labelled with a period, a ` +
          `source or a pack that nobody supplied. Render nothing instead.`,
      ).not.toContain(omitted);

      // 2. Its LABEL is gone too — a label with no value is still a claim
      //    that the field exists.
      const label = {
        source: "Source",
        accounts: "Accounts",
        period: "Period",
        method: "Method",
        confidence: "%",
        pack: "Pack",
        computedAt: "computed",
        snapshot: "snapshot",
      }[field];
      expect(
        text,
        `the card kept the '${field}' label (${label}) with the field ` +
          `absent — an empty row is still an invented fact.`,
      ).not.toContain(label);

      // 3. Every field that IS present still renders, so the assertions
      //    above cannot pass by rendering an empty card (TC-9).
      //    `confidence` is the one exception and it is a REAL dependency,
      //    not a carve-out: it has no Row of its own and renders inside
      //    Method, so with `method` absent a confidence score must not
      //    surface — a verification percentage with nothing naming what
      //    was verified is itself an invented fact. Asserted positively
      //    by "confidence renders only alongside the method" below.
      for (const other of CARD_FIELDS) {
        if (other === field) continue;
        if (field === "method" && other === "confidence") continue;
        const shown =
          other === "confidence" ? "97%" : String(FULL_CARD[other]);
        expect(
          text,
          `NO SUBJECT — '${other}' WAS in the payload but is missing from ` +
            `the card, so the absence assertions above prove nothing.`,
        ).toContain(shown);
      }
    });
  }

  it("a minimal payload's card contains EXACTLY what the payload justifies", async () => {
    // Closure: not "these labels are missing" but "nothing else is here".
    // A plant that invents any text at all — a period, a source, a dash,
    // an "unknown" — changes this string.
    await openCard({ source: "10-K" });
    expect(
      cardText(),
      "THE CARD RENDERED TEXT THE PAYLOAD DOES NOT JUSTIFY. Every " +
        "character in the card must come from the payload (or from the " +
        "`exact` spelling the caller passed). Anything else is invented.",
    ).toBe("66.280.871,31 RONSource 10-K");
  });

  it("a payload of accounts alone names no source, no period and no pack", async () => {
    await openCard({ accounts: "2131, 2132, 2133" });
    expect(cardText()).toBe("66.280.871,31 RONAccounts 2131, 2132, 2133");
  });

  it("confidence renders only alongside the method that earned it", async () => {
    // confidence is the one field with no Row of its own — it rides
    // inside Method. With method absent it must not surface anywhere.
    await openCard({ source: "10-K", confidence: 0.97 });
    expect(
      cardText(),
      "a confidence score rendered with no method to qualify it — the " +
        "number claims a verification that nothing in the payload names.",
    ).toBe("66.280.871,31 RONSource 10-K");
  });
});
