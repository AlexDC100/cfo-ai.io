"""F3.1b — Romania pack: thin delegating wrapper.

This implementation is a transparent bridge to the existing
`engine.api._ro_coa`, `engine.api._trial_balance_parser`, and
`engine.api._caen_industry_map` modules. Every method here forwards
its arguments unchanged to the legacy function and returns the result
unchanged.

The wrapper exists so the pipeline can call `pack.bucket_for(code)`
instead of `_ro_coa.bucket_for(code)` (F3.1c) without changing
behaviour, and so subsequent F3.1d / F3.1e moves can relocate the
underlying data into this pack folder without touching pipeline.py
again.

Bytes-identical-output gate (F3.1-PARITY) must remain GREEN after
this change.
"""
from __future__ import annotations

from typing import Any, List, Optional, Tuple, Union

from engine.core.country_pack_registry import register_pack
from engine.core.types import (
    AltmanThresholds,
    AssembledEnvelope,
    BucketRule,
    CalibrationTier,
    ClassifierSignals,
    CreditLadderEntry,
    DetectionConfidence,
    NumberFormat,
    ParsedAccount,
)


# F3.1d: data now lives inside the pack folder. The legacy
# `engine.api._ro_coa` / `_trial_balance_parser` / `_caen_industry_map`
# modules are F3.1d-vintage shims that re-export from these
# pack-local modules; F3.1e deletes the shims.
from . import chart_of_accounts as _legacy_coa
from . import trial_balance_parser as _legacy_tbp
from . import caen_industry_map as _legacy_caen


def _account_to_dict(a: Any) -> dict:
    """Accept either a `ParsedAccount` dataclass or a plain dict (the
    shape `_ro_coa.assemble_statements()` expects). Returns a dict.

    This bridge lives in F3.1b so the pack's public API can match the
    `CountryAccountingPack` Protocol's `List[ParsedAccount]` type
    without breaking the pipeline's current dict-shaped call sites.
    """
    if isinstance(a, ParsedAccount):
        d = {"code": a.code, "name": a.name, "amount": a.amount}
        if a.bucket_override:
            d["bucket_override"] = a.bucket_override
        if a.metadata:
            d.update(a.metadata)
        return d
    if isinstance(a, dict):
        return a
    raise TypeError(f"Account must be ParsedAccount or dict, got {type(a)}")


