#!/bin/bash
# Stripe Live Mode setup — colectează sk_live_ + whsec_ interactiv (input ascuns),
# le pune în /opt/cfo-ai/.env pe VPS, restartează backend. Secretele nu apar niciodată
# pe ecran și nu trec prin contextul AI-ului.

set -e

echo "============================================="
echo "  Stripe Live Mode — go-live env setup"
echo "============================================="
echo

# 1. Live secret key (de la Stripe Dashboard → Developers → API keys → reveal Live)
read -rsp "1/2 — Paste sk_live_xxx și apasă Enter (input ascuns): " SK_LIVE
echo
if [[ ! "$SK_LIVE" =~ ^sk_live_ ]]; then
  echo "EROARE: trebuie să înceapă cu sk_live_  (ai dat ceva care începe cu '${SK_LIVE:0:8}')"
  exit 1
fi
echo "  sk_live_ OK (lungime ${#SK_LIVE} chars)"
echo

# 2. NOUL webhook signing secret (după ce ai dat Roll signing secret în Dashboard)
read -rsp "2/2 — Paste NOUL whsec_xxx (după Roll) și apasă Enter (input ascuns): " WHSEC_LIVE
echo
if [[ -z "$WHSEC_LIVE" ]]; then
  echo "EROARE: ai apăsat Enter fără să paste-ui — webhook secret e obligatoriu pentru live mode."
  exit 1
fi
if [[ ! "$WHSEC_LIVE" =~ ^whsec_ ]]; then
  echo "EROARE: trebuie să înceapă cu whsec_  (ai dat ceva care începe cu '${WHSEC_LIVE:0:8}')"
  exit 1
fi
echo "  whsec_ OK (lungime ${#WHSEC_LIVE} chars)"
echo

echo "Trimit pe VPS și update-uiesc .env..."
echo

ssh root@187.124.0.37 "set -e
ENV=/opt/cfo-ai/.env
upd() {
  if grep -q \"^\$1=\" \"\$ENV\" 2>/dev/null; then
    sed -i \"s|^\$1=.*|\$1=\$2|\" \"\$ENV\"
    echo \"  UPDATED \$1\"
  else
    echo \"\$1=\$2\" >> \"\$ENV\"
    echo \"  APPENDED \$1\"
  fi
}
upd STRIPE_SECRET_KEY      '${SK_LIVE}'
upd STRIPE_PRICE_INTRO     'price_1TawAjAKgRykW6QzdzcM8MHt'
upd STRIPE_PRICE_STARTER   'price_1TawB6AKgRykW6QzUf0mmWVs'
upd STRIPE_PRICE_PRO       'price_1TawBNAKgRykW6QzPDZAfGGY'
upd STRIPE_WEBHOOK_SECRET  '${WHSEC_LIVE}'
echo
echo \"Restart backend...\"
cd /opt/cfo-ai && docker compose up -d --force-recreate backend
echo
echo \"GATA. Backend a pornit. Așteaptă 6 secunde apoi verifică în Claude.\"
"

# Cleanup — uită valorile din memoria shell-ului local
unset SK_LIVE WHSEC_LIVE

echo
echo "============================================="
echo "  Done. Spune-i lui Claude 'rulat' ca să"
echo "  verifice livemode=True."
echo "============================================="
