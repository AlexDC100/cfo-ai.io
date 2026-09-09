// The dialog behind lib/authPrompt's promptSignIn(). Mounted once in
// AppRoutes (App.tsx) so every surface — the shell pages, /chat, the
// anonymous /public-companies route — shares the same prompt. Renders
// nothing for signed-in users: a stray promptSignIn() after authentication
// must never nag someone who already has a session.

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { onSignInPrompt } from "@/lib/authPrompt";

export function SignInPromptDialog() {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => onSignInPrompt(() => setOpen(true)), []);

  if (isAuthenticated) return null;

  // Same sanitized `next` contract Login.tsx expects — the user returns to
  // the page (and period/tab query state) they were on when prompted.
  const next = encodeURIComponent(location.pathname + location.search);

  const go = (path: string) => {
    setOpen(false);
    navigate(`${path}?next=${next}`);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("authPrompt.title")}</DialogTitle>
          <DialogDescription>{t("authPrompt.body")}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("authPrompt.cancel")}
          </Button>
          <Button variant="outline" onClick={() => go("/signup")}>
            {t("authPrompt.createAccount")}
          </Button>
          <Button onClick={() => go("/login")}>{t("authPrompt.signIn")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
