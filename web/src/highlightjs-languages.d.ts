/**
 * Ambient types for highlight.js language modules.
 *
 * `highlight.js/lib/languages/*` ships plain JS with no .d.ts (the package's exports
 * map has no `types` entry for it), so a static import of one would fall back to
 * `any` under noImplicitAny. Each module's default export is a `LanguageFn` — the
 * same shape lowlight's `createLowlight` accepts.
 */
declare module 'highlight.js/lib/languages/*' {
  const language: import('highlight.js').LanguageFn
  export default language
}
