// Data-borne jargon → <Term> (the gates lane's HIGH finding, closed).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { annotateTerms } from "../annotateTerms";

function wrap(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe("annotateTerms", () => {
  it("wraps known engine jargon in <Term>, verbatim label", () => {
    wrap(<p>{annotateTerms("Stand up monthly DSCR / Debt-EBITDA monitoring")}</p>);
    const dscr = document.querySelector('[data-term="dscr"]');
    expect(dscr).not.toBeNull();
    expect(dscr!.textContent).toBe("DSCR");
    expect(document.querySelector('[data-term="ebitda"]')).not.toBeNull();
    // The rest of the sentence is untouched.
    expect(screen.getByText(/monitoring/)).toBeInTheDocument();
  });

  it("phrases beat their substrings and casing is preserved", () => {
    wrap(<p>{annotateTerms("Working capital tightened; margin held.")}</p>);
    const wc = document.querySelector('[data-term="working_capital"]');
    expect(wc!.textContent).toBe("Working capital");
    expect(document.querySelector('[data-term="margin"]')!.textContent).toBe("margin");
  });

  it("only the FIRST occurrence of a term gets the affordance", () => {
    wrap(<p>{annotateTerms("EBITDA rose; EBITDA margin fell.")}</p>);
    expect(document.querySelectorAll('[data-term="ebitda"]').length).toBe(1);
  });

  it("unknown jargon stays verbatim with NO affordance — never fake", () => {
    wrap(<p>{annotateTerms("WACC drifted 40bps")}</p>);
    expect(document.querySelector("[data-term]")).toBeNull();
    expect(screen.getByText(/WACC drifted 40bps/)).toBeInTheDocument();
  });

  it("absent input renders nothing", () => {
    expect(annotateTerms(null)).toBeNull();
    expect(annotateTerms("")).toBeNull();
  });

  it("Romanian surface forms resolve too", () => {
    wrap(<p>{annotateTerms("Datoria netă a scăzut, lichiditate bună.")}</p>);
    expect(document.querySelector('[data-term="net_debt"]')).not.toBeNull();
    expect(document.querySelector('[data-term="liquidity"]')).not.toBeNull();
  });
});
