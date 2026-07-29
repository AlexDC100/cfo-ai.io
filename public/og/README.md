# Open Graph images

URLs in `<head>` of `index.html` point at `https://cfoai.app/og/homepage.png` —
the image that auto-attaches when the homepage URL is pasted into LinkedIn,
X (Twitter), Slack, iMessage, etc. **This is one of the highest-leverage assets on
the site** — it determines whether 80%+ of social shares get clicked.

## Required files

| File | Size | Used for |
|---|---|---|
| `homepage.png` | 1200×630 | All pages (homepage, /about, /security) |
| `pricing.png` | 1200×630 | /pricing (optional — adds "€1 for 3 months" social-share moment) |

## Design template (build once in Figma, export PNG, drop here)

```
┌────────────────────────────────────────────────────────────────┐
│ [warm cream background #FAFAF7 or dark #05070A]                │
│                                                                │
│  CFO AI                                                        │
│  ↑ logotype top-left, Inter Medium ~32px, ink color            │
│                                                                │
│  CFO-grade analysis for                  [Dashboard screenshot │
│  European SMEs.                           at slight -3° tilt,  │
│  ↑ Instrument Serif, ~72px, two lines     with shadow-3]       │
│                                                                │
│  Auto-detects 15 European                                      │
│  chart-of-accounts standards.                                  │
│  ↑ Inter ~24px, two lines, ink-soft                            │
│                                                                │
│  cfoai.app                                                     │
│  ↑ Inter ~18px, ink-mute, bottom-left                          │
└────────────────────────────────────────────────────────────────┘
```

Specs:
- Exact dimensions: **1200 × 630 px** (LinkedIn + X both render at this ratio)
- Format: PNG or JPG, under 1 MB
- Safe zone: keep all text inside a 1140 × 570 inner bounding box (some
  clients crop edges)
- Don't use plain logo on solid background — it screams "placeholder"

## After uploading

1. Push to production so `https://cfoai.app/og/homepage.png` is live.
2. Validate the card with:
   - [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) — paste your URL, hit "Inspect", confirm image renders. Use "Inspect" again if LinkedIn cached an old version.
   - [opengraph.xyz](https://www.opengraph.xyz/) — same idea, faster preview.
   - Paste the URL into a draft tweet on X — the preview appears below the compose box.
3. Three successful previews = card is shippable.

## Until the PNG exists

LinkedIn / X will render the URL without a preview card. Not a disaster, but
the page won't earn the click-through bump that a proper card produces. Treat
this PNG as a P1 launch task.
