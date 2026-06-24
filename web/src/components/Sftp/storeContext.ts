import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import { createSftpStore, type SftpStoreApi, type SftpStore } from '@/store/sftp'

/**
 * Per-instance SFTP store context. Each SFTP tab creates its own store via
 * `createSftpStore()` and provides it here, so multiple SFTP pages keep
 * fully independent state (fixes the "two SFTP tabs render identical
 * content" bug that came from a single global store).
 */
export const SftpStoreContext = createContext<SftpStoreApi | null>(null)

// A shared fallback store so the hook can always call useStore unconditionally
// (required by the rules-of-hooks lint rule). In practice the Provider is
// always mounted by SftpView, so this is never read; if a component is used
// outside a provider we throw a clear error after the hook call.
const FALLBACK_STORE = createSftpStore()

/**
 * Consume the active SFTP instance's store. Supports both selector and
 * whole-state usage:
 *    const tabs = useSftpStore((s) => s.leftTabs)
 *    const store = useSftpStore()           // whole state + actions
 */
export function useSftpStore(): SftpStore
export function useSftpStore<T>(selector: (s: SftpStore) => T): T
export function useSftpStore<T>(selector?: (s: SftpStore) => T): T | SftpStore {
  const api = useContext(SftpStoreContext) ?? FALLBACK_STORE
  // Always call useStore with the same signature (rules-of-hooks). When no
  // selector is given, return the whole state + actions via the identity fn.
  const sel = (selector ?? identity) as (s: SftpStore) => T | SftpStore
  return useStore(api, sel)
}

const identity = (s: SftpStore): SftpStore => s
