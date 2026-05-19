# Balance des comptes au 31/12/2025
## SARL Atelier Mécanique du Rhône — light industrial, ~€3.5M revenue

Plan Comptable Général 2014. Currency: EUR. Format: 1 234 567,89.

| Compte | Libellé | Débit YTD | Crédit YTD |
|---|---|---:|---:|
| 101 | Capital social | 0,00 | 50 000,00 |
| 106 | Réserves | 0,00 | 380 000,00 |
| 11 | Report à nouveau (créditeur) | 0,00 | 145 200,00 |
| 12 | Résultat de l'exercice | 0,00 | 287 450,00 |
| 164 | Emprunts auprès des établissements de crédit | 0,00 | 620 000,00 |
| 201 | Frais d'établissement | 4 200,00 | 0,00 |
| 205 | Concessions, brevets, licences | 18 750,00 | 0,00 |
| 213 | Constructions | 920 000,00 | 0,00 |
| 215 | Installations techniques, matériel et outillage | 1 240 000,00 | 0,00 |
| 218 | Autres immobilisations corporelles | 156 000,00 | 0,00 |
| 261 | Titres de participation | 50 000,00 | 0,00 |
| 28 | Amortissements des immobilisations | 0,00 | 712 400,00 |
| 311 | Matières premières | 142 000,00 | 0,00 |
| 355 | Produits finis | 89 500,00 | 0,00 |
| 401 | Fournisseurs | 0,00 | 218 700,00 |
| 411 | Clients | 412 300,00 | 0,00 |
| 416 | Clients douteux ou litigieux | 14 800,00 | 0,00 |
| 421 | Personnel — rémunérations dues | 0,00 | 62 400,00 |
| 4456 | TVA déductible | 38 200,00 | 0,00 |
| 4457 | TVA collectée | 0,00 | 72 800,00 |
| 431 | Sécurité sociale | 0,00 | 41 200,00 |
| 444 | État — Impôts sur les bénéfices | 0,00 | 28 500,00 |
| 512 | Banque | 184 600,00 | 0,00 |
| 531 | Caisse | 2 150,00 | 0,00 |
| 601 | Achats stockés — matières premières | 1 480 000,00 | 0,00 |
| 607 | Achats de marchandises | 320 500,00 | 0,00 |
| 611 | Sous-traitance générale | 78 200,00 | 0,00 |
| 615 | Entretien et réparations | 89 400,00 | 0,00 |
| 616 | Primes d'assurance | 24 800,00 | 0,00 |
| 621 | Personnel extérieur à l'entreprise | 42 100,00 | 0,00 |
| 623 | Publicité, publications, relations publiques | 18 400,00 | 0,00 |
| 624 | Transports de biens | 67 900,00 | 0,00 |
| 625 | Déplacements, missions et réceptions | 14 600,00 | 0,00 |
| 626 | Frais postaux et de télécommunications | 8 200,00 | 0,00 |
| 627 | Services bancaires et assimilés | 6 400,00 | 0,00 |
| 628 | Divers | 9 800,00 | 0,00 |
| 631 | Impôts, taxes et versements assimilés sur rémunérations | 38 200,00 | 0,00 |
| 635 | Autres impôts, taxes et versements assimilés | 14 600,00 | 0,00 |
| 641 | Rémunérations du personnel | 642 000,00 | 0,00 |
| 645 | Charges de sécurité sociale et de prévoyance | 218 400,00 | 0,00 |
| 661 | Charges d'intérêts | 34 500,00 | 0,00 |
| 666 | Pertes de change | 4 200,00 | 0,00 |
| 671 | Charges exceptionnelles sur opérations de gestion | 8 400,00 | 0,00 |
| 681 | Dotations aux amortissements | 142 600,00 | 0,00 |
| 695 | Impôts sur les bénéfices | 96 200,00 | 0,00 |
| 701 | Ventes de produits finis | 0,00 | 2 780 000,00 |
| 706 | Prestations de services | 0,00 | 425 000,00 |
| 707 | Ventes de marchandises | 0,00 | 312 000,00 |
| 72 | Production immobilisée | 0,00 | 48 000,00 |
| 74 | Subventions d'exploitation | 0,00 | 18 500,00 |
| 758 | Produits divers de gestion courante | 0,00 | 6 200,00 |
| 762 | Produits financiers (intérêts) | 0,00 | 1 850,00 |
| 766 | Gains de change | 0,00 | 3 100,00 |
| 771 | Produits exceptionnels sur opérations de gestion | 0,00 | 9 200,00 |
| 78 | Reprises sur amortissements et provisions | 0,00 | 14 800,00 |
| 79 | Transferts de charges | 0,00 | 7 300,00 |
| | **TOTAL** | **6 539 300,00** | **6 539 300,00** |

**TRAPS INCLUDED:**
- `72` Production immobilisée (€48 000) — capitalized own-work, MUST be excluded from operating revenue.
- `78` Reprises sur amortissements (€14 800) — provision reversal, MUST be flagged as non-recurring.
- `79` Transferts de charges (€7 300) — cost transfers, MUST be excluded from revenue.
- `67`/`77` exceptional items — below EBIT, NOT in EBITDA.
- `615` Entretien et réparations (€89 400 = 2.5% of revenue) — within normal band; should NOT trigger anomaly flag.
