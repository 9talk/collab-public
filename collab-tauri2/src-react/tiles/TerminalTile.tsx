import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ptyCreate, ptyKill, ptyWrite } from "@/lib/tauri";
import { usePty } from "@/hooks/useTauri";

interface TerminalTileProps {
  tileId: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export default function TerminalTile({
  tileId,
  cwd,
  cols = 80,
  rows = 24,
}: TerminalTileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      cols,
      rows,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    ptyCreate({ cwd, cols, rows }).then((id) => {
      sessionIdRef.current = id;
    });

    return () => {
      if (sessionIdRef.current) {
        ptyKill(sessionIdRef.current);
      }
      term.dispose();
    };
  }, [tileId]);

  const handleData = useCallback((data: string) => {
    terminalRef.current?.write(data);
  }, []);

  usePty({
    sessionId: sessionIdRef.current,
    onData: handleData,
    onExit: () => {},
  });

  const handleInput = useCallback((data: string) => {
    if (sessionIdRef.current) {
      ptyWrite(sessionIdRef.current, data);
    }
  }, []);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    const dispose = term.onData(handleInput);
    return () => dispose.dispose();
  }, [handleInput]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-black"
    />
  );
}
