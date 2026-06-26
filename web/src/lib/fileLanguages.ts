/** Language detection for the built-in editor.
 *
 *  This mapping is a frontend mirror of the backend `detectLanguage` in
 *  `server/gateway/handler/sftp_editor.go`. The backend returns a `language`
 *  hint in SftpFileReadResponse, but we keep this table so the UI can:
 *    1. Pre-show a language badge before the read completes.
 *    2. Let the user manually switch language in the editor (overrides hint).
 *
 *  Keep both sides in sync when adding new extensions. */

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_history': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.dockerignore': 'plaintext',
  '.editorconfig': 'ini',
  'nginx.conf': 'nginx',
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  ini: 'ini',
  cfg: 'ini',
  conf: 'nginx',
  properties: 'ini',
  props: 'ini',
  lua: 'lua',
  pl: 'perl',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  dart: 'dart',
  txt: 'plaintext',
  log: 'plaintext',
}

/** Detect the Monaco language id for a POSIX path. Returns "plaintext" when
 *  no rule matches. Mirrors backend detectLanguage. */
export function detectLanguage(path: string): string {
  const slash = path.lastIndexOf('/')
  const base = slash >= 0 ? path.slice(slash + 1) : path
  const lower = base.toLowerCase()

  // Special filenames win over extension rules.
  if (LANGUAGE_BY_NAME[lower]) return LANGUAGE_BY_NAME[lower]

  // Dockerfile variants: Dockerfile.dev, Dockerfile.production, etc.
  if (lower.startsWith('dockerfile.')) return 'dockerfile'

  // *.conf → nginx (common on XControl target hosts)
  if (lower.endsWith('.conf')) return 'nginx'

  const dot = lower.lastIndexOf('.')
  if (dot < 0 || dot === lower.length - 1) return 'plaintext'
  const ext = lower.slice(dot + 1)
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}
