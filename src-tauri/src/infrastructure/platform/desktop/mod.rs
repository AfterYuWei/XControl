//! Desktop-only paths, dialogs, logs, migration and drag-out capabilities.

mod dialogs;
mod drag_out;
mod error;
mod logs;
mod paths;
mod settings_migration;

pub(crate) use dialogs::save_blob;
pub(crate) use drag_out::{materialize_drag, sweep_stale_drag_temps, DragOutFiles};
pub(crate) use error::PlatformError;
pub(crate) use logs::{append_frontend_log, clear_app_log, read_app_log, AppLogSnapshot};
pub(crate) use paths::{is_test_build, user_data_dir};
pub(crate) use settings_migration::{mark_migrated, read_unmigrated};
