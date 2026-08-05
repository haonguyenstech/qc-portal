/**
 * Syntax highlighting for fenced code blocks (chat answers, and anywhere else that
 * renders assistant markdown).
 *
 * `highlight.js` ships 190+ languages; importing the barrel would add ~1 MB to a bundle
 * that already warns about chunk size. So this loads `lib/core` and registers only the
 * languages a QC engineer actually gets back — LAZILY, on the first code block that needs
 * one, and cached after that. A page with no code in it pays nothing.
 *
 * Unknown/absent language → no highlighting, and the caller still renders the plain text.
 * That's the important half: highlighting is decoration, never a precondition for reading
 * the answer.
 */

/** Language id → the highlight.js module that defines it. Aliases share a loader. */
const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  python: () => import('highlight.js/lib/languages/python'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  xml: () => import('highlight.js/lib/languages/xml'), // also HTML/JSX markup
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  java: () => import('highlight.js/lib/languages/java'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  swift: () => import('highlight.js/lib/languages/swift'),
  dart: () => import('highlight.js/lib/languages/dart'),
  go: () => import('highlight.js/lib/languages/go'),
  php: () => import('highlight.js/lib/languages/php'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  ini: () => import('highlight.js/lib/languages/ini'), // .env / .toml-ish
  diff: () => import('highlight.js/lib/languages/diff'),
  http: () => import('highlight.js/lib/languages/http'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
}

/**
 * What a fence is usually labelled versus what highlight.js calls it. `ts`/`tsx` map to
 * typescript, `html`/`vue` to xml, and so on — a mislabelled fence should still colour.
 */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  svg: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  cs: 'csharp',
  'c#': 'csharp',
  kt: 'kotlin',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  docker: 'dockerfile',
  env: 'ini',
  toml: 'ini',
  properties: 'ini',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  tsql: 'sql',
  plsql: 'sql',
  patch: 'diff',
  gql: 'graphql',
  curl: 'bash',
}

type Hljs = {
  registerLanguage: (name: string, def: unknown) => void
  getLanguage: (name: string) => unknown
  highlight: (code: string, opts: { language: string; ignoreIllegals?: boolean }) => {
    value: string
  }
}

let corePromise: Promise<Hljs> | null = null
const registered = new Set<string>()

function core(): Promise<Hljs> {
  corePromise ??= import('highlight.js/lib/core').then((m) => m.default as unknown as Hljs)
  return corePromise
}

/** The highlight.js name for a fence label, or null if we don't ship that language. */
export function resolveLanguage(label: string | undefined): string | null {
  if (!label) return null
  const key = label.trim().toLowerCase()
  const name = ALIASES[key] ?? key
  return name in LOADERS ? name : null
}

/**
 * Highlight `code` as `language`, returning highlight.js's HTML (`<span class="hljs-…">`
 * tokens, with the source escaped by the library). Returns null when the language isn't
 * one we ship or the highlighter fails to load — the caller then renders plain text.
 */
export async function highlightCode(code: string, language: string): Promise<string | null> {
  const name = resolveLanguage(language)
  if (!name) return null
  try {
    const hljs = await core()
    if (!registered.has(name)) {
      const mod = await LOADERS[name]()
      hljs.registerLanguage(name, mod.default)
      registered.add(name)
    }
    // ignoreIllegals: a half-written snippet from a chat answer is normal input here, and
    // a syntax error must not throw the whole block back to plain text.
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  } catch {
    return null
  }
}
