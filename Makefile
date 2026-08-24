# Engine operator targets. Each target is a thin, audited wrapper — the
# real logic lives in scripts/ so CI and humans run identical code.

ADR := docs/decisions/ADR-corpus-history-sibiu.md
PY  := .venv/bin/python

.PHONY: supply-chain supply-chain-artifacts
# Gate: planted-violation self-test first, then the live tree scan
# (lock shape/sync, Dockerfile-installs-from-lock, image tags, secrets).
supply-chain:
	$(PY) scripts/check_supply_chain.py --self-test
	$(PY) scripts/check_supply_chain.py

# Per-build artifacts: CycloneDX SBOM + SLSA provenance, written to the
# gitignored deploy/artifacts/. Run on every deploy, ship the directory
# alongside the image.
supply-chain-artifacts:
	$(PY) scripts/generate_sbom.py
	$(PY) scripts/generate_provenance.py

.PHONY: adr-confirm
# Usage: make adr-confirm OWNER=eei|client
# Flips the Sibiu ADR's document-owner line from the conservative
# UNCONFIRMED default to the owner's confirmed answer. Anything other
# than eei|client refuses. The edit is an ordinary tracked change —
# commit it with a message quoting who confirmed and when.
adr-confirm:
	@case "$(OWNER)" in \
	  eei) NEW="Owner: CONFIRMED — EEI'\''s own document. Review triggers remain prudent hygiene, acted on at the owner'\''s pace.";; \
	  client) NEW="Owner: CONFIRMED — CLIENT DOCUMENT. All review triggers are BINDING; the \"client or legal request\" trigger is a live notification duty.";; \
	  *) echo "usage: make adr-confirm OWNER=eei|client" >&2; exit 2;; \
	esac; \
	python3 -c "import re,sys; p='$(ADR)'; s=open(p).read(); \
new='$$NEW'; \
pat=re.compile(r'\*\*Owner: [^*]+\*\*', re.S); \
assert pat.search(s), 'owner line not found — ADR format changed?'; \
open(p,'w').write(pat.sub('**'+new+'**', s, count=1)); \
print('ADR owner line updated ->', new)"
