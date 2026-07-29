import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { installDevBackendCircuitBreaker } from "./lib/devBackendCircuitBreaker";
import { setupQueryPersistence } from "./lib/queryPersist";

// Dev-only: stop a not-running local backend from spamming ERR_CONNECTION_REFUSED
// and making every page retry a doomed round-trip. No-op in production.
installDevBackendCircuitBreaker();

// Hydrate the TanStack Query cache from localStorage BEFORE first render so a
// reload / return visit paints pages from cached data instantly (staleTime
// still governs background revalidation). See lib/queryPersist.ts.
setupQueryPersistence();

createRoot(document.getElementById("root")!).render(<App />);
