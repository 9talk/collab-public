// @xterm 包的 main(CJS)用动态属性拷贝导出, 且 module 字段指向失效旧路径;
// 运行时改从包内 .mjs 子路径导入(见 session-emulator.ts 注释)。此声明把
// 子路径模块的类型转发到包根 typings。
declare module "@xterm/headless/lib-headless/xterm-headless.mjs" {
  export * from "@xterm/headless";
}

declare module "@xterm/addon-serialize/lib/addon-serialize.mjs" {
  export * from "@xterm/addon-serialize";
}
