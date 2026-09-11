//! Non-sensitive structured runtime logging shared by desktop and mobile.

pub(crate) fn log_runtime_event(
    event: &str,
    session_id: &str,
    lifecycle_state: &str,
    network_generation: u64,
    background_elapsed_seconds: u64,
    message: Option<&str>,
) {
    eprintln!(
        "{}",
        runtime_event_value(
            event,
            session_id,
            lifecycle_state,
            network_generation,
            background_elapsed_seconds,
            message,
        )
    );
}

pub(crate) fn log_runtime_error(event: &str, message: &str) {
    log_runtime_event(event, "", "unknown", 0, 0, Some(message));
}

fn runtime_event_value(
    event: &str,
    session_id: &str,
    lifecycle_state: &str,
    network_generation: u64,
    background_elapsed_seconds: u64,
    message: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "event": event,
        "platform": crate::commands::current_platform(),
        "session_id": session_id,
        "lifecycle_state": lifecycle_state,
        "network_generation": network_generation,
        "background_elapsed_seconds": background_elapsed_seconds,
        "message": message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_runtime_log_contains_mobile_diagnostic_dimensions() {
        let value = runtime_event_value("network_change", "session-1", "background", 7, 30, None);
        for field in [
            "platform",
            "session_id",
            "lifecycle_state",
            "network_generation",
            "background_elapsed_seconds",
        ] {
            assert!(value.get(field).is_some(), "missing {field}");
        }
    }
}
