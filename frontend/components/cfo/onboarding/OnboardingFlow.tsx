// First-run onboarding — the "Terminal" treatment (design 1b): dark,
// mono-forward, instrument readouts. Four instruction slides, then sign in
// or explore. See lib/onboarding.ts for when it plays.
//
// Colours are the treatment's own fixed dark palette (it looks the same on
// Paper and Terminal), defined as `.ob-*` classes in index.css — the token
// sheet is the one place hex may live.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";

import { useAuth } from "@/lib/auth";
import { isNativeShell } from "@/lib/nativeShell";
import {
  closeOnboarding,
  getOnboardingOpen,
  markOnboardingSeen,
  subscribeOnboarding,
} from "@/lib/onboarding";
import { reportThemeToShell } from "@/theme/reportThemeToShell";

const SLIDES = 4;
type T = (key: string) => string;

function Mark() {
  return (
    <svg viewBox="0 0 64 64" width="22" height="22" aria-label="CFO AI">
      <path className="ob-fill-accent" d="M 30 4 L 4 20 L 4 44 L 30 60 L 30 50 L 14 41 L 14 23 L 30 14 Z" />
      <path className="ob-fill-ink" d="M 38 14 L 60 60 L 48 60 L 38 38 Z" />
      <rect className="ob-fill-ink" x="34" y="34" width="14" height="3" />
    </svg>
  );
}

function GoogleGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true" className="ob-fill-deep">
      <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.614z" />
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path opacity=".7" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path opacity=".55" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}

const fade = (delay: number) => ({ animationDelay: `${delay}s` });

function Copy({ kicker, title, body }: { kicker: string; title: string; body: string }) {
  return (
    <div>
      <div className="ob-accent font-mono text-[10.5px] font-medium uppercase tracking-[.14em]">{kicker}</div>
      <h2 className="mt-3 font-sans text-[30px] font-semibold leading-[1.12] tracking-[-.025em] text-pretty">{title}</h2>
      <p className="ob-soft mt-3 font-sans text-[14px] leading-[1.6] text-pretty">{body}</p>
    </div>
  );
}

function UploadCard({ t }: { t: T }) {
  return (
    <div className="ob-panel">
      <div className="ob-border ob-mute flex justify-between border-b px-3.5 py-3 font-mono text-[10.5px]">
        <span>{t("firstRun.mFile")}</span>
        <span>1,284</span>
      </div>
      <div className="flex flex-col gap-2 p-3.5 font-mono text-[11.5px]">
        <div className="ob-a-fade flex gap-2"><span className="ob-accent">▸</span><span className="ob-soft">parse · 1,284 {t("firstRun.mAccounts")}</span></div>
        <div className="ob-a-fade flex gap-2" style={fade(0.5)}><span className="ob-accent">▸</span><span className="ob-soft">map · RAS → {t("firstRun.mLines")}</span></div>
        <div className="ob-a-fade flex gap-2" style={fade(1)}><span className="ob-accent">▸</span><span className="ob-soft">verify · D − C = 0.00</span></div>
        <div className="ob-a-fade flex items-center gap-2" style={fade(1.4)}>
          <span className="ob-accent">✓</span>
          <span className="ob-accent">{t("firstRun.mBalanced")}</span>
          <span className="ob-bar-on ob-a-blink h-3.5 w-[7px]" />
        </div>
      </div>
      <div className="ob-track h-0.5 overflow-hidden"><div className="ob-bar-on ob-a-bar h-full" /></div>
    </div>
  );
}

function StatementsCard({ t }: { t: T }) {
  const row = (label: string, value: string, delay: number, muted = true) => (
    <div className="ob-a-fade flex justify-between px-3.5 py-[9px] font-mono text-[12px]" style={fade(delay)}>
      <span className="ob-soft">{label}</span>
      <span className={muted ? "ob-soft" : ""}>{value}</span>
    </div>
  );
  return (
    <div className="ob-panel">
      <div className="ob-border flex border-b">
        <div className="ob-accent-bg ob-deep flex-1 px-3 py-[11px] text-center font-mono text-[10.5px] font-medium">{t("firstRun.mPL")}</div>
        <div className="ob-border ob-mute flex-1 border-l px-3 py-[11px] text-center font-mono text-[10.5px]">{t("firstRun.mBS")}</div>
        <div className="ob-border ob-mute flex-1 border-l px-3 py-[11px] text-center font-mono text-[10.5px]">{t("firstRun.mCF")}</div>
      </div>
      <div className="py-1.5">
        {row(t("firstRun.mRevenue"), "41,204,880", 0, false)}
        {row(t("firstRun.mCogs"), "(28,610,412)", 0.12)}
        {row(t("firstRun.mOpex"), "(6,182,004)", 0.24)}
        <div className="ob-rule mx-3.5 my-[5px] h-px" />
        <div className="ob-a-fade ob-accent flex justify-between px-3.5 py-[9px] font-mono text-[13px] font-medium" style={fade(0.38)}>
          <span>EBITDA</span><span>6,412,464</span>
        </div>
        <div className="ob-a-fade ob-mute flex justify-between px-3.5 pb-2.5 font-mono text-[10.5px]" style={fade(0.5)}>
          <span>{t("firstRun.mTraced")}</span><span>15.6%</span>
        </div>
      </div>
    </div>
  );
}

