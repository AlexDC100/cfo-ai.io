// Footer social row — five monochrome 20px icons, env-driven.
//
// Hard rule: never ship dead links. If an env var is unset, the icon
// doesn't render. The user fills in env vars as accounts go live.
//
// Order: LinkedIn → X → YouTube → Instagram → TikTok. LinkedIn first
// because it's the primary B2B channel for European SME CFOs; the rest
// follow the channel-strategy hierarchy (credibility → distribution →
// reach).

import { Instagram, Linkedin, Twitter, Youtube, type LucideIcon } from "lucide-react";
import TikTokIcon from "./icons/TikTok";

type SocialEntry = {
  name: string;
  href: string | undefined;
  Icon: LucideIcon | typeof TikTokIcon;
};

const SOCIALS: SocialEntry[] = [
  {
    name: "LinkedIn",
    href: import.meta.env.VITE_SOCIAL_LINKEDIN as string | undefined,
    Icon: Linkedin,
  },
  {
    name: "X (Twitter)",
    href: import.meta.env.VITE_SOCIAL_X as string | undefined,
    Icon: Twitter,
  },
  {
    name: "YouTube",
    href: import.meta.env.VITE_SOCIAL_YOUTUBE as string | undefined,
    Icon: Youtube,
  },
  {
    name: "Instagram",
    href: import.meta.env.VITE_SOCIAL_INSTAGRAM as string | undefined,
    Icon: Instagram,
  },
  {
    name: "TikTok",
    href: import.meta.env.VITE_SOCIAL_TIKTOK as string | undefined,
    Icon: TikTokIcon,
  },
];

interface Props {
  /** Color tone — "muted" for footer (default), "inverse" for the dark closing-CTA. */
  tone?: "muted" | "inverse";
}

export function FooterSocial({ tone = "muted" }: Props) {
  // Filter out entries with no URL set — graceful degradation.
  const live = SOCIALS.filter((s) => s.href && s.href.trim().length > 0);

  if (live.length === 0) return null;

  const colorClass =
    tone === "inverse"
      ? "text-ink-soft/70 hover:text-paper"
      : "text-ink-soft hover:text-ink";

  const hoverBg =
    tone === "inverse"
      ? "hover:bg-white/10"
      : "hover:bg-bg-2";

  return (
    <nav className="flex items-center gap-2" aria-label="Social media">
      {live.map(({ name, href, Icon }) => (
        <a
          key={name}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`CFO AI on ${name}`}
          className={`
            inline-flex items-center justify-center
            h-10 w-10 rounded-lg
            transition-colors duration-200
            ${colorClass}
            ${hoverBg}
            focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-[hsl(var(--brand))] focus-visible:ring-offset-2
            focus-visible:ring-offset-[hsl(var(--bg))]
          `}
        >
          <Icon size={20} />
        </a>
      ))}
    </nav>
  );
}
