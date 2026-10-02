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
import { useTranslation } from "react-i18next";
import { Logo } from "@/components/cfo/Logo";
import { useToast } from "@/hooks/use-toast";
import { SITE } from "@/config/site";
import { PLAN_PRICES_EUR, formatPrice } from "@/lib/price";

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
  // Every word is the dictionary's (`contactSales.*`, both languages). The
  // page was English-only until 2026-10-02 and promised a reply "within 4
  // business hours" — a service level nothing in the product measures.
  const { t, i18n } = useTranslation();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.email.includes("@")) {
      toast({
        title: t("contactSales.missingTitle"),
        description: t("contactSales.missingBody"),
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
        title: t("contactSales.failedTitle"),
        description: t("contactSales.failedBody", { email: SITE.supportEmail }),
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
            {t("contactSales.eyebrow")}
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <Link to="/pricing" className="text-[13px] text-ink-soft hover:text-ink">
            {t("contactSales.navPricing")}
          </Link>
          <Link to="/" className="text-[13px] text-ink-soft hover:text-ink">
            {t("contactSales.navHome")}
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-[640px] px-5 sm:px-8 py-12">
        <h1 className="text-[32px] sm:text-[38px] tracking-tight text-ink">
          {/* Named a "Professional" plan until 2026-09-08. _pricing_config.py
              sells trial / intro / starter / RO Solo / Pro / Multi-Country;
              "Professional" and "Business" are legacy ALIASES, not products,
              and this page is public and linked from /roadmap. */}
          {t("contactSales.title")}
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft">
          {t("contactSales.sub")}
        </p>

        {done ? (
          <div className="mt-8 rounded-xl border border-brand/30 bg-brand/5 p-6">
            <h2 className="text-[18px] font-semibold text-ink">
              {t("contactSales.doneTitle")}
            </h2>
            <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed">
              {t("contactSales.doneBody", {
                introPrice: formatPrice(PLAN_PRICES_EUR.intro, i18n.language),
              })}
            </p>
            <div className="mt-4 flex gap-3">
              <Link
                to="/pricing"
                className="px-3 py-1.5 rounded-lg border border-rule text-[13px] hover:bg-surface-hover"
              >
                {t("contactSales.backToPricing")}
              </Link>
              <Link
                to="/"
                className="px-3 py-1.5 rounded-lg bg-ink text-bg text-[13px] hover:bg-ink/90"
              >
                {t("contactSales.navHome")}
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <Field
              label={t("contactSales.name")}
              required
              value={form.name}
              onChange={(v) => setForm({ ...form, name: v })}
            />
            <Field
              label={t("contactSales.email")}
              type="email"
              required
              value={form.email}
              onChange={(v) => setForm({ ...form, email: v })}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label={t("contactSales.company")}
                value={form.company}
                onChange={(v) => setForm({ ...form, company: v })}
              />
              <Field
                label={t("contactSales.role")}
                placeholder={t("contactSales.rolePlaceholder")}
                value={form.role}
                onChange={(v) => setForm({ ...form, role: v })}
              />
            </div>

            <label className="block">
              <span className="text-[12.5px] text-ink-soft">
                {t("contactSales.numCompanies")}
              </span>
              <select
                value={form.num_companies}
                onChange={(e) =>
                  setForm({ ...form, num_companies: e.target.value })
                }
                className="mt-1 w-full rounded-lg border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink"
              >
                <option value="">{t("contactSales.choose")}</option>
                <option value="1-3">1-3</option>
                <option value="4-10">4-10</option>
                <option value="11-25">11-25</option>
                <option value="26+">26+</option>
              </select>
            </label>

            <label className="block">
              <span className="text-[12.5px] text-ink-soft">
                {t("contactSales.useCase")}
              </span>
              <textarea
                value={form.use_case}
                onChange={(e) => setForm({ ...form, use_case: e.target.value })}
                rows={4}
                placeholder={t("contactSales.useCasePlaceholder")}
                className="mt-1 w-full rounded-lg border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink resize-y"
              />
            </label>

            <label className="block">
              <span className="text-[12.5px] text-ink-soft">
                {t("contactSales.preferred")}
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
                <option value="email">{t("contactSales.byEmail")}</option>
                <option value="phone">{t("contactSales.byPhone")}</option>
                <option value="video_call">{t("contactSales.byVideo")}</option>
              </select>
            </label>

            {form.preferred_contact !== "email" && (
              <Field
                label={t("contactSales.phone")}
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
              {submitting ? t("contactSales.sending") : t("contactSales.send")}
            </button>
            <p className="text-[11.5px] text-ink-soft text-center">
              {t("contactSales.consent")}
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
