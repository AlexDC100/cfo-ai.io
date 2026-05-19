# Saldenliste 31.12.2025
## Berger Beratung GmbH — services firm, ~€5M revenue

DATEV SKR 04 (Industriekontenrahmen). Currency: EUR. Format: 1.234.567,89.

**Note for detection:** the discriminating signal vs SKR 03 is the bank account at **1800** (SKR 04) instead of 1200 (SKR 03), and revenue accounts in class **4** (4000) instead of class 8.

| Konto | Bezeichnung | Soll YTD | Haben YTD |
|---|---|---:|---:|
| 0100 | Konzessionen, gewerbliche Schutzrechte | 24.000,00 | 0,00 |
| 0110 | Geschäfts- oder Firmenwert | 0,00 | 0,00 |
| 0210 | Grundstücke ohne Bauten | 0,00 | 0,00 |
| 0220 | Geschäftsbauten | 0,00 | 0,00 |
| 0440 | Maschinen | 0,00 | 0,00 |
| 0480 | Betriebs- und Geschäftsausstattung | 286.000,00 | 0,00 |
| 0510 | Beteiligungen | 25.000,00 | 0,00 |
| 1140 | Roh-, Hilfs- und Betriebsstoffe | 12.500,00 | 0,00 |
| 1200 | Forderungen aus Lieferungen und Leistungen | 612.400,00 | 0,00 |
| 1240 | Zweifelhafte Forderungen | 8.200,00 | 0,00 |
| 1300 | Sonstige Vermögensgegenstände | 18.500,00 | 0,00 |
| 1400 | Forderungen verbundene Unternehmen | 32.000,00 | 0,00 |
| 1401 | Vorsteuer 19% | 62.400,00 | 0,00 |
| 1600 | Kasse | 1.800,00 | 0,00 |
| 1800 | Bank | 248.500,00 | 0,00 |
| 1810 | Bank Kontokorrent | 84.200,00 | 0,00 |
| 1820 | Postbank | 5.400,00 | 0,00 |
| 2900 | Gezeichnetes Kapital | 0,00 | 100.000,00 |
| 2920 | Kapitalrücklage | 0,00 | 180.000,00 |
| 2930 | Gewinnrücklagen | 0,00 | 285.000,00 |
| 2970 | Gewinnvortrag/Verlustvortrag | 0,00 | 142.800,00 |
| 2980 | Jahresüberschuss/-fehlbetrag | 0,00 | 412.300,00 |
| 3300 | Verbindlichkeiten aus Lieferungen und Leistungen | 0,00 | 184.500,00 |
| 3500 | Sonstige Verbindlichkeiten | 0,00 | 28.400,00 |
| 3530 | Verbindlichkeiten aus Lohn und Gehalt | 0,00 | 48.500,00 |
| 3550 | Umsatzsteuer 19% | 0,00 | 96.200,00 |
| 3700 | Rückstellungen für Pensionen | 0,00 | 0,00 |
| 3720 | Steuerrückstellungen | 0,00 | 38.500,00 |
| 3730 | Sonstige Rückstellungen | 0,00 | 24.800,00 |
| 3150 | Verbindlichkeiten gegenüber Kreditinstituten (kurzfristig) | 0,00 | 0,00 |
| 3160 | Verbindlichkeiten gegenüber Kreditinstituten (langfristig) | 0,00 | 350.000,00 |
| 4000 | Umsatzerlöse Inland | 0,00 | 4.380.000,00 |
| 4100 | Umsatzerlöse 19% USt | 0,00 | 412.000,00 |
| 4200 | Erlöse aus innergem. Lieferungen | 0,00 | 168.000,00 |
| 4500 | Sonstige betriebliche Erträge | 0,00 | 24.500,00 |
| 5100 | Aufwendungen für Roh-, Hilfs- und Betriebsstoffe | 184.000,00 | 0,00 |
| 5200 | Wareneingang | 0,00 | 0,00 |
| 5300 | Bezogene Leistungen | 1.420.000,00 | 0,00 |
| 6000 | Löhne | 0,00 | 0,00 |
| 6010 | Gehälter | 1.480.000,00 | 0,00 |
| 6020 | Gesetzliche soziale Aufwendungen | 312.000,00 | 0,00 |
| 6100 | Freiwillige soziale Aufwendungen | 18.500,00 | 0,00 |
| 6200 | Miete | 142.000,00 | 0,00 |
| 6300 | Reparaturen | 18.400,00 | 0,00 |
| 6400 | Kfz-Kosten | 24.500,00 | 0,00 |
| 6500 | Werbung | 38.500,00 | 0,00 |
| 6600 | Reisekosten | 22.400,00 | 0,00 |
| 6800 | Rechts- und Beratungskosten | 48.500,00 | 0,00 |
| 6900 | Sonstige betriebliche Aufwendungen | 62.300,00 | 0,00 |
| 6220 | Abschreibungen auf Sachanlagen | 78.400,00 | 0,00 |
| 6230 | Abschreibungen auf immaterielle Vermögensgegenstände | 4.800,00 | 0,00 |
| 7100 | Zinsen Bankkredite | 18.500,00 | 0,00 |
| 7200 | Sonstige Zinsen und ähnliche Aufwendungen | 4.200,00 | 0,00 |
| 7400 | Zinserträge | 0,00 | 2.400,00 |
| 7600 | Körperschaftsteuer | 96.400,00 | 0,00 |
| 7610 | Gewerbesteuer | 62.800,00 | 0,00 |
| 7620 | Solidaritätszuschlag | 5.300,00 | 0,00 |
| | **TOTAL** | **5.876.900,00** | **5.876.900,00** |

**TRAPS INCLUDED:**
- Bank at `1800` (SKR 04), NOT `1200` (SKR 03). The detector must distinguish.
- Revenue at `4000` (SKR 04), NOT `8400` (SKR 03). Same.
- Account `1200` here is **Forderungen** (receivables) — in SKR 03, 1200 is Bank. The mapper MUST use the resolved `coa_key` to look up, not just the numeric code.
- `5100`/`5300` Aufwendungen für Roh-, Hilfs- und Betriebsstoffe / Bezogene Leistungen: COGS for the services firm.
- `6220` Abschreibungen: depreciation, MUST be added back to EBIT for EBITDA.
