/// <reference types="vite/client" />

// Injected by Vite's `define` from the root package.json version (see vite.config.ts).
declare const __APP_VERSION__: string

// turndown-plugin-gfm ships no type declarations; used by lib/docConvert.ts.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  export const gfm: TurndownService.Plugin
  export const tables: TurndownService.Plugin
  export const strikethrough: TurndownService.Plugin
  export const taskListItems: TurndownService.Plugin
}
