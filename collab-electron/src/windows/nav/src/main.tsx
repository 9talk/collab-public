import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initDarkMode } from "@collab/shared/dark-mode";
import "@collab/shared/styles/Theme.css";
import "./styles/App.css";
import "@collab/components/TreeView/TreeView.css";
import App from "./App";
import { AnalyticsProvider } from "../../shared/PostHogProvider";

initDarkMode();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <AnalyticsProvider>
      <App />
    </AnalyticsProvider>
  </StrictMode>,
);
