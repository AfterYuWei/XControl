import { describe, expect, it } from 'vitest'

import { buildPrivateKeyFilename, buildPublicKeyImportCommand } from './vaultKeyActions'

describe('vault key actions', () => {
  it('builds a safe private-key filename', () => {
    expect(buildPrivateKeyFilename(' production/root:key ')).toBe('production-root-key.key')
    expect(buildPrivateKeyFilename('deploy.pem')).toBe('deploy.pem')
    expect(buildPrivateKeyFilename(' . ')).toBe('ssh-private-key.key')
  })

  it('builds an authorized_keys import command', () => {
    const command = buildPublicKeyImportCommand(" ssh-ed25519 AAAA test'user \n")

    expect(command).toContain('mkdir -p ~/.ssh')
    expect(command).toContain('chmod 700 ~/.ssh')
    expect(command).toContain("ssh-ed25519 AAAA test'\"'\"'user")
    expect(command).toContain('>> ~/.ssh/authorized_keys')
    expect(command).toContain('chmod 600 ~/.ssh/authorized_keys')
  })
})
