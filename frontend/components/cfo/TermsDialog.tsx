// Terms of Service modal — opened from the signup consent checkbox.
//
// Renders lib/legalTerms.ts. The marketing site's /#/terms page shows the
// same text; this exists so a user can read what they're agreeing to
// WITHOUT leaving a half-filled signup form (navigating away loses the
// email, password and company name they've already typed).

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TERMS_EFFECTIVE,
  TERMS_PLACEHOLDER_WARNING,
  TERMS_SECTIONS,
} from "@/lib/legalTerms";

export function TermsDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px]" data-testid="terms-dialog">
        <DialogHeader>
          <DialogTitle>Terms of Service</DialogTitle>
          <DialogDescription>
            Effective {TERMS_EFFECTIVE}. {TERMS_PLACEHOLDER_WARNING}
          </DialogDescription>
        </DialogHeader>

        {/* Capped + scrollable so the dialog never runs past the viewport on
            a laptop — the whole document is ~11 sections. */}
        <div className="max-h-[60vh] overflow-y-auto chat-scroll -mx-1 px-1">
          {TERMS_SECTIONS.map((s) => (
            <section key={s.heading} className="mb-5 last:mb-0">
              <h3 className="text-[13.5px] font-semibold text-ink">{s.heading}</h3>
              {s.body.map((p, i) => (
                <p key={i} className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
