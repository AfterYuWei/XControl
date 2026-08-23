import { describe, expect, it } from 'vitest'
import { applyVaultUsernameToProfile, normalizeVaultUsername, vaultNeedsUsername } from './vaultUsername'

describe('vault username ownership', () => {
  it('keeps a trimmed username only for password credentials', () => {
    expect(normalizeVaultUsername('password', '  root  ')).toBe('root')
    expect(normalizeVaultUsername('private_key', 'root')).toBe('')
  })

  it('marks only password credentials without a username as incomplete', () => {
    expect(vaultNeedsUsername({ type: 'password', username: ' ' })).toBe(true)
    expect(vaultNeedsUsername({ type: 'private_key', username: '' })).toBe(false)
  })

  it('applies password usernames and clears only previously automatic values for keys', () => {
    expect(applyVaultUsernameToProfile({ type: 'password', username: ' admin ' }, 'root', '')).toEqual({
      username: 'admin',
      autoUsername: 'admin',
    })
    expect(applyVaultUsernameToProfile({ type: 'private_key', username: '' }, 'admin', 'admin')).toEqual({
      username: '',
      autoUsername: '',
    })
    expect(applyVaultUsernameToProfile({ type: 'private_key', username: '' }, 'deploy', 'admin')).toEqual({
      username: 'deploy',
      autoUsername: '',
    })
  })
})
