import { useEffect, useRef, useCallback } from "react";
import { onPtyData, ptyWrite } from "@/lib/tauri";

export interface UsePtyOptions {
  sessionId: string | null;
  onData: (data: string) => void;
  onExit: () => void;
}

export function usePty(options: UsePtyOptions) {
  const { sessionId, onData } = options;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    if (!sessionId) return;

    const cleanup = onPtyData((payload) => {
      if (payload.id === sessionId) {
        onDataRef.current(payload.data);
      }
    });
    return () => {
      cleanup.then((fn) => fn());
    };
  }, [sessionId]);

  const write = useCallback(
    (data: string) => {
      if (sessionId) {
        ptyWrite(sessionId, data);
      }
    },
    [sessionId],
  );

  return { write };
}
