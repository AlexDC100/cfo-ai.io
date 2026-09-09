// First-run onboarding — the "Terminal" treatment (design 1b): dark,
// mono-forward, instrument readouts. Four instruction slides, then sign in
// or explore. See lib/onboarding.ts for when it plays.
//
// Colours are the treatment's own fixed dark palette (it looks the same on
// Paper and Terminal), defined as `.ob-*` classes in index.css — the token
// sheet is the one place hex may live.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LogIn } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { AuthPanel, Brand, Mark } from "./AuthScreen";
import {
  closeOnboarding,
  getOnboardingOpen,
  markOnboardingSeen,
  subscribeOnboarding,
} from "@/lib/onboarding";

const SLIDES = 4;
type T = (key: string) => string;

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

/** Types `text` out character by character WITHOUT moving layout: the
 *  full text is laid out invisibly to fix the box, and the visible prefix
 *  sits on top of it — a prefix wraps exactly like the whole. */
function Typewriter({ text, delayMs = 400, durationMs = 1600 }: { text: string; delayMs?: number; durationMs?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(text.length);
      return undefined;
    }
    let raf = 0;
    const start = performance.now() + delayMs;
    const tick = (now: number) => {
      const n = Math.max(0, Math.min(text.length, Math.round(((now - start) / durationMs) * text.length)));
      setShown(n);
      if (n < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, delayMs, durationMs]);
  return (
    <span className="relative block">
      <span aria-hidden className="invisible">{text}</span>
      <span className="absolute inset-0">{text.slice(0, shown)}</span>
    </span>
  );
}

function AskCard({ t }: { t: T }) {
  return (
    <div className="ob-panel ob-a-rise p-3.5">
      <div className="ob-mute font-mono text-[10px] uppercase tracking-[.1em]">{t("firstRun.mAsk")}</div>
      <div className="mt-3 font-mono text-[12px] leading-[1.5]">? {t("firstRun.mChatQ")}</div>
      <div className="ob-accent mt-2 font-mono text-[12px] leading-[1.5]"><Typewriter text={t("firstRun.mChatA")} /></div>
    </div>
  );
}

export function OnboardingFlow() {
  const open = useSyncExternalStore(subscribeOnboarding, getOnboardingOpen, () => false);
  return open ? <OnboardingScreen /> : null;
}

type FinalView = "slide" | "leaving" | "auth" | "returning";

/** The last slide. Sign in transitions IN PLACE (2026-09-09 per operator):
 *  the content under the lockup fades out, the lockup glides to the top
 *  (FLIP: measured before and after the layout switch) and the app's
 *  sign-in card fades in beneath it. Back reverses the motion. */
