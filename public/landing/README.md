# Landing page — public-company preview assets

The Public Company Intelligence showcase on `/` looks for these files
when rendering the preview frame:

```
public/landing/
├── preview-aapl.mp4
├── preview-aapl.jpg     # poster — first frame, used as LCP placeholder
├── preview-msft.mp4
├── preview-msft.jpg
├── preview-nvda.mp4
├── preview-nvda.jpg
├── preview-tsla.mp4
├── preview-tsla.jpg
├── preview-googl.mp4
└── preview-googl.jpg
```

When any file is missing the showcase silently falls back to a clean
Sample-preview placeholder card (mirrors the real hub's KPI strip) so
the landing page never shows a broken-media icon. See
`PreviewSurface` in `src/pages/cfo/Landing.tsx` for the fallback render.

## Recording rules

| Spec | Value |
|---|---|
| Aspect ratio | 16:10 (matches the showcase frame) |
| Duration | 20–25 seconds, looped |
| Resolution | 1920×1200 source, encode at 1280×800 |
| Frame rate | 30 fps |
| Encoding | H.264 high profile, ~1.5 Mbps target (keep file ≤ 4 MB) |
| Audio | None — the showcase mounts `<video muted>` |
| Poster JPG | First frame at 1280×800, ~80% quality, ≤ 120 KB |

## Capture flow (for the actual product UI)

1. Sign into the workspace.
2. Visit `https://cfo-ai.io/public-companies?ticker=AAPL`.
3. Wait for the snapshot to fully render.
4. Start the screen recording at 1920×1200 over the hub area only.
5. Hover Refresh, hover Add as peer, scroll the KPI grid — keep the
   movement subtle. No mouse cursor in the export.
6. Trim to 20–25s, ensure the loop point is invisible (start + end
   show the same KPI tile state).
7. Encode + poster, drop into this directory, redeploy.
