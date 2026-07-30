const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*]/g

export function buildPrivateKeyFilename(name: string): string {
  const safeName = [...name]
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .trim()
    .replace(INVALID_FILENAME_CHARACTERS, '-')
    .replace(/[.\s]+$/g, '')
    .slice(0, 80)

  if (!safeName) return 'ssh-private-key.key'
  if (/\.(?:key|pem)$/i.test(safeName)) return safeName
  return `${safeName}.key`
}

function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function buildPublicKeyImportCommand(publicKey: string): string {
  const normalizedKey = publicKey.trim()

  return [
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    `printf '%s\\n' ${quoteForPosixShell(normalizedKey)} >> ~/.ssh/authorized_keys`,
    'chmod 600 ~/.ssh/authorized_keys',
  ].join(' && ')
}
