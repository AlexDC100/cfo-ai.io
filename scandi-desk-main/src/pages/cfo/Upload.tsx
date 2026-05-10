// /upload — DEPRECATED in the upload-consolidation pass.
//
// The standalone Upload page was one of four duplicate "upload a document"
// surfaces in the app. All four were collapsed into the canonical /dashboard
// surface (empty-state zone when no period loaded, Replace dropdown when one
// is). The route is still wired up in App.tsx as a RedirectPreservingQuery
// → /dashboard so legacy bookmarks and external links don't 404, but this
// file's component body is intentionally a no-op redirect for defense in
// depth (in case the App.tsx route falls back to rendering this page).
//
// Per the consolidation prompt's rule:
//   "Don't delete the route file for /upload in this commit — replace its
//    body with a redirect."
//
// A follow-up commit can remove this file entirely once a grep confirms no
// internal links still reference it.

import { Navigate } from "react-router-dom";

export default function UploadPage() {
  return <Navigate to="/dashboard" replace />;
}