function FinalSlide({
  t,
  isAuthenticated,
  signOut,
  onBack,
  onDone,
}: {
  t: T;
  isAuthenticated: boolean;
  signOut: () => Promise<unknown>;
  onBack: () => void;
  onDone: () => void;
}) {
  const [view, setView] = useState<FinalView>("slide");
  const brandRef = useRef<HTMLDivElement>(null);
  const fromTopRef = useRef<number | null>(null);
  const timerRef = useRef<number>();
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const goAuth = async () => {
    if (view !== "slide") return;
    // A live session would make the card bounce straight to the dashboard.
    if (isAuthenticated) await signOut();
    setView("leaving");
    timerRef.current = window.setTimeout(() => {
      fromTopRef.current = brandRef.current?.getBoundingClientRect().top ?? null;
      setView("auth");
    }, 300);
  };
  const goSlide = () => {
    if (view !== "auth") return;
    fromTopRef.current = brandRef.current?.getBoundingClientRect().top ?? null;
    setView("returning");
    timerRef.current = window.setTimeout(() => setView("slide"), 30);
  };

  // FLIP: the lockup keeps its DOM node across layouts; after a layout
  // switch, start it where it WAS and let it glide to where it is.
  useLayoutEffect(() => {
    const el = brandRef.current;
    const from = fromTopRef.current;
    fromTopRef.current = null;
    if (!el || from == null) return;
    const dy = from - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
    void el.offsetHeight;
    el.style.transition = "transform 560ms cubic-bezier(.16, 1, .3, 1)";
    el.style.transform = "translateY(0)";
  }, [view]);

  const auth = view === "auth";
  const contentShown = view === "slide";
  const fadeCls = `transition-opacity duration-300 ${contentShown ? "opacity-100" : "opacity-0"}`;

  return (
    <>
      {!auth && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="ob-mute font-mono text-[11px] uppercase tracking-[.06em]"
            data-testid="onboarding-back"
          >
            ← {t("firstRun.btnBack")}
          </button>
          <span />
        </div>
      )}

      {auth ? (
        // Edge to edge: cancel the slide padding so the auth panel uses the
        // whole screen and scrolls under the top fade (2026-09-09).
        <div
          className="relative flex flex-1 min-h-0 flex-col"
          style={{ margin: "calc(-1 * (env(safe-area-inset-top) + 28px)) -26px calc(-1 * (env(safe-area-inset-bottom) + 28px))" }}
        >
          <AuthPanel brandRef={brandRef} initialMode="sign_in" onBack={goSlide} onAuthenticated={onDone} />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 flex-col justify-center gap-5 overflow-y-auto py-4">
          <Brand innerRef={brandRef} />
          <div className={`flex flex-col gap-5 ${fadeCls}`}>
            <AskCard t={t} />
            <div>
              <h2 className="font-sans text-[31px] font-semibold leading-[1.1] tracking-[-.025em] text-pretty">{t("firstRun.authTitle")}</h2>
              <p className="ob-soft mt-3 font-sans text-[14px] leading-[1.6] text-pretty">{t("firstRun.authBody")}</p>
            </div>
          </div>
        </div>
      )}

      {!auth && (
        <div className={`flex flex-col gap-2.5 ${fadeCls}`}>
          <button type="button" onClick={() => void goAuth()} className="ob-cta flex items-center justify-center gap-2" data-testid="onboarding-signin">
            <LogIn size={15} strokeWidth={2} className="shrink-0" />
            {t("firstRun.btnSignIn")}
          </button>
          {isAuthenticated ? (
            <button type="button" onClick={onDone} className="ob-mute py-2 text-center font-mono text-[10.5px] uppercase tracking-[.08em] underline decoration-dotted underline-offset-4" data-testid="onboarding-continue">
              {t("firstRun.continueWithout")}
            </button>
          ) : (
            <button type="button" onClick={onDone} className="ob-dashed ob-soft h-[46px] rounded-lg border border-dashed font-mono text-[11.5px] uppercase tracking-[.08em]" data-testid="onboarding-guest">
              {t("firstRun.btnGuest")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function OnboardingScreen() {
  const { t } = useTranslation();
  const { isAuthenticated, signOut } = useAuth();
  const [step, setStep] = useState(0);
  // Leaving fades the whole overlay out before it unmounts (2026-09-09
  // per operator: "smoothly display the app").
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  const dismiss = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      markOnboardingSeen();
      closeOnboarding();
    }, 320);
  }, [leaving]);
  const next = () => setStep((s) => Math.min(SLIDES, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const skip = () => setStep(SLIDES);

  const counter = `${String(step + 1).padStart(2, "0")}/0${SLIDES}`;
  const auth = step === SLIDES;

  return (
    <div
      className={`ob-screen font-sans transition-opacity duration-300 ${leaving ? "pointer-events-none opacity-0" : "opacity-100"}`}
      role="dialog"
      aria-modal="true"
      data-testid="onboarding"
      data-step={step}
    >
      {auth ? (
        <FinalSlide t={t} isAuthenticated={isAuthenticated} signOut={signOut} onBack={() => setStep(SLIDES - 1)} onDone={dismiss} />
      ) : (
        <>
          <div className="flex items-center justify-between">
            {step === 0 ? (
              <Mark />
            ) : (
              <button type="button" onClick={back} className="ob-mute font-mono text-[11px] uppercase tracking-[.06em]" data-testid="onboarding-back">
                ← {t("firstRun.btnBack")}
              </button>
            )}
            <button type="button" onClick={skip} className="ob-mute font-mono text-[11px] uppercase tracking-[.06em]" data-testid="onboarding-skip">
              {t("firstRun.btnSkip")}
            </button>
          </div>

          <div key={step} className="flex flex-1 flex-col justify-center gap-7 overflow-y-auto py-4">
            {step === 0 && (<><UploadCard t={t} /><Copy kicker={t("firstRun.s1kicker")} title={t("firstRun.s1title")} body={t("firstRun.s1body")} /></>)}
            {step === 1 && (<><StatementsCard t={t} /><Copy kicker={t("firstRun.s2kicker")} title={t("firstRun.s2title")} body={t("firstRun.s2body")} /></>)}
            {step === 2 && (<><RatiosCard t={t} /><Copy kicker={t("firstRun.s3kicker")} title={t("firstRun.s3title")} body={t("firstRun.s3body")} /></>)}
            {step === 3 && (<><PeersCard t={t} /><Copy kicker={t("firstRun.s4kicker")} title={t("firstRun.s4title")} body={t("firstRun.s4body")} /></>)}
          </div>

          <div className="flex flex-col gap-[18px]">
            <div className="flex flex-col gap-2.5">
              <span className="ob-mute text-center font-mono text-[11px] font-medium tracking-[.1em]" data-testid="onboarding-counter">{counter}</span>
              <div className="flex gap-[5px]">
                {Array.from({ length: SLIDES }, (_, i) => (
                  <span key={i} className={`h-0.5 flex-1 ${i === step ? "ob-bar-on" : "ob-bar-off"}`} />
                ))}
              </div>
            </div>
            <button type="button" onClick={next} className="ob-cta" data-testid="onboarding-next">
              {step === SLIDES - 1 ? t("firstRun.btnStart") : t("firstRun.btnContinue")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
