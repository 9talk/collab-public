import { useCallback, useEffect, useRef, useState } from "react";

interface UseInlineAliasReturn {
  aliasingPath: string | null;
  aliasValue: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  startAlias: (
    path: string,
    initialValue: string,
    existingAlias?: string,
  ) => void;
  cancelAlias: () => void;
  confirmAlias: () => void;
  setAliasValue: (value: string) => void;
}

export function useInlineAlias(
  onSaveAlias: (path: string, newAlias: string) => void,
): UseInlineAliasReturn {
  const [aliasingPath, setAliasingPath] = useState<string | null>(null);
  const [aliasValue, setAliasValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingSelectRef = useRef(false);
  const originalValueRef = useRef("");

  const startAlias = useCallback(
    (path: string, initialValue: string, existingAlias?: string) => {
      setAliasingPath(path);
      setAliasValue(initialValue);
      originalValueRef.current = existingAlias ?? "";
      pendingSelectRef.current = true;
    },
    [],
  );

  const cancelAlias = useCallback(() => {
    setAliasingPath(null);
    setAliasValue("");
    pendingSelectRef.current = false;
  }, []);

  const confirmAlias = useCallback(() => {
    if (!aliasingPath) return;
    const trimmed = aliasValue.trim();
    if (trimmed === originalValueRef.current) {
      cancelAlias();
      return;
    }
    onSaveAlias(aliasingPath, trimmed);
    cancelAlias();
  }, [aliasingPath, aliasValue, onSaveAlias, cancelAlias]);

  useEffect(() => {
    if (!aliasingPath || !pendingSelectRef.current) return;
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      pendingSelectRef.current = false;
    } else {
      const raf = requestAnimationFrame(() => {
        if (inputRef.current && pendingSelectRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
          pendingSelectRef.current = false;
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  });

  return {
    aliasingPath,
    aliasValue,
    inputRef,
    startAlias,
    cancelAlias,
    confirmAlias,
    setAliasValue,
  };
}
