import type { Profile, ProfileProxy, ProfileProxyInput, ProxyType } from '@/types/profile'

export function proxyInputFromProfile(proxy?: ProfileProxy): ProfileProxyInput {
  if (!proxy || proxy.type === 'direct') return { type: 'direct' }
  if (proxy.type === 'jump') return { type: 'jump', jump_profile_id: proxy.jump_profile_id || '' }
  return {
    type: proxy.type,
    host: proxy.host || '',
    port: proxy.port || (proxy.type === 'socks5' ? 1080 : 8080),
    username: proxy.username || '',
  }
}

export function newProxyInput(type: ProxyType): ProfileProxyInput {
  if (type === 'socks5') return { type, port: 1080 }
  if (type === 'http') return { type, port: 8080 }
  return { type }
}

export function jumpProfileCandidates(profiles: Profile[], currentProfileId?: string): Profile[] {
  return profiles.filter((profile) => profile.id !== currentProfileId)
}
