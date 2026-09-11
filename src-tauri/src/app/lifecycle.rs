//! Mobile foreground/background policy shared by Android and iOS adapters.

use std::sync::{Arc, Mutex};

use serde::Serialize;

pub(crate) const BACKGROUND_KEEPALIVE_SECONDS: u64 = 360;
pub(crate) const RECONNECT_BACKOFF_SECONDS: [u64; 10] = [1, 2, 4, 8, 16, 30, 30, 30, 30, 30];
const BACKGROUND_KEEPALIVE_MILLIS: i64 = (BACKGROUND_KEEPALIVE_SECONDS as i64) * 1_000;

#[derive(Clone, Default)]
pub(crate) struct LifecycleCoordinator {
    state: Arc<Mutex<LifecycleState>>,
}

#[derive(Debug, Default)]
struct LifecycleState {
    generation: u64,
    network_generation: u64,
    native_network_generation: Option<u64>,
    online: Option<bool>,
    foreground: bool,
    background_since: Option<i64>,
    deadline: Option<i64>,
    expired: bool,
    active_sessions: usize,
    last_reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifecycleSnapshot {
    pub generation: u64,
    pub network_generation: u64,
    pub network_state: &'static str,
    pub state: &'static str,
    pub background_since: Option<i64>,
    pub deadline: Option<i64>,
    pub remaining_seconds: u64,
    pub background_elapsed_seconds: u64,
    pub expired: bool,
    pub active_sessions: usize,
    pub last_reason: String,
}

impl LifecycleCoordinator {
    pub(crate) fn new() -> Self {
        let coordinator = Self::default();
        coordinator
            .state
            .lock()
            .expect("lifecycle mutex poisoned")
            .foreground = true;
        coordinator
            .state
            .lock()
            .expect("lifecycle mutex poisoned")
            .last_reason = "app_started".into();
        coordinator
    }

    pub(crate) fn enter_background(
        &self,
        now_millis: i64,
        active_sessions: usize,
    ) -> LifecycleSnapshot {
        let mut state = self.state.lock().expect("lifecycle mutex poisoned");
        state.generation = state.generation.wrapping_add(1);
        state.foreground = false;
        state.background_since = Some(now_millis);
        state.deadline = Some(now_millis.saturating_add(BACKGROUND_KEEPALIVE_MILLIS));
        state.expired = false;
        state.active_sessions = active_sessions;
        state.last_reason = "entered_background".into();
        snapshot(&state, now_millis)
    }

    /// Returns whether the just-finished background window had expired.
    pub(crate) fn enter_foreground(&self, now_millis: i64) -> (LifecycleSnapshot, bool) {
        let mut state = self.state.lock().expect("lifecycle mutex poisoned");
        refresh_expiration(&mut state, now_millis);
        let expired = state.expired;
        state.generation = state.generation.wrapping_add(1);
        state.foreground = true;
        state.background_since = None;
        state.deadline = None;
        state.expired = false;
        state.active_sessions = 0;
        state.last_reason = if expired {
            "foreground_reconnect_after_background_limit".into()
        } else {
            "entered_foreground".into()
        };
        (snapshot(&state, now_millis), expired)
    }

    pub(crate) fn expire_generation(&self, generation: u64, now_millis: i64) -> bool {
        let mut state = self.state.lock().expect("lifecycle mutex poisoned");
        if state.foreground || state.generation != generation {
            return false;
        }
        refresh_expiration(&mut state, now_millis);
        if state.expired {
            state.last_reason = "background_limit".into();
        }
        state.expired
    }

    /// Marks the current background window as expired when the OS revokes it early.
    pub(crate) fn force_expire(&self, now_millis: i64) -> Option<LifecycleSnapshot> {
        let mut state = self.state.lock().expect("lifecycle mutex poisoned");
        if state.foreground {
            return None;
        }
        state.expired = true;
        state.last_reason = "os_background_expiration".into();
        Some(snapshot(&state, now_millis))
    }

    pub(crate) fn update_network(
        &self,
        online: bool,
        native_generation: Option<u64>,
        now_millis: i64,
    ) -> LifecycleSnapshot {
        let mut state = self.state.lock().expect("lifecycle mutex poisoned");
        let state_changed = state.online != Some(online);
        let native_changed = native_generation
            .is_some_and(|generation| state.native_network_generation != Some(generation));
        if state_changed || native_changed {
            state.online = Some(online);
            if native_generation.is_some() {
                state.native_network_generation = native_generation;
            }
            state.network_generation = state.network_generation.wrapping_add(1);
            state.last_reason = if online {
                "network_online".into()
            } else {
                "network_offline".into()
            };
        }
        refresh_expiration(&mut state, now_millis);
        snapshot(&state, now_millis)
    }

