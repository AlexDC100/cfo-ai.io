import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

const NotFound = () => {
  const location = useLocation();
  const { t } = useTranslation();

  useEffect(() => {
    // WARN, not ERROR. A visitor reaching a path we do not serve is a
    // normal event — a stale bookmark, a mistyped URL, a link from an old
    // email. Logging it at error level put a console.error on a designed,
    // working page: it reds the launch's "zero console errors" gate (LR2),
    // and once error tracking is wired it would page someone every time a
    // crawler probes /wp-admin. The signal is still here, at the level the
    // event actually has.
    console.warn("404: no route for", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">{t("notFound.title")}</h1>
        <p className="mb-4 text-xl text-muted-foreground">{t("notFound.body")}</p>
        <a href="/" className="text-primary underline hover:text-primary/90">
          {t("notFound.back_home")}
        </a>
      </div>
    </div>
  );
};

export default NotFound;