function RatiosCard({ t }: { t: T }) {
  const cell = (label: string, value: ReactNode, delay: number, accent = false) => (
    <div className="ob-panel-bg ob-a-fade px-3 py-[13px]" style={fade(delay)}>
      <div className="ob-mute font-mono text-[9.5px] uppercase tracking-[.06em]">{label}</div>
      <div className={`mt-[9px] font-mono text-[21px] leading-none ${accent ? "ob-accent" : ""}`}>{value}</div>
    </div>
  );
  const bars = ["on", "on", "on", "on", "on", "on", "on", "dim", "dim", "off"];
  return (
    <>
      <div className="ob-rule ob-border grid grid-cols-3 gap-px overflow-hidden rounded-[10px] border">
        {cell(t("firstRun.mCurrent"), "1.84", 0)}
        {cell(t("firstRun.mDebt"), "1.2×", 0.08)}
        {cell("DSO", "47", 0.16)}
        {cell("ROE", "18.3%", 0.24, true)}
        {cell(t("firstRun.mScore"), <>72<span className="ob-mute text-[11px]">/100</span></>, 0.32)}
        {cell("EV", "48.6M", 0.4)}
      </div>
      <div className="ob-panel p-3.5">
        <div className="ob-mute flex justify-between font-mono text-[10px] uppercase tracking-[.06em]">
          <span>{t("firstRun.mCoverage")}</span><span>104 / 108</span>
        </div>
        <div className="mt-[11px] flex gap-[3px]">
          {bars.map((b, i) => (
            <span key={i} className={`ob-bar-${b} ob-a-pop h-[22px] flex-1 rounded-[2px]`} style={fade(0.05 + i * 0.05)} />
          ))}
        </div>
      </div>
    </>
  );
}

function PeersCard({ t }: { t: T }) {
  const peers: Array<[string, number, boolean]> = [
    [t("firstRun.mYou"), 78, true], ["AQ", 56, false], ["SPH", 70, false], ["BNET", 42, false], ["TTS", 61, false],
  ];
  return (
    <div className="ob-panel p-4">
      <div className="ob-mute flex justify-between font-mono text-[10px] uppercase tracking-[.06em]">
        <span>EBITDA {t("firstRun.mMargin")}</span><span>BVB · FY2025</span>
      </div>
      <div className="mt-4 flex h-[132px] items-end gap-2.5">
        {peers.map(([label, h, you], i) => (
          <div key={label} className="ob-a-fade flex flex-1 flex-col items-center justify-end gap-2 self-stretch" style={fade(i * 0.12)}>
            <div className={`${you ? "ob-bar-on" : "ob-bar-peer"} ob-a-grow w-full rounded-t-[3px]`} style={{ height: `${h}%`, animationDelay: `${i * 0.12}s` }} />
            <span className={`${you ? "ob-accent font-medium" : "ob-mute"} text-center font-mono text-[9.5px]`}>{label}</span>
          </div>
        ))}
      </div>
      <div className="ob-border ob-soft ob-a-fade mt-3.5 border-t pt-3 font-mono text-[11px] leading-[1.5]" style={fade(0.7)}>{t("firstRun.mPeerNote")}</div>
    </div>
  );
}

function AskCard({ t }: { t: T }) {
  return (
    <div className="ob-panel ob-a-rise p-3.5">
      <div className="ob-mute font-mono text-[10px] uppercase tracking-[.1em]">{t("firstRun.mAsk")}</div>
      <div className="mt-3 font-mono text-[12px] leading-[1.5]">? {t("firstRun.mChatQ")}</div>
      <div className="ob-accent ob-a-type mt-2 font-mono text-[12px] leading-[1.5]">{t("firstRun.mChatA")}</div>
    </div>
  );
}

export function OnboardingFlow() {
  const open = useSyncExternalStore(subscribeOnboarding, getOnboardingOpen, () => false);
  return open ? <OnboardingScreen /> : null;
}

function OnboardingScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated, signInWithOAuth } = useAuth();
  const { theme, resolvedTheme } = useTheme();
  const [step, setStep] = useState(0);

  // The overlay is dark whatever the app theme: the shell must match it
  // (light status-bar icons) for as long as it is up, and get the real
  // theme back when it closes. reportThemeToShell() picks the overlay
  // palette while the store says "open" — which is why the cleanup runs
  // after closeOnboarding() has flipped it.
  useEffect(() => {
    if (!isNativeShell()) return undefined;
    reportThemeToShell(resolvedTheme === "dark", theme === "system" || !theme ? "system" : "explicit");
    return () => {
      reportThemeToShell(resolvedTheme === "dark", theme === "system" || !theme ? "system" : "explicit");
    };
    // Mount/unmount only — the page theme cannot change underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = useCallback(() => {
    markOnboardingSeen();
    closeOnboarding();
  }, []);
  const next = () => setStep((s) => Math.min(SLIDES, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const skip = () => setStep(SLIDES);
  const onGoogle = () => {
    finish();
    void signInWithOAuth("google");
  };
  const onEmail = () => {
    finish();
    navigate("/login");
  };

  const counter = `${String(step + 1).padStart(2, "0")}/0${SLIDES}`;
  const auth = step === SLIDES;

  return (
    <div className="ob-screen font-sans" role="dialog" aria-modal="true" data-testid="onboarding" data-step={step}>
      <div className="flex items-center justify-between">
        {step === 0 || auth ? (
          <div className="flex items-center gap-2">
            <Mark />
            {!auth && <span className="ob-mute font-mono text-[11px] font-medium tracking-[.1em]">{counter}</span>}
          </div>
        ) : (
          <button type="button" onClick={back} className="ob-mute font-mono text-[11px] tracking-[.1em]" data-testid="onboarding-back">
            ← {counter}
          </button>
        )}
        {auth ? (
          <button type="button" onClick={() => setStep(0)} className="ob-mute font-mono text-[11px] uppercase tracking-[.06em]" data-testid="onboarding-restart">
            {t("firstRun.btnRestart")}
          </button>
        ) : (
          <button type="button" onClick={skip} className="ob-mute font-mono text-[11px] uppercase tracking-[.06em]" data-testid="onboarding-skip">
            {t("firstRun.btnSkip")}
          </button>
        )}
      </div>

      <div key={step} className="flex flex-1 flex-col justify-center gap-7 overflow-y-auto py-4">
        {step === 0 && (<><UploadCard t={t} /><Copy kicker={t("firstRun.s1kicker")} title={t("firstRun.s1title")} body={t("firstRun.s1body")} /></>)}
        {step === 1 && (<><StatementsCard t={t} /><Copy kicker={t("firstRun.s2kicker")} title={t("firstRun.s2title")} body={t("firstRun.s2body")} /></>)}
        {step === 2 && (<><RatiosCard t={t} /><Copy kicker={t("firstRun.s3kicker")} title={t("firstRun.s3title")} body={t("firstRun.s3body")} /></>)}
        {step === 3 && (<><PeersCard t={t} /><Copy kicker={t("firstRun.s4kicker")} title={t("firstRun.s4title")} body={t("firstRun.s4body")} /></>)}
        {auth && (
          <>
            <AskCard t={t} />
            <div>
              <h2 className="font-sans text-[31px] font-semibold leading-[1.1] tracking-[-.025em] text-pretty">{t("firstRun.authTitle")}</h2>
              <p className="ob-soft mt-3 font-sans text-[14px] leading-[1.6] text-pretty">{t("firstRun.authBody")}</p>
            </div>
          </>
        )}
      </div>

      {auth ? (
        <div className="flex flex-col gap-2.5">
          {isAuthenticated ? (
            <button type="button" onClick={finish} className="ob-cta" data-testid="onboarding-finish">{t("firstRun.btnDashboard")}</button>
          ) : (
            <>
              <button type="button" onClick={onGoogle} className="ob-cta flex items-center justify-center gap-2" data-testid="onboarding-google">
                <GoogleGlyph />
                {t("firstRun.btnGoogle")}
              </button>
              <button type="button" onClick={onEmail} className="ob-ghost h-[52px] rounded-lg border font-mono text-[11.5px] font-medium uppercase tracking-[.1em]" data-testid="onboarding-email">
                {t("firstRun.btnEmail")}
              </button>
              <div className="ob-rule my-1.5 h-px" />
              <button type="button" onClick={finish} className="ob-dashed ob-soft h-[46px] rounded-lg border border-dashed font-mono text-[11.5px] uppercase tracking-[.08em]" data-testid="onboarding-guest">
                {t("firstRun.btnGuest")}
              </button>
              <p className="ob-mute text-center font-mono text-[10.5px] leading-[1.5]">{t("firstRun.guestNote")}</p>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-[18px]">
          <div className="flex gap-[5px]">
            {Array.from({ length: SLIDES }, (_, i) => (
              <span key={i} className={`h-0.5 flex-1 ${i === step ? "ob-bar-on" : "ob-bar-off"}`} />
            ))}
          </div>
          <button type="button" onClick={next} className="ob-cta" data-testid="onboarding-next">
            {step === SLIDES - 1 ? t("firstRun.btnStart") : t("firstRun.btnContinue")}
          </button>
        </div>
      )}
    </div>
  );
}