    pub(crate) fn snapshot(&self, now_millis: i64) -> LifecycleSnapshot {
        let mut state = self.state.lock().expect("lifecycle mutex poisoned");
        refresh_expiration(&mut state, now_millis);
        snapshot(&state, now_millis)
    }
}

fn refresh_expiration(state: &mut LifecycleState, now_millis: i64) {
    if !state.foreground
        && state
            .deadline
            .is_some_and(|deadline| now_millis >= deadline)
    {
        state.expired = true;
        state.last_reason = "background_limit".into();
    }
}

fn snapshot(state: &LifecycleState, now_millis: i64) -> LifecycleSnapshot {
    let remaining_seconds = if state.foreground || state.expired {
        0
    } else {
        state
            .deadline
            .map(|deadline| deadline.saturating_sub(now_millis).max(0) as u64 / 1_000)
            .unwrap_or(0)
    };
    let background_elapsed_seconds = state
        .background_since
        .map(|since| now_millis.saturating_sub(since).max(0) as u64 / 1_000)
        .unwrap_or(0)
        .min(BACKGROUND_KEEPALIVE_SECONDS);
    LifecycleSnapshot {
        generation: state.generation,
        network_generation: state.network_generation,
        network_state: match state.online {
            Some(true) => "online",
            Some(false) => "offline",
            None => "unknown",
        },
        state: if state.foreground {
            "foreground"
        } else if state.expired {
            "suspended"
        } else {
            "background"
        },
        background_since: state.background_since,
        deadline: state.deadline,
        remaining_seconds,
        background_elapsed_seconds,
        expired: state.expired,
        active_sessions: state.active_sessions,
        last_reason: state.last_reason.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_window_expires_at_exactly_360_seconds() {
        let lifecycle = LifecycleCoordinator::new();
        let entered = lifecycle.enter_background(1_000, 2);
        assert_eq!(entered.remaining_seconds, 360);
        assert!(!lifecycle.snapshot(360_999).expired);
        assert!(lifecycle.snapshot(361_000).expired);
        assert_eq!(lifecycle.snapshot(362_000).state, "suspended");
    }

    #[test]
    fn background_window_reports_all_acceptance_boundaries() {
        let lifecycle = LifecycleCoordinator::new();
        lifecycle.enter_background(0, 1);
        for (second, remaining, expired) in [
            (0, 360, false),
            (30, 330, false),
            (180, 180, false),
            (359, 1, false),
            (360, 0, true),
            (361, 0, true),
        ] {
            let snapshot = lifecycle.snapshot(second * 1_000);
            assert_eq!(snapshot.remaining_seconds, remaining, "second={second}");
            assert_eq!(snapshot.expired, expired, "second={second}");
        }
    }

    #[test]
    fn stale_expiration_cannot_suspend_a_new_window() {
        let lifecycle = LifecycleCoordinator::new();
        let first = lifecycle.enter_background(0, 1);
        lifecycle.enter_foreground(30_000);
        let second = lifecycle.enter_background(40_000, 1);
        assert_ne!(first.generation, second.generation);
        assert!(!lifecycle.expire_generation(first.generation, 400_000));
        assert!(!lifecycle.snapshot(40_001).expired);
    }

    #[test]
    fn foreground_reports_an_expired_window_once() {
        let lifecycle = LifecycleCoordinator::new();
        lifecycle.enter_background(0, 1);
        let (_, expired) = lifecycle.enter_foreground(361_000);
        assert!(expired);
        let (_, expired_again) = lifecycle.enter_foreground(362_000);
        assert!(!expired_again);
    }

    #[test]
    fn operating_system_can_expire_a_background_window_early() {
        let lifecycle = LifecycleCoordinator::new();
        lifecycle.enter_background(0, 1);
        let snapshot = lifecycle.force_expire(10_000).expect("background window");
        assert!(snapshot.expired);
        assert_eq!(snapshot.state, "suspended");
        assert!(lifecycle.force_expire(11_000).is_some());
        lifecycle.enter_foreground(12_000);
        assert!(lifecycle.force_expire(13_000).is_none());
    }

    #[test]
    fn network_generation_changes_only_when_connectivity_changes() {
        let lifecycle = LifecycleCoordinator::new();
        assert_eq!(
            lifecycle.update_network(true, None, 0).network_generation,
            1
        );
        assert_eq!(
            lifecycle.update_network(true, None, 1).network_generation,
            1
        );
        assert_eq!(
            lifecycle
                .update_network(true, Some(8), 1)
                .network_generation,
            2
        );
        let offline = lifecycle.update_network(false, None, 2);
        assert_eq!(offline.network_generation, 3);
        assert_eq!(offline.network_state, "offline");
        assert_eq!(offline.last_reason, "network_offline");
    }
}
