// toastWithI18n — thin wrapper that forces toast call sites through i18n.
//
// Usage:
//   import { useI18nToast } from '@/lib/toastWithI18n';
//   const tToast = useI18nToast();
//   tToast.success('toasts.settingsSaved');
//   tToast.error('errors.uploadFailed', { fileName: name });
//   tToast.fromError(err);                              // I18nError-aware
//
// The fromError() path handles three cases:
//   - I18nError → translate its i18nKey + params
//   - Error w/ recognizable message → fall back to errors.generic
//   - non-Error throwables → errors.generic with the value stringified
//
// Why a hook (and not a plain function): the underlying useToast already
// depends on React context, so we hook into it once + return a stable API.

import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { isI18nError } from "./i18nError";

export interface I18nToastApi {
  /** Show a toast whose title comes from an i18n key. */
  show: (titleKey: string, params?: Record<string, unknown>) => void;
  /** success variant. */
  success: (titleKey: string, params?: Record<string, unknown>) => void;
  /** Error variant — also accepts a description key + params. */
  error: (
    titleKey: string,
    params?: Record<string, unknown>,
    descriptionKey?: string,
  ) => void;
  /** Catch-all for thrown errors. Routes I18nError through its key; others
   *  fall back to `errors.generic`. */
  fromError: (err: unknown, fallbackKey?: string) => void;
}

export function useI18nToast(): I18nToastApi {
  const { t } = useTranslation();
  const { toast } = useToast();

  return {
    show: (titleKey, params) =>
      toast({ title: t(titleKey, params) }),
    success: (titleKey, params) =>
      toast({ title: t(titleKey, params) }),
    error: (titleKey, params, descriptionKey) =>
      toast({
        title: t(titleKey, params),
        description: descriptionKey ? t(descriptionKey, params) : undefined,
        variant: "destructive",
      }),
    fromError: (err, fallbackKey = "errors.generic") => {
      if (isI18nError(err)) {
        toast({
          title: t(err.i18nKey, err.i18nParams),
          variant: "destructive",
        });
        return;
      }
      // Best-effort: include the raw error message in description so devs
      // debugging via screen-share can read it; users still see the
      // translated generic title.
      toast({
        title: t(fallbackKey),
        description:
          err instanceof Error ? err.message : String(err ?? ""),
        variant: "destructive",
      });
    },
  };
}
