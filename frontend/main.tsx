import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { installDevBackendCircuitBreaker } from "./lib/devBackendCircuitBreaker";

// Dev-only: stop a not-running local backend from spamming ERR_CONNECTION_REFUSED
// and making every page retry a doomed round-trip. No-op in production.
installDevBackendCircuitBreaker();

createRoot(document.getElementById("root")!).render(<App />);
