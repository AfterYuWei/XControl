import { describe, expect, it } from 'vitest'
import { jumpProfileCandidates, newProxyInput, proxyInputFromProfile } from './profileProxy'
import type { Profile } from '@/types/profile'

describe('profile proxy form helpers', () => {
  it('does not expose or resubmit an existing password', () => {
    const input = proxyInputFromProfile({ type: 'socks5', host: 'proxy', port: 1080, username: 'alice', has_password: true })
    expect(input).toEqual({ type: 'socks5', host: 'proxy', port: 1080, username: 'alice' })
    expect('password' in input).toBe(false)
    expect({ ...input, password: '' }).toHaveProperty('password', '')
  })

  it('applies protocol defaults and drops fields when switching type', () => {
    expect(newProxyInput('socks5')).toEqual({ type: 'socks5', port: 1080 })
    expect(newProxyInput('http')).toEqual({ type: 'http', port: 8080 })
    expect(newProxyInput('jump')).toEqual({ type: 'jump' })
    expect(newProxyInput('direct')).toEqual({ type: 'direct' })
  })

  it('excludes the profile itself from jump candidates', () => {
    const profiles = [{ id: 'a' }, { id: 'b' }] as Profile[]
    expect(jumpProfileCandidates(profiles, 'a').map((profile) => profile.id)).toEqual(['b'])
  })
})
