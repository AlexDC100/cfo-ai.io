// IndustryConfirmBanner — "the account mix looks like X; this workspace
// is set to Y — confirm".
//
// Rendered when the served `industry_signal` says the structural reading
// and `organizations.industry_key` are in different FAMILIES. It names
// BOTH, lists the accounts the reading rests on with their balances and
// shares, and links to the one place the disagreement can be resolved.
//
// It is a prompt, not a verdict on the user: the account mix can be read
// wrong (a group company booking a rental arm through 706 on a
// manufacturer's ledger, a developer using 331 for buildings held for
// sale). The user confirms; the report does not decide.
//
// While it is up, the report's sector-calibrated content is not rendered
// — see `blocksSectorContent`. Everything not calibrated by sector (the
// statements, the ratios, the cash walk, the credit score) still
// renders: a disputed industry must not blank a report that is mostly
// sector-independent.

import { Link } from "react-router-dom";

import { Panel } from "@/components/instrument/Panel";
import {
  firedMarkers,
  leadingCandidate,
  type IndustrySignal,
} from "@/lib/industrySignal";

export function IndustryConfirmBanner({ signal }: { signal: IndustrySignal }) {
  const lead = leadingCandidate(signal);
  const evidence = firedMarkers(lead);
  const mixDisplay = signal.display ?? lead?.display ?? "an unreadable account mix";
  const setTo = signal.workspace.display ?? signal.workspace.industry_key ?? "no industry";

  return (
    <Panel
      data-testid="industry-confirm-banner"
      className="border-l-[3px] border-l-caution px-4 py-3.5 mb-6"
    >
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">
        Confirm the industry before the sector view is applied
      </div>
      <p className="text-[13px] text-ink leading-relaxed">
        The account mix looks like{" "}
        <span data-testid="industry-signal-family" className="font-medium">{mixDisplay}</span>
        ; this workspace is set to{" "}
        <span data-testid="industry-workspace-setting" className="font-medium">{setTo}</span>
        {" "}— confirm which is right.
      </p>
      <p className="mt-2 text-[12.5px] text-ink-soft leading-relaxed">
        Until then this report does not show anything calibrated by sector:
        no sector benchmark, no finding that is gated on an industry profile,
        and no sector wording in the narrative. Every figure that does not
        depend on the sector — the statements, the ratios, the cash walk and
        the credit score — is unaffected and still below.
      </p>

      {evidence.length > 0 && (
        <div className="mt-3">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">
            What the account mix says
          </div>
          <ul className="space-y-1.5" data-testid="industry-signal-evidence">
            {evidence.map((m) => (
              <li key={m.key} className="text-[12.5px] text-ink-soft leading-relaxed">
                <span className="text-ink">{m.statement}</span>
                {m.accounts.length > 0 && (
                  <span className="block text-ink-mute font-mono tabular-nums text-[11.5px]">
                    {m.accounts
                      .map((a) => `${a.code} ${a.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
                      .join("  ·  ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11.5px] text-ink-mute leading-relaxed">
            Read from the account codes only, so it names a family, not a
            sub-sector: {signal.cannot_resolve}
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 print:hidden">
        <Link
          to="/workspace"
          data-testid="industry-confirm-resolve"
          className="inline-flex items-center h-8 px-3 rounded-md bg-ink text-paper text-[12.5px] font-medium hover:bg-ink/90 transition-colors duration-micro"
        >
          Set the industry for this workspace
        </Link>
        <span className="text-[11.5px] text-ink-mute">
          Confirming the current setting re-enables the sector view.
        </span>
      </div>
    </Panel>
  );
}
