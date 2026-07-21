// Phase 5 — Pro inquiry form.
//
// Captures qualification info (role, num companies analyzed, use case) and
// POSTs to /api/contact-sales. Backend persists to `contact_sales_leads`,
// sends an owner email, and auto-replies to the lead.
//
// No-pressure language; the spec is explicit that this is a conversation,
// not a funnel.

import { useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "@/components/cfo/Logo";
import { ThemeToggle } from "@/components/cfo/ThemeToggle";
import { useToast } from "@/hooks/use-toast";
import { SITE } from "@/config/site";

interface FormState {
  name: string;
  email: string;
  company: string;
  role: string;
  num_companies: string;
  use_case: string;
  preferred_contact: "email" | "phone" | "video_call";
  phone: string;
}

const INITIAL: FormState = {
  name: "",
  email: "",
  company: "",
  role: "",
  num_companies: "",
  use_case: "",
  preferred_contact: "email",
  phone: "",
};

export default function ContactSalesPage() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.email.includes("@")) {
      toast({
        title: "Missing fields",
        description: "Please share your name and a valid email so we can reply.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    const apiUrl =
      (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
    try {
      const r = await fetch(`${apiUrl}/api/contact-sales`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(await r.text());
      setDone(true);
    } catch (err) {
      toast({
        title: "Couldn't send",
        description:
          `Please email ${SITE.supportEmail} directly — we'll get back to you within 4 business hours.`,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header className="px-6 sm:px-10 py-5 flex items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-3">
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule">
            Contact Sales
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle compact />
          <Link to="/pricing" className="text-[13px] text-ink-soft hover:text-ink">
            Pricing
          </Link>
          <Link to="/" className="text-[13px] text-ink-soft hover:text-ink">
            Home
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-[640px] px-5 sm:px-8 py-12">
        <h1 className="text-[32px] sm:text-[38px] tracking-tight text-ink">
          Let's talk Professional
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft">
          Tell us about your workflow. We'll reply within 4 business hours with
          a tailored proposal — no high-pressure pitch.
        </p>

        {done ? (
          <div className="mt-8 rounded-xl border border-[#5CD3C5]/30 bg-[#5CD3C5]/5 p-6">
            <h2 className="text-[18px] font-semibold text-ink">
              Got it — talk soon
            </h2>
            <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed">
              We've logged your inquiry and sent you a confirmation email. In
              the meantime, you're welcome to try Solo or Business with the
              €1 first month offer.
            </p>
            <div className="mt-4 flex gap-3">
              <Link
                to="/pricing"
                className="px-3 py-1.5 rounded-lg border border-rule text-[13px] hover:bg-surface-hover"
              >
                Back to pricing
              </Link>
              <Link
                to="/"
                className="px-3 py-1.5 rounded-lg bg-ink text-bg text-[13px] hover:bg-ink/90"
              >
                Home
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <Field
              label="Your name"
              required
              value={form.name}
              onChange={(v) => setForm({ ...form, name: v })}
            />
            <Field
              label="Work email"
              type="email"
              required
              value={form.email}
              onChange={(v) => setForm({ ...form, email: v })}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label="Company"
                value={form.company}
                onChange={(v) => setForm({ ...form, company: v })}
              />
              <Field
                label="Your role"
                placeholder="Partner, CFO, Senior accountant…"
                value={form.role}
                onChange={(v) => setForm({ ...form, role: v })}
              />
            </div>

            <label className="block">
              <span className="text-[12.5px] text-ink-soft">
                How many companies do you analyze regularly?
              </span>
              <select
                value={form.num_companies}
                onChange={(e) =>
                  setForm({ ...form, num_companies: e.target.value })
                }
                className="mt-1 w-full rounded-lg border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink"
              >
                <option value="">Choose…</option>
                <option value="1-3">1-3</option>
                <option value="4-10">4-10</option>
                <option value="11-25">11-25</option>
                <option value="26+">26+</option>
              </select>
            </label>

            <label className="block">
              <span className="text-[12.5px] text-ink-soft">
                What's your main use case?
              </span>
              <textarea
                value={form.use_case}
                onChange={(e) => setForm({ ...form, use_case: e.target.value })}
                rows={4}
                placeholder="e.g., monthly reporting for 8 SME clients, due diligence on acquisition targets, family-group consolidated view…"
                className="mt-1 w-full rounded-lg border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink resize-y"
              />
            </label>

            <label className="block">
              <span className="text-[12.5px] text-ink-soft">
                Preferred contact
              </span>
              <select
                value={form.preferred_contact}
                onChange={(e) =>
                  setForm({
                    ...form,
                    preferred_contact: e.target.value as FormState["preferred_contact"],
                  })
                }
                className="mt-1 w-full rounded-lg border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink"
              >
                <option value="email">Email</option>
                <option value="phone">Phone call</option>
                <option value="video_call">Video call (Google Meet)</option>
              </select>
            </label>

            {form.preferred_contact !== "email" && (
              <Field
                label="Phone"
                type="tel"
                value={form.phone}
                onChange={(v) => setForm({ ...form, phone: v })}
              />
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full mt-2 py-3 rounded-lg bg-ink text-bg text-[14px] font-medium hover:bg-ink/90 transition-colors disabled:opacity-60"
            >
              {submitting ? "Sending…" : "Send"}
            </button>
            <p className="text-[11.5px] text-ink-soft text-center">
              By submitting, you agree we'll email you about Professional.
              We don't share your data with anyone.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}

function Field({
  label,
  type = "text",
  placeholder,
  required,
  value,
  onChange,
}: {
  label: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[12.5px] text-ink-soft">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </span>
      <input
        type={type}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink"
      />
    </label>
  );
}