class RomaniaPack:
    """Romania country pack — OMFP 1802 / RAS.

    F3.1b: thin delegating wrapper. All behaviour stays in the legacy
    `engine.api._ro_coa` / `_trial_balance_parser` / `_caen_industry_map`
    modules; this class just forwards calls.
    """

    # ── 1. Identity ─────────────────────────────────────────
    country_code: str = "RO"
    country_name: str = "Romania"
    accounting_standard: str = "OMFP 1802 / RAS"
    pack_version: str = "1.0.0"   # F3.1e closure
    calibration_tier: CalibrationTier = CalibrationTier.PARTIALLY_CALIBRATED

    # ── 2. Locale / display ─────────────────────────────────
    currency: str = "RON"
    number_format: NumberFormat = NumberFormat(
        decimal_separator=",",
        thousands_separator=".",
        currency_position="suffix",
    )
    primary_language: str = "ro"

    # ── 7. Valuation defaults (RO 2026) ─────────────────────
    risk_free_rate: float = 0.0675       # RO 10Y govt benchmark
    country_risk_premium: float = 0.0    # built into risk_free_rate above

    # ── 8. Validation thresholds + regression anchors ───────
    bs_reconciliation_tolerance_pct: float = 0.5
    altman_thresholds: AltmanThresholds = AltmanThresholds(
        variant="z_double_prime_em",
        distress_max=1.10,
        safe_min=2.60,
    )
    credit_letter_grade_ladder: Tuple[CreditLadderEntry, ...] = (
        CreditLadderEntry(min_score=90.0, letter_grade="AAA / AA"),
        CreditLadderEntry(min_score=80.0, letter_grade="A"),
        CreditLadderEntry(min_score=70.0, letter_grade="BBB"),
        CreditLadderEntry(min_score=60.0, letter_grade="BB"),
        CreditLadderEntry(min_score=50.0, letter_grade="B"),
        CreditLadderEntry(min_score=40.0, letter_grade="CCC"),
        CreditLadderEntry(min_score=25.0, letter_grade="CC"),
        CreditLadderEntry(min_score=0.0, letter_grade="C / D"),
    )

    regression_fixtures: Tuple[str, ...] = (
        "src/engine/country_packs/ro_romania/fixtures/regression_baselines/eei_dec_2025.json",
        "src/engine/country_packs/ro_romania/fixtures/regression_baselines/scandia_fy2025.json",
    )
    methodology_doc_path: str = "CLAUDE.md#appendix-a"

    # ── 3. Detection helpers ────────────────────────────────
    def _extract_text(self, content: bytes, filename: str) -> str:
        """Best-effort text extraction from upload content. Handles:
          - UTF-8 / Latin-1 text (CSV, TSV, JSON, plain text)
          - XLSX (uses openpyxl to read shared strings + cell values)
          - PDF (best-effort: scan for ASCII strings, no parsing)

        Returns concatenated text capped at 64KB to keep detection
        cost bounded on multi-MB uploads.
        """
        MAX_BYTES = 64 * 1024
        sample = content[:MAX_BYTES] if len(content) > MAX_BYTES else content

        # ── XLSX detection by magic bytes (PK\x03\x04 zip header) ──
        if sample[:4] == b"PK\x03\x04":
            try:
                import openpyxl
                import io
                wb = openpyxl.load_workbook(
                    io.BytesIO(content),
                    read_only=True,
                    data_only=True,
                )
                parts: list = []
                for ws in wb.worksheets:
                    rows_read = 0
                    for row in ws.iter_rows(values_only=True):
                        for cell in row:
                            if cell is not None:
                                parts.append(str(cell))
                        rows_read += 1
                        if rows_read >= 800:  # bound per-sheet (raise so 600+ row TBs surface all codes)
                            break
                wb.close()
                # Allow up to 4× MAX_BYTES so 600+ row Romanian TBs
                # surface their full account code list to the regex.
                return "\n".join(parts)[:MAX_BYTES * 4]
            except Exception:
                # Fall through to text decode of raw bytes
                pass

        # ── PDF detection ───────────────────────────────────────
        if sample[:4] == b"%PDF":
            # F3.8: prefer PyMuPDF for real text extraction (account
            # codes, Romanian labels, currency markers all surface
            # cleanly). Falls back to the ASCII scan if PyMuPDF isn't
            # installed (e.g. local dev without the pack's deps).
            try:
                import fitz
                import io
                doc = fitz.open(stream=content, filetype="pdf")
                parts: list = []
                for page in doc:
                    parts.append(page.get_text())
                    if sum(len(p) for p in parts) > MAX_BYTES * 4:
                        break
                doc.close()
                return "\n".join(parts)[:MAX_BYTES * 4]
            except ImportError:
                pass
            except Exception:
                pass
            try:
                import re
                printable = re.sub(rb"[^\x20-\x7E\xC2-\xC3\n]+", b" ", content[:MAX_BYTES])
                return printable.decode("utf-8", errors="ignore")
            except Exception:
                pass

        # ── Plain text fallback ────────────────────────────────
        for enc in ("utf-8", "latin-1", "cp1250"):
            try:
                return content[:MAX_BYTES].decode(enc, errors="ignore")
            except Exception:
                continue
        return ""

    # ── 3. Detection ────────────────────────────────────────
    def detect_from_content(
        self, content: bytes, filename: str
    ) -> DetectionConfidence:
        """F3.3 — Romanian-content classifier.

        Scans the uploaded content for Romanian-specific signals and
        returns a confidence score in [0, 1]. The classifier is
        deliberately conservative: each signal carries a max weight,
        and the final score is a weighted sum capped at 1.0. The
        scoring is chosen so a real Romanian trial balance (SAGA,
        WinMentor, Crystal Reports, or the EEI/Scandia fixtures)
        clears 0.95 — well above the 0.90 high-confidence threshold
        — while non-Romanian uploads should fall below 0.50.

        Signal weights (sum to 1.0):
          - 0.30 — Romanian-language label patterns (Cifra de afaceri,
                   Sume totale, Sold final, Balanță, Cont, etc.)
          - 0.25 — Currency markers (RON / LEI)
          - 0.35 — RAS account-code structure (3-4-digit codes in the
                   class-1-7 range, validated against the OMFP-1802
                   chart of accounts)
          - 0.05 — VAT-ID format (RO + 2-10 digits)
          - 0.02 — Romanian diacritics (ă, â, î, ș, ț)
          - 0.03 — Filename hints (balanta, ro, romania, bilant)

        Re-tuned at F3.3 so the four strong signals (labels +
        currency + codes + filename) alone clear 0.95 — VAT and
        diacritics are dominantly absent in older Romanian SAGA
        exports that uppercase ASCII everything.
        """
        notes: list = []
        signals: dict = {}

        # ── Decode content as text (best-effort) ───────────────
        # For binary formats (XLSX, XLS) the raw byte decode yields
        # mostly zlib garbage. Use openpyxl-style decompression to
        # surface cell values when possible.
        text = self._extract_text(content, filename)
        text_lower = text.lower()
        text_for_diacritics = text  # preserve case for diacritic scan

        # ── 1. Romanian-language label patterns (0.25) ─────────
        ro_label_patterns = (
            "cifra de afaceri", "sume totale", "sold final", "sold initial",
            "balanță", "balanta", "cont", "creditoare", "debitoare",
            "venituri", "cheltuieli", "imobilizari", "imobilizări",
            "capital social", "rezerve", "stocuri", "datorii",
            "creante", "creanțe", "furnizori", "clienti", "clienți",
        )
        label_hits = sum(1 for pat in ro_label_patterns if pat in text_lower)
        # 6+ hits → max score. Each hit worth 0.25/6.
        label_score = min(1.0, label_hits / 6.0)
        signals["language_labels"] = label_score
        if label_hits > 0:
            notes.append(f"Romanian-language labels matched: {label_hits} patterns")

        # ── 2. Currency markers (0.20) ─────────────────────────
        currency_hits = 0
        # Word-boundary check is approximate via spaces/parens/quotes.
        for ccy_marker in (" ron ", " lei ", "(ron)", "[ron]", '"ron"',
                           " ron\n", "\nron ", " lei\n", "\nlei ",
                           "moneda ron", "moneda lei", "în lei", "in lei"):
            if ccy_marker in text_lower:
                currency_hits += 1
        # 2+ hits → max. Each hit worth 0.20/2.
        currency_score = min(1.0, currency_hits / 2.0)
        signals["currency_markers"] = currency_score

        # ── 3. RAS account-code structure (0.40) ───────────────
        # Romanian RAS codes are 3-7 digits starting with 1-7. The
        # base table has 3-4 digit prefixes; software like SAGA
        # extends to 5-7 digit sub-accounts (101201, 162101). Match
        # the full range and let the bucket_for() prefix-match filter
        # surface only codes the chart of accounts actually
        # recognises.
        import re
        sample = text[:32000]
        codes = re.findall(r"(?<!\d)([1-7][0-9]{2,6})(?!\d)", sample)
        recognised = 0
        seen: set = set()
        for c in codes[:1000]:  # bound the loop
            if c in seen:
                continue
            if _legacy_coa.bucket_for(c):
                seen.add(c)
                recognised += 1
        # 15+ distinct recognised codes → max. EEI has 69; Scandia 600+.
        coa_score = min(1.0, recognised / 15.0)
        signals["ras_account_codes"] = coa_score
        if recognised > 0:
            notes.append(f"RAS account codes recognised (distinct): {recognised}")

        # ── 4. VAT-ID format (0.15) ────────────────────────────
        # Romanian VAT IDs: "RO" + 2-10 digits. Also accept "CIF"
        # prefix which is the local synonym.
        vat_match = re.search(r"\b(?:RO|CIF)\s*[:#-]?\s*(\d{2,10})\b", text, re.IGNORECASE)
        vat_score = 1.0 if vat_match else 0.0
        signals["vat_id_format"] = vat_score

        # ── 5. Romanian diacritics (0.05) ──────────────────────
        diacritic_chars = ("ă", "â", "î", "ș", "ț", "Ă", "Â", "Î", "Ș", "Ț")
        diacritic_hits = sum(text_for_diacritics.count(c) for c in diacritic_chars)
        diacritic_score = min(1.0, diacritic_hits / 30.0)
        signals["diacritics"] = diacritic_score

        # ── 6. Filename hints (0.05) ───────────────────────────
        fn_lower = (filename or "").lower()
        fn_score = 0.0
        for hint in ("balanta", "balanță", "balance_ro", "_ro_", "/ro/",
                     "romania", "romanian", "bilant", "bilanț"):
            if hint in fn_lower:
                fn_score = 1.0
                break
        signals["filename_hints"] = fn_score

        # ── Weighted aggregate ─────────────────────────────────
        # Re-tuned so the top three signals (labels + currency +
        # codes) alone reach 0.95 even when VAT-ID / diacritics /
        # filename are missing (older SAGA exports often uppercase
        # ASCII everything and trade-register number is not the EU
        # VAT format).
        weights = {
            "language_labels":     0.30,
            "currency_markers":    0.25,
            "ras_account_codes":   0.40,
            "vat_id_format":       0.02,
            "diacritics":          0.01,
            "filename_hints":      0.02,
        }
        confidence = sum(signals[k] * weights[k] for k in weights)
        confidence = min(1.0, max(0.0, confidence))

        # ── F3.8b — Vendor / file-format signature ───────────────
        # The Romanian RAS PDF ecosystem has three dominant exporters
        # (WinMENTOR ENTERPRISE, SAGA Soft, Ciel Conta) that all
        # share the 5-period 10-numeric-column layout the
        # pdf_ingester targets. The brand string usually appears in
        # the page footer or header. Detect from the extracted text;
        # default to "ro_pdf_generic" for any other Romanian PDF
        # without a recognisable vendor brand.
        detected_format = self._detect_format(content, text, filename)
        detected_layout = "pdf_full_movement" if detected_format and detected_format.startswith("ro_pdf_") else None

        return DetectionConfidence(
            country_code="RO",
            confidence=confidence,
            signals=signals,
            detected_language="ro" if (
                signals["language_labels"] > 0 or signals["diacritics"] > 0
            ) else None,
            detected_currency="RON" if signals["currency_markers"] > 0 else None,
            detected_standard="OMFP 1802 / RAS" if signals["ras_account_codes"] > 0 else None,
            detected_layout=detected_layout,
            detected_format=detected_format,
            notes=tuple(notes),
        )

    def _detect_format(self, content: bytes, text: str, filename: str) -> Optional[str]:
        """F3.8b — Return the Romanian RAS file-format signature, or
        None when the content doesn't look like a recognised RAS
        export. Vendor signatures appear in PDF metadata or page
        text; XLSX exports get their own signature once F3.9 ships.
        """
        # Magic-byte check: PDF first.
        if content[:4] == b"%PDF":
            text_lower = text.lower()
            if "winmentor" in text_lower:
                return "ro_pdf_winmentor"
            if "saga" in text_lower and ("soft" in text_lower or ".ro" in text_lower):
                return "ro_pdf_saga"
            if "ciel" in text_lower and ("conta" in text_lower or "romania" in text_lower):
                return "ro_pdf_ciel"
            # Generic — has the RAS 5-period header pattern (sume
            # totale + sold final + rulaj precedent) but no
            # discriminating vendor brand.
            if all(p in text_lower for p in ("sume totale", "sold final")):
                return "ro_pdf_generic"
            # PDF but not recognisably a Romanian RAS trial balance.
            return None
        # XLSX magic bytes are the ZIP archive header (PK\x03\x04).
        # Future F3.9 fingerprinting lands here; for now leave None.
        return None

    # ── 4. Parsing ──────────────────────────────────────────
    def parse_trial_balance(
        self, content: bytes, filename: str
    ) -> List[Any]:
        """Parse a Romanian RAS trial balance. Dispatches on magic
        bytes:
          - ``%PDF…`` → F3.8 `pdf_ingester.parse_pdf_trial_balance`
            (PyMuPDF position-based extraction, leaf-filtered)
          - everything else → existing
            `trial_balance_parser.parse_trial_balance_file` (XLSX/CSV)

        Both paths emit the same 10-column dict shape so downstream
        `accounts_to_assemble_shape()` consumes them identically.
        """
        from . import pdf_ingester as _pdf
        if _pdf.is_pdf(content):
            try:
                # PDF rows are a plain list (no anchor metadata) — the
                # attach helper no-ops on them by design.
                return self.attach_closing_result(
                    _pdf.parse_pdf_trial_balance(content, filename)
                )
            except _pdf.PdfIngestError as e:
                # Surface as ParseError so the existing endpoint's 400
                # response shape stays unchanged.
                raise _legacy_tbp.ParseError(
                    user_message=e.user_message,
                    technical_detail=e.technical_detail,
                )
        return self.attach_closing_result(
            _legacy_tbp.parse_trial_balance_file(content, filename)
        )

    def parse_pasted_trial_balance(self, text: str) -> List[Any]:
        return self.attach_closing_result(
            _legacy_tbp.parse_pasted_trial_balance(text)
        )

    def parse_trial_balance_csv(self, content: bytes, filename: str = "") -> List[Any]:
        """canonical_bs v2 — deterministic CSV path. CSVs previously went
        straight to the LLM extractor (audit item 1c); the parser now
        handles them with the same machinery (and the same
        TrialBalanceParseResult metadata) as XLSX."""
        return self.attach_closing_result(
            _legacy_tbp.parse_trial_balance_csv(content, filename)
        )

    def attach_closing_result(self, tb_rows: Any) -> Any:
        """CLOSING-IDENTITY MODE — enrich the parse result's
        `source_anchor` with the `closing_result` block: the current-year
        result read from the SAME closing column (solduri finale) as
        every balance-sheet leaf, in EXACT integer cents.

            closing_result = {
                "basis": "sf",
                "p121_cents":  Σ cents(sf_c − sf_d) over 121x rows,
                "pl_net_cents": Σ cents(sf_c − sf_d) over class 6/7 rows,
                "codes": sorted 121/6xx/7xx codes with a nonzero SF,
            }

        The equity result line is p121_cents + pl_net_cents — one
        formula for every closing state (post-closing: 6/7 SF are zero;
        pre-closing: 121 SF is zero; mixed: both terms carry). This is
        SOURCE data (the SF column), never a plug: on an imbalanced
        source the canonical_bs difference still surfaces the exact gap.

        Attached HERE (the pack parse seam) so both the pipeline's
        stage_extract (which calls `pack.parse_trial_balance*`) and the
        offline scripts pick it up from one code object. No-ops on
        parse results without an anchor dict (PDF plain lists) — those
        paths keep the builder's reconstruction fallback.
        """
        anchor = getattr(tb_rows, "source_anchor", None)
        if not isinstance(anchor, dict):
            return tb_rows
        p121_cents = 0
        pl_net_cents = 0
        codes: set = set()
        for r in tb_rows:
            if not isinstance(r, dict):
                continue
            code = str(r.get("cont") or "").strip()
            if not code:
                continue
            is_121 = code.startswith("121")
            is_pl = code[:1] in ("6", "7")
            if not (is_121 or is_pl):
                continue
            sf_d = int(round(float(r.get("sf_d") or 0) * 100))
            sf_c = int(round(float(r.get("sf_c") or 0) * 100))
            if is_121:
                p121_cents += sf_c - sf_d
            else:
                pl_net_cents += sf_c - sf_d
            if sf_d or sf_c:
                codes.add(code)
        anchor["closing_result"] = {
            "basis": "sf",
            "p121_cents": p121_cents,
            "pl_net_cents": pl_net_cents,
            "codes": sorted(codes),
        }
        return tb_rows

    def accounts_to_canonical_tsv(self, accounts: List[Any]) -> str:
        return _legacy_tbp.accounts_to_canonical_tsv(accounts)

    def accounts_to_assemble_shape(self, raw_rows: List[Any]) -> List[Any]:
        return _legacy_tbp.accounts_to_assemble_shape(raw_rows)

    def compute_statutory_net_profit_anchor(self, raw_rows: List[Any]) -> float:
        return _legacy_tbp.compute_statutory_net_profit_anchor(raw_rows)

    def compute_source_imbalance(self, raw_rows: List[Any]) -> dict:
        """F3.9 — Source-data quality telemetry. Returns a dict with
        sum_closing_debit/credit, raw_imbalance_pct, and a warn boolean
        (true when imbalance > 2%). See trial_balance_parser for the
        rationale — surfaces "source-data fault" vs "engine fault" to
        the operator before they read the analysis."""
        return _legacy_tbp.compute_source_imbalance(raw_rows)

    # ── 5. Account mapping ──────────────────────────────────
    def bucket_for(self, account_code: str) -> Optional[Any]:
        """Delegate to `_ro_coa.bucket_for()`. Returns the legacy
        `MappingRule` dataclass; F3.1d migrates to the
        country-agnostic `BucketRule` shape.
        """
        return _legacy_coa.bucket_for(account_code)

    def persistence_bucket(self, canonical_bucket: str) -> str:
        return _legacy_coa._persistence_bucket(canonical_bucket)

    # ── 6. Canonical assembly ───────────────────────────────
    def assemble_statements(
        self,
        accounts: List[Any],  # accepts ParsedAccount OR dict
        *,
        company_name: str = "Imported entity",
        currency: str = "RON",
        period_label: str = "Imported period",
        industry: Optional[str] = None,
        source_data_quality: Optional[dict] = None,
        account_121_anchor_override: Optional[float] = None,
        source_anchor: Optional[dict] = None,
        extraction_meta: Optional[dict] = None,
        source_account_census: Optional[int] = None,
        extra_unmapped: Optional[List[dict]] = None,
    ) -> AssembledEnvelope:
        """Delegate to `_ro_coa.assemble_statements()`. Accepts either
        the legacy dict shape or `ParsedAccount` instances and
        normalises before forwarding.

        F3.9 `source_data_quality` kwarg: pre-computed source telemetry
        from `compute_source_imbalance(rows)`. When provided, surfaces
        on the returned envelope under the same key for FE pre-analysis
        WARN rendering. Default None preserves byte-identical for
        existing capture flows.

        F3.16-3b.2 `account_121_anchor_override` kwarg: forwards the
        statutory net-profit anchor captured during `stage_extract`
        (Path A: `compute_statutory_net_profit_anchor` on raw TB rows;
        Path B: 121-prefix sum on Claude's account output). Lets the
        engine fire the 121 override even when preprocessing dropped
        the row. None → engine falls back to in-loop capture, which
        preserves byte-identical for callers that don't ship the
        anchor. See ADR-F3.16-closure.md for the full invariant set.

        canonical_bs v2 kwargs (`source_anchor` / `extraction_meta` /
        `source_account_census` / `extra_unmapped`): forwarded verbatim to
        the assembler so the emitted `canonical_bs` carries real
        extraction provenance and the external-conservation anchor per
        docs/CANONICAL_BS_V2_CONTRACT.md. All default None — callers that
        don't plumb them keep the builder's defensive defaults.
        """
        dict_accounts = [_account_to_dict(a) for a in accounts]
        return _legacy_coa.assemble_statements(
            dict_accounts,
            company_name=company_name,
            currency=currency,
            period_label=period_label,
            industry=industry,
            source_data_quality=source_data_quality,
            account_121_anchor_override=account_121_anchor_override,
            source_anchor=source_anchor,
            extraction_meta=extraction_meta,
            source_account_census=source_account_census,
            extra_unmapped=extra_unmapped,
        )

    # ── 6b. canonical_bs v2 integration glue ─────────────────
    # Shared by the pipeline (stage_extract/stage_map) AND the offline
    # scripts (verify_determinism / reprocess_documents) so the numeric
    # path is ONE code object — a hand-maintained mirror between the two
    # is exactly the drift hazard the audit flagged on
    # measure_bs_drift_roundtrip.py.

    def deterministic_source_census(self, shaped: List[Any]) -> Optional[int]:
        """Count of distinct source accounts that carry value and are
        handed to assembly (classified candidates + parser unmapped).
        This is the `source_account_census` the canonical_bs builder
        checks its `invariants.source_conservation` against.

        Constraint: zero-balance source rows and parser-level exclusions
        (class 8 / 581) are OUTSIDE this census — both the parser shape
        and the assembler drop zero amounts, and parser exclusions never
        reach the assembler (they are merged into canonical_bs.excluded
        post-assembly by `merge_parser_exclusions`). Including either
        would make the invariant permanently false instead of a real
        check for accounts LOST between parser handoff and canonical_bs.

        The nonzero-amount filter below uses the ROUNDED shaped amount:
        a sub-cent closing balance (e.g. -0.0029 RON) survives the
        parser's pre-round zero gate but rounds to ±0.00, which the
        assembler then skips as valueless — counting it here would fire
        source_conservation on a value-free row (real case: carniprod
        404.21).
        """
        codes = {
            str(a.get("code") or "")
            for a in shaped
            if isinstance(a, dict) and float(a.get("amount") or 0) != 0
        }
        for u in (getattr(shaped, "unmapped", None) or []):
            codes.add(str(u.get("code") or ""))
        codes.discard("")
        return len(codes) if codes else None

    # Parser-side exclusion reasons → the contract's canonical_bs.excluded
    # vocabulary (the builder's `_excluded_reason` emits the same enum).
    _PARSER_EXCLUDED_REASON_MAP = {
        "off_balance_class_8": "off_balance_memo_account",
        "ignore_transit": "transit_account_581",
        "ignore_control": "excluded_by_rule",
    }

    def merge_parser_exclusions(
        self, assembled: dict, parser_excluded: Optional[List[dict]]
    ) -> None:
        """Merge parser-level exclusions (class 8 incl. 891/892, 581
        transit — dropped BEFORE assembly by `accounts_to_assemble_shape`)
        into `canonical_bs.excluded`, in place.

        Constraint: `assemble_statements` has no `extra_excluded` kwarg
        (its `excluded` input is the assembler's own ignored_items), so
        the integration seam completes the block here. Deterministic:
        dedup by code (builder entries win), then re-sort by code —
        matching the builder's own ordering.
        """
        if not parser_excluded:
            return
        env = assembled.get("assembled_canonical_v1") if isinstance(assembled, dict) else None
        cbs = env.get("canonical_bs") if isinstance(env, dict) else None
        if not isinstance(cbs, dict):
            return
        by_code = {
            str(e.get("code") or ""): e
            for e in (cbs.get("excluded") or [])
            if isinstance(e, dict) and e.get("code")
        }
        for e in parser_excluded:
            if not isinstance(e, dict):
                continue
            code = str(e.get("code") or "")
            if not code or code in by_code:
                continue
            reason = str(e.get("reason") or "excluded_by_rule")
            by_code[code] = {
                "code": code,
                "reason": self._PARSER_EXCLUDED_REASON_MAP.get(reason, reason),
            }
        cbs["excluded"] = [by_code[c] for c in sorted(by_code)]

    def run_deterministic_tb(
        self,
        content: bytes,
        filename: str = "",
        *,
        company_name: str = "Imported entity",
        period_label: str = "Imported period",
        industry: Optional[str] = None,
        kind: str = "auto",
    ) -> Tuple[List[Any], List[Any], dict]:
        """OFFLINE deterministic parse + assemble — no DB, no LLM.

        The single entry point the determinism gate
        (scripts/verify_determinism.py) and the reprocessing tool
        (scripts/reprocess_documents.py) run; it composes the exact same
        calls the pipeline's stage_extract + stage_map make on the
        deterministic path, so the scripts audit the production numeric
        path rather than a mirror of it.

        `kind`: 'auto' dispatches on magic bytes (PDF / Excel container),
        anything else falls to the CSV parser; 'csv'/'xlsx'/'pdf' force a
        branch (reprocessing knows the stored mime).

        Returns (tb_rows, shaped, assembled) — assembled carries
        `assembled_canonical_v1.canonical_bs` with parser exclusions
        already merged.
        """
        is_pdf = content[:4] == b"%PDF"
        is_excel = (
            content[:4] == b"PK\x03\x04"
            or content[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
        )
        if kind == "csv" or (kind == "auto" and not is_pdf and not is_excel):
            tb_rows = self.parse_trial_balance_csv(content, filename)
        else:
            tb_rows = self.parse_trial_balance(content, filename)
        return self.assemble_parsed_tb(
            tb_rows,
            company_name=company_name,
            period_label=period_label,
            industry=industry,
        )

    def assemble_parsed_tb(
        self,
        tb_rows: Any,
        *,
        company_name: str = "Imported entity",
        period_label: str = "Imported period",
        industry: Optional[str] = None,
    ) -> Tuple[List[Any], List[Any], dict]:
        """The post-parse half of `run_deterministic_tb`: shape + anchor
        + assemble + exclusion-merge on already-parsed 10-col rows.

        Split out so test harnesses (the closing-identity property suite
        builds tb_rows dicts directly) run the PRODUCTION composition —
        the same calls stage_extract + stage_map make — instead of
        hand-mirroring it, which is the drift hazard the audit flagged
        on measure_bs_drift_roundtrip.py.
        """
        shaped = self.accounts_to_assemble_shape(tb_rows)
        assembled = self.assemble_statements(
            list(shaped),
            company_name=company_name,
            currency="RON",
            period_label=period_label,
            industry=industry,
            source_data_quality=self.compute_source_imbalance(tb_rows),
            account_121_anchor_override=self.compute_statutory_net_profit_anchor(tb_rows),
            source_anchor=getattr(tb_rows, "source_anchor", None),
            extraction_meta=getattr(tb_rows, "extraction", None),
            source_account_census=self.deterministic_source_census(shaped),
            extra_unmapped=list(getattr(shaped, "unmapped", None) or []),
        )
        self.merge_parser_exclusions(
            assembled, list(getattr(shaped, "excluded", None) or [])
        )
        return tb_rows, shaped, assembled

    # ── 7. Industry classification ──────────────────────────
    def classify_industry(self, signals: ClassifierSignals) -> dict:
        """Delegate to `_ro_coa.detect_industry()` when an assembled
        envelope is passed, or to `_caen_industry_map.caen_to_category()`
        when a CAEN code is provided. Returns the legacy dict shape
        `{industry_key, confidence, signals}` so pipeline.py call
        sites that read `.get("confidence", 0)` keep working.
        """
        if "caen" in signals:
            cat, label = _legacy_caen.caen_to_category(signals.get("caen"))
            return {
                "industry_key": cat or None,
                "confidence": 1.0 if cat else 0.0,
                "signals": {"caen_label": label, "caen": signals.get("caen")},
            }
        if "assembled" in signals:
            result = _legacy_coa.detect_industry(signals["assembled"])
            if isinstance(result, dict):
                return result
        return {"industry_key": None, "confidence": 0.0, "signals": {}}


# Side-effect: register the Romania pack with the country registry at
# import time. F3.1c switches pipeline.py to look the pack up by code.
register_pack(RomaniaPack())
