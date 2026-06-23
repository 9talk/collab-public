import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "@posthog/react";
import { useEffect, useState, type ReactNode } from "react";

let crashReportingInitialized = false;

function initCrashReporting(): void {
  if (crashReportingInitialized) return;
  crashReportingInitialized = true;

  window.addEventListener("error", (event) => {
    posthog.capture("renderer_crash", {
      type: "error",
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const error =
      event.reason instanceof Error
        ? event.reason
        : new Error(String(event.reason));
    posthog.capture("renderer_crash", {
      type: "unhandledrejection",
      message: error.message,
      stack: error.stack,
    });
  });
}

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const key = import.meta.env.RENDERER_VITE_POSTHOG_KEY;
    const host = import.meta.env.RENDERER_VITE_POSTHOG_HOST;
    if (!key || !host) return;

    window.api
      .getDeviceId()
      .then((deviceId) => {
        if (!posthog.__loaded) {
          posthog.init(key, {
            api_host: host,
            autocapture: false,
            capture_pageview: false,
            capture_pageleave: false,
            persistence: "localStorage",
            person_profiles: "always",
            bootstrap: { distinctId: deviceId },
          });
        }
        posthog.identify(deviceId);
        initCrashReporting();
        setReady(true);
      })
      .catch((err) => {
        console.warn("[analytics] Failed to initialize PostHog:", err);
      });
  }, []);

  if (!ready) return <>{children}</>;
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
