import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initUiStateStorage } from "./lib/ui-state-storage";
import { initUiSessionPersistence } from "./lib/ui-session-persistence";
import "./App.css";

async function bootstrap() {
  // Restore persisted UI state (tab sessions, file browser expansion) before
  // the UI mounts so components render the restored state directly.
  await initUiStateStorage();
  initUiSessionPersistence();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
