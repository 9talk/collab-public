/// <reference types="vite/client" />

declare module "*?worker" {
  const workerFactory: {
    new (): Worker;
  };
  export default workerFactory;
}

declare module "*?worker&inline" {
  const workerFactory: {
    new (): Worker;
  };
  export default workerFactory;
}

declare module "*?worker&url" {
  const workerUrl: string;
  export default workerUrl;
}

declare module "*?raw" {
  const content: string;
  export default content;
}

// NodeJS namespace for platform type compatibility
declare namespace NodeJS {
  type Platform =
    | "aix"
    | "android"
    | "darwin"
    | "freebsd"
    | "haiku"
    | "linux"
    | "openbsd"
    | "sunos"
    | "win32"
    | "cygwin"
    | "netbsd";
}

// Global WriteResult type
interface WriteResult {
  ok: boolean;
  mtime: string;
  conflict?: boolean;
}
