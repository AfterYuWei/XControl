use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{Mutex, OwnedSemaphorePermit, RwLock, Semaphore},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use super::{
    backend::{base_name, clean_path, join_path, local_path_to_api, BackendWriter, FileBackend},
    error::SftpError,
    events::SftpEventSink,
    state::SftpService,
};
use crate::error::CommandError;

const DOWNLOAD_TEMP_PREFIX: &str = "eizhu-dl-";
const DOWNLOAD_STAGE_PREFIX: &str = "eizhu-dl-stage-";
const MAX_IPC_CHUNK_SIZE: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TransferTask {
    id: String,
    file_name: String,
    direction: String,
    size: u64,
    transferred: u64,
    status: String,
    speed: u64,
    started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<i64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    error_message: String,
}

struct TransferEntry {
    task: Mutex<TransferTask>,
    cancel: CancellationToken,
    session_id: String,
    download_path: Mutex<Option<PathBuf>>,
}

struct UploadIngress {
    session_id: String,
    destination: String,
    expected_size: u64,
    received: Mutex<u64>,
    writer: Mutex<Option<BackendWriter>>,
    backend: Arc<FileBackend>,
    transfer: Arc<TransferEntry>,
    profile_id: String,
    started: Instant,
    _permit: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub(super) struct TransferManager {
    tasks: Arc<RwLock<HashMap<String, Arc<TransferEntry>>>>,
    uploads: Arc<RwLock<HashMap<String, Arc<UploadIngress>>>>,
    workers: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    semaphore: Arc<Semaphore>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpUploadResponse {
    tasks: Vec<TransferTask>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpUploadBeginResponse {
    upload_id: String,
    tasks: Vec<TransferTask>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpUploadChunkResponse {
    received: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpDownloadResponse {
    tasks: Vec<TransferTask>,
    download_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SftpConflictInfo {
    source_path: String,
    dest_path: String,
    source_size: u64,
    dest_size: u64,
    source_is_dir: bool,
    dest_is_dir: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpTransferResponse {
    #[serde(skip_serializing_if = "String::is_empty")]
    task_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    method: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tasks: Vec<TransferTask>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    conflicts: Vec<SftpConflictInfo>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpMoveFailure {
    path: String,
    message: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpMoveResponse {
    moved: Vec<String>,
    skipped: Vec<String>,
    failures: Vec<SftpMoveFailure>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    conflicts: Vec<SftpConflictInfo>,
}

impl TransferManager {
    pub(super) fn new() -> Self {
        sweep_stale_transfers();
        Self {
            tasks: Arc::new(RwLock::new(HashMap::new())),
            uploads: Arc::new(RwLock::new(HashMap::new())),
            workers: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(5)),
        }
    }

    async fn create(
        &self,
        session_id: String,
        file_name: String,
        direction: &str,
        size: u64,
    ) -> Arc<TransferEntry> {
        self.reap_finished_workers().await;
        let id = format!(
            "tx-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            &uuid::Uuid::new_v4().to_string()[..6]
        );
        let entry = Arc::new(TransferEntry {
            task: Mutex::new(TransferTask {
                id: id.clone(),
                file_name,
                direction: direction.into(),
                size,
                transferred: 0,
                status: "queued".into(),
                speed: 0,
                started_at: now_millis(),
                finished_at: None,
                error_message: String::new(),
            }),
            cancel: CancellationToken::new(),
            session_id,
            download_path: Mutex::new(None),
        });
        self.tasks.write().await.insert(id, entry.clone());
        entry
    }

    async fn track_worker(&self, id: String, worker: JoinHandle<()>) {
        self.workers.lock().await.insert(id, worker);
    }

    async fn abort_worker(&self, id: &str) {
        let worker = self.workers.lock().await.remove(id);
        if let Some(worker) = worker {
            worker.abort();
            let _ = worker.await;
        }
    }

    async fn reap_finished_workers(&self) {
        self.workers
            .lock()
            .await
            .retain(|_, worker| !worker.is_finished());
    }

    async fn snapshot(entry: &TransferEntry) -> TransferTask {
        entry.task.lock().await.clone()
    }

    async fn set_transferring(entry: &TransferEntry) -> bool {
        let mut task = entry.task.lock().await;
        if entry.cancel.is_cancelled() || task.status == "cancelled" {
            return false;
        }
        task.status = "transferring".into();
        true
    }

    async fn complete(entry: &TransferEntry, events: &dyn SftpEventSink) {
        let task = {
            let mut task = entry.task.lock().await;
            task.status = "completed".into();
            task.transferred = task.size;
            task.speed = 0;
            task.finished_at = Some(now_millis());
            task.clone()
        };
        emit(
            events,
            "transfer_complete",
            serde_json::json!({
                "task_id":task.id,"status":task.status,"finished_at":task.finished_at
            }),
        );
    }

    async fn fail(entry: &TransferEntry, events: &dyn SftpEventSink, message: impl Into<String>) {
        let task = {
            let mut task = entry.task.lock().await;
            if task.status == "cancelled" {
                return;
            }
            task.status = "failed".into();
            task.speed = 0;
            task.finished_at = Some(now_millis());
            task.error_message = message.into();
            task.clone()
        };
        emit(
            events,
            "transfer_failed",
            serde_json::json!({
                "task_id":task.id,"status":task.status,"error_message":task.error_message
            }),
        );
    }

    pub(super) async fn shutdown(&self) {
        let tasks = self
            .tasks
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in tasks {
            entry.cancel.cancel();
            if let Some(path) = entry.download_path.lock().await.take() {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
        let workers = self
            .workers
            .lock()
            .await
            .drain()
            .map(|(_, worker)| worker)
            .collect::<Vec<_>>();
        for worker in &workers {
            worker.abort();
        }
        for worker in workers {
            let _ = worker.await;
        }
        self.remove_uploads(None).await;
    }

    pub(super) async fn cancel_session(&self, session_id: &str) {
        let entries = self
            .tasks
            .read()
            .await
            .values()
            .filter(|entry| entry.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        let mut ids = Vec::with_capacity(entries.len());
        for entry in &entries {
            ids.push(entry.task.lock().await.id.clone());
        }
        for entry in entries {
            entry.cancel.cancel();
        }
        for id in ids {
            self.abort_worker(&id).await;
        }
        self.remove_uploads(Some(session_id)).await;
    }

    async fn remove_uploads(&self, session_id: Option<&str>) {
        let uploads = {
            let mut active = self.uploads.write().await;
            let ids = active
                .iter()
                .filter(|(_, upload)| session_id.is_none_or(|id| upload.session_id == id))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| active.remove(&id))
                .collect::<Vec<_>>()
        };
        for upload in uploads {
            if let Some(mut writer) = upload.writer.lock().await.take() {
                let _ = writer.shutdown().await;
            }
            let _ = upload.backend.remove_file(&upload.destination).await;
            upload.transfer.cancel.cancel();
            let mut task = upload.transfer.task.lock().await;
            if matches!(task.status.as_str(), "queued" | "transferring") {
                task.status = "cancelled".into();
                task.finished_at = Some(now_millis());
            }
        }
    }
}

fn sweep_stale_transfers() {
    let Ok(entries) = std::env::temp_dir().read_dir() else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(DOWNLOAD_TEMP_PREFIX) && !name.starts_with(DOWNLOAD_STAGE_PREFIX) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > Duration::from_secs(60 * 60));
        if stale {
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn emit(events: &dyn SftpEventSink, event_type: &'static str, payload: serde_json::Value) {
    events.emit_sftp(event_type, payload);
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn copy_with_progress(
    source: &FileBackend,
    source_path: &str,
    target: &FileBackend,
    target_path: &str,
    entry: &TransferEntry,
    events: &dyn SftpEventSink,
) -> Result<(), SftpError> {
    let mut reader = source.open_read(source_path).await?;
    let mut writer = target.open_write(target_path).await?;
    let mut buffer = vec![0_u8; 128 * 1024];
    let started = Instant::now();
    loop {
        let read = tokio::select! {
            _ = entry.cancel.cancelled() => return Err("transfer cancelled".into()),
            result = reader.read(&mut buffer) => result.map_err(|error| error.to_string())?,
        };
        if read == 0 {
            break;
        }
        tokio::select! {
            _ = entry.cancel.cancelled() => return Err("transfer cancelled".into()),
            result = writer.write_all(&buffer[..read]) => result.map_err(|error| error.to_string())?,
        }
        let snapshot = {
            let mut task = entry.task.lock().await;
            task.transferred += read as u64;
            task.speed =
                (task.transferred as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
            task.clone()
        };
        emit(
            events,
            "transfer_progress",
            serde_json::json!({
                "task_id":snapshot.id,"transferred":snapshot.transferred,"size":snapshot.size,
                "speed":snapshot.speed,"status":snapshot.status
            }),
        );
    }
    Ok(writer.shutdown().await.map_err(|error| error.to_string())?)
}

fn validate_upload_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\']) {
        return Err(CommandError::new(
            "VALIDATION",
            "upload name must be a file name without path separators",
        ));
    }
    Ok(())
}

pub(crate) async fn sftp_upload_begin(
    state: &SftpService,
    session_id: String,
    name: String,
    dest_dir: String,
    overwrite: bool,
    size: u64,
) -> Result<SftpUploadBeginResponse, CommandError> {
    validate_upload_name(&name)?;
    let (session, backend) = state.backend(&session_id).await?;
    let destination_dir = clean_path(&dest_dir);
    backend
        .mkdir_all(&destination_dir)
        .await
        .map_err(internal)?;
    let destination = join_path(&destination_dir, &name);
    if !overwrite && backend.stat(&destination).await.is_ok() {
        return Err(CommandError::new(
            "PATH_EXISTS",
            format!("file already exists: {destination}"),
        ));
    }

    let permit = state
        .transfers
        .semaphore
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| CommandError::new("INTERNAL", "transfer manager stopped"))?;
    let writer = backend.open_write(&destination).await.map_err(internal)?;
    let transfer = state
        .transfers
        .create(session_id.clone(), name.clone(), "upload", size)
        .await;
    TransferManager::set_transferring(&transfer).await;
    let upload_id = format!("ul-{}", uuid::Uuid::new_v4());
    state.transfers.uploads.write().await.insert(
        upload_id.clone(),
        Arc::new(UploadIngress {
            session_id,
            destination,
            expected_size: size,
            received: Mutex::new(0),
            writer: Mutex::new(Some(writer)),
            backend,
            transfer: transfer.clone(),
            profile_id: session.profile_id.clone(),
            started: Instant::now(),
            _permit: permit,
        }),
    );
    Ok(SftpUploadBeginResponse {
        upload_id,
        tasks: vec![TransferManager::snapshot(&transfer).await],
    })
}

pub(crate) async fn upload_chunk(
    state: &SftpService,
    upload_id: &str,
    bytes: &[u8],
) -> Result<SftpUploadChunkResponse, CommandError> {
    write_upload_chunk(state, upload_id, bytes).await
}

pub(crate) async fn sftp_upload_chunk_base64(
    state: &SftpService,
    upload_id: String,
    data: String,
) -> Result<SftpUploadChunkResponse, CommandError> {
    if data.len() > MAX_IPC_CHUNK_SIZE.div_ceil(3) * 4 {
        return Err(CommandError::new(
            "PAYLOAD_TOO_LARGE",
            "encoded upload chunk is too large",
        ));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|error| CommandError::new("INVALID_FORM", error.to_string()))?;
    write_upload_chunk(state, &upload_id, &bytes).await
}

async fn write_upload_chunk(
    state: &SftpService,
    upload_id: &str,
    bytes: &[u8],
) -> Result<SftpUploadChunkResponse, CommandError> {
    if bytes.len() > MAX_IPC_CHUNK_SIZE {
        return Err(CommandError::new(
            "PAYLOAD_TOO_LARGE",
            format!("upload chunk exceeds {MAX_IPC_CHUNK_SIZE} bytes"),
        ));
    }
    let upload = state
        .transfers
        .uploads
        .read()
        .await
        .get(upload_id)
        .cloned()
        .ok_or_else(|| CommandError::new("NOT_FOUND", "upload stream not found"))?;
    if upload.transfer.cancel.is_cancelled() {
        return Err(CommandError::new("CANCELLED", "upload was cancelled"));
    }
    let mut received = upload.received.lock().await;
    let next = received.saturating_add(bytes.len() as u64);
    if next > upload.expected_size {
        return Err(CommandError::new(
            "INVALID_SIZE",
            "upload contains more bytes than declared",
        ));
    }
    let mut writer = upload.writer.lock().await;
    let writer = writer
        .as_mut()
        .ok_or_else(|| CommandError::new("INVALID_STATE", "upload stream is already closed"))?;
    tokio::select! {
        _ = upload.transfer.cancel.cancelled() => {
            return Err(CommandError::new("CANCELLED", "upload was cancelled"));
        }
        result = writer.write_all(bytes) => {
            result.map_err(|error| CommandError::new("INTERNAL", error.to_string()))?;
        }
    }
    *received = next;
    let snapshot = {
        let mut task = upload.transfer.task.lock().await;
        task.transferred = next;
        task.speed = (next as f64 / upload.started.elapsed().as_secs_f64().max(0.001)) as u64;
        task.clone()
    };
    emit(
        state.events.as_ref(),
        "transfer_progress",
        serde_json::json!({
            "task_id":snapshot.id,"transferred":snapshot.transferred,"size":snapshot.size,
            "speed":snapshot.speed,"status":snapshot.status
        }),
    );
    Ok(SftpUploadChunkResponse { received: next })
}

pub(crate) async fn sftp_upload_finish(
    state: &SftpService,
    upload_id: String,
) -> Result<SftpUploadResponse, CommandError> {
    let upload = state
        .transfers
        .uploads
        .write()
        .await
        .remove(&upload_id)
        .ok_or_else(|| CommandError::new("NOT_FOUND", "upload stream not found"))?;
    let received = *upload.received.lock().await;
    if upload.transfer.cancel.is_cancelled() {
        if let Some(mut writer) = upload.writer.lock().await.take() {
            let _ = writer.shutdown().await;
        }
        let _ = upload.backend.remove_file(&upload.destination).await;
        return Err(CommandError::new("CANCELLED", "upload was cancelled"));
    }
    if received != upload.expected_size {
        if let Some(mut writer) = upload.writer.lock().await.take() {
            let _ = writer.shutdown().await;
        }
        let _ = upload.backend.remove_file(&upload.destination).await;
        TransferManager::fail(
            &upload.transfer,
            state.events.as_ref(),
            "upload size mismatch",
        )
        .await;
        return Err(CommandError::new(
            "INVALID_SIZE",
            format!(
                "upload ended after {received} bytes; expected {}",
                upload.expected_size
            ),
        ));
    }
    if let Some(mut writer) = upload.writer.lock().await.take() {
        if let Err(error) = async {
            writer.flush().await?;
            writer.shutdown().await
        }
        .await
        {
            let _ = upload.backend.remove_file(&upload.destination).await;
            TransferManager::fail(&upload.transfer, state.events.as_ref(), error.to_string()).await;
            return Err(CommandError::new("INTERNAL", error.to_string()));
        }
    }
    TransferManager::complete(&upload.transfer, state.events.as_ref()).await;
    let _ = state.audit.record(
        &upload.profile_id,
        "sftp_upload",
        format!("dest={} size={}", upload.destination, upload.expected_size),
    );
    Ok(SftpUploadResponse {
        tasks: vec![TransferManager::snapshot(&upload.transfer).await],
    })
}

pub(crate) async fn sftp_upload_abort(
    state: &SftpService,
    upload_id: String,
) -> Result<(), CommandError> {
    if let Some(upload) = state.transfers.uploads.write().await.remove(&upload_id) {
        if let Some(mut writer) = upload.writer.lock().await.take() {
            let _ = writer.shutdown().await;
        }
        let _ = upload.backend.remove_file(&upload.destination).await;
        upload.transfer.cancel.cancel();
        let status = {
            let mut task = upload.transfer.task.lock().await;
            task.status = "cancelled".into();
            task.finished_at = Some(now_millis());
            task.status.clone()
        };
        emit(
            state.events.as_ref(),
            "transfer_complete",
            serde_json::json!({"task_id":upload.transfer.task.lock().await.id,"status":status,"finished_at":now_millis()}),
        );
    }
    Ok(())
}

pub(crate) async fn sftp_list_transfers(
    state: &SftpService,
    session_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<TransferTask>, CommandError> {
    let entries = state
        .transfers
        .tasks
        .read()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    for entry in entries {
        let task = TransferManager::snapshot(&entry).await;
        if session_id
            .as_ref()
            .is_some_and(|id| id != &entry.session_id)
        {
            continue;
        }
        if status.as_ref().is_some_and(|value| value != &task.status) {
            continue;
        }
        result.push(task);
    }
    result.sort_by_key(|task| std::cmp::Reverse(task.started_at));
    Ok(result)
}

pub(crate) async fn sftp_cancel_transfer(
    state: &SftpService,
    task_id: String,
) -> Result<serde_json::Value, CommandError> {
    let entry = state
        .transfers
        .tasks
        .read()
        .await
        .get(&task_id)
        .cloned()
        .ok_or_else(|| CommandError::new("NOT_FOUND", "transfer task not found"))?;
    entry.cancel.cancel();
    state.transfers.abort_worker(&task_id).await;
    let status = {
        let mut task = entry.task.lock().await;
        if task.status == "queued" || task.status == "transferring" {
            task.status = "cancelled".into();
            task.finished_at = Some(now_millis());
        }
        task.status.clone()
    };
    emit(
        state.events.as_ref(),
        "transfer_complete",
        serde_json::json!({"task_id":task_id,"status":status,"finished_at":now_millis()}),
    );
    Ok(serde_json::json!({"id":task_id,"status":status}))
}

pub(crate) async fn sftp_clear_completed_transfers(
    state: &SftpService,
) -> Result<(), CommandError> {
    let entries = state
        .transfers
        .tasks
        .read()
        .await
        .iter()
        .map(|(id, entry)| (id.clone(), entry.clone()))
        .collect::<Vec<_>>();
    let mut remove = Vec::new();
    for (id, entry) in entries {
        let status = entry.task.lock().await.status.clone();
        if matches!(status.as_str(), "completed" | "failed" | "cancelled") {
            if let Some(path) = entry.download_path.lock().await.take() {
                let _ = tokio::fs::remove_file(path).await;
            }
            remove.push(id);
        }
    }
    let mut tasks = state.transfers.tasks.write().await;
    for id in &remove {
        tasks.remove(id);
    }
    drop(tasks);
    for id in remove {
        state.transfers.abort_worker(&id).await;
    }
    Ok(())
}

fn internal(error: SftpError) -> CommandError {
    CommandError::new("INTERNAL", error.to_string())
}

fn archive_name(path: &str) -> String {
    let name = base_name(path);
    format!(
        "{}.tar.gz",
        if name.is_empty() || name == "/" {
            "archive"
        } else {
            &name
        }
    )
}

struct CancelReader {
    file: std::fs::File,
    cancel: CancellationToken,
}

impl Read for CancelReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "transfer cancelled",
            ));
        }
        self.file.read(buffer)
    }
}

fn append_tar_directory(
    archive: &mut tar::Builder<flate2::write::GzEncoder<std::fs::File>>,
    source_root: &Path,
    directory: &Path,
    archive_root: &str,
    cancel: &CancellationToken,
) -> Result<(), SftpError> {
    if cancel.is_cancelled() {
        return Err("transfer cancelled".into());
    }
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let relative = path
            .strip_prefix(source_root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let archive_path = format!("{archive_root}/{relative}");
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            archive
                .append_dir(format!("{archive_path}/"), &path)
                .map_err(|error| error.to_string())?;
            append_tar_directory(archive, source_root, &path, archive_root, cancel)?;
            continue;
        }
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o644);
        header.set_size(metadata.len());
        header.set_mtime(
            metadata
                .modified()
                .unwrap_or(SystemTime::UNIX_EPOCH)
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
        header.set_cksum();
        archive
            .append_data(
                &mut header,
                archive_path,
                CancelReader {
                    file: std::fs::File::open(&path).map_err(|error| error.to_string())?,
                    cancel: cancel.clone(),
                },
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn make_tar_gz_from_directory(
    source: &Path,
    output: &Path,
    cancel: &CancellationToken,
) -> Result<(), SftpError> {
    if cancel.is_cancelled() {
        return Err("transfer cancelled".into());
    }
    let file = std::fs::File::create(output)
        .map_err(|error| SftpError::archive(format!("create archive: {error}")))?;
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    let root_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("archive");
    archive
        .append_dir(format!("{root_name}/"), source)
        .map_err(|error| error.to_string())?;
    append_tar_directory(&mut archive, source, source, root_name, cancel)?;
    archive
        .into_inner()
        .map_err(|error| error.to_string())?
        .finish()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn append_zip_directory(
    archive: &mut zip::ZipWriter<std::fs::File>,
    root: &Path,
    directory: &Path,
    cancel: &CancellationToken,
) -> Result<(), SftpError> {
    if cancel.is_cancelled() {
        return Err("transfer cancelled".into());
    }
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if path.is_dir() {
            archive
                .add_directory(format!("{relative}/"), options)
                .map_err(|error| error.to_string())?;
            append_zip_directory(archive, root, &path, cancel)?;
            continue;
        }
        archive
            .start_file(relative, options)
            .map_err(|error| error.to_string())?;
        let mut input = std::fs::File::open(&path).map_err(|error| error.to_string())?;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            if cancel.is_cancelled() {
                return Err("transfer cancelled".into());
            }
            let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            archive
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn make_zip_from_directory(
    source: &Path,
    output: &Path,
    cancel: &CancellationToken,
) -> Result<(), SftpError> {
    let file = std::fs::File::create(output).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    append_zip_directory(&mut archive, source, source, cancel)?;
    archive.finish().map_err(|error| error.to_string())?;
    Ok(())
}

fn tree_size<'a>(
    backend: &'a FileBackend,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64, SftpError>> + Send + 'a>> {
    Box::pin(async move {
        let info = backend.stat(path).await?;
        if !info.is_dir {
            return Ok(info.size);
        }
        let mut size = 0_u64;
        for child in backend.list(path).await? {
            size = size.saturating_add(tree_size(backend, &child.path).await?);
        }
        Ok(size)
    })
}

pub(crate) async fn sftp_download(
    state: &SftpService,
    session_id: String,
    paths: Vec<String>,
) -> Result<SftpDownloadResponse, CommandError> {
    if paths.is_empty() {
        return Err(CommandError::new("VALIDATION", "paths is required"));
    }
    let (session, backend) = state.backend(&session_id).await?;
    let paths = paths
        .into_iter()
        .map(|path| clean_path(&path))
        .collect::<Vec<_>>();
    let first = backend.stat(&paths[0]).await.map_err(internal)?;
    let zipped = paths.len() > 1 || first.is_dir;
    let file_name = if zipped {
        if paths.len() == 1 {
            format!("{}.zip", base_name(&paths[0]))
        } else {
            "download.zip".into()
        }
    } else {
        first.name.clone()
    };
    let size = if zipped {
        let mut size = 0_u64;
        for path in &paths {
            size = size.saturating_add(tree_size(&backend, path).await.map_err(internal)?);
        }
        size
    } else {
        first.size
    };
    let transfer = state
        .transfers
        .create(session_id, file_name.clone(), "download", size)
        .await;
    let task_id = transfer.task.lock().await.id.clone();
    let response = SftpDownloadResponse {
        tasks: vec![TransferManager::snapshot(&transfer).await],
        download_url: task_id.clone(),
    };
    let manager = state.transfers.clone();
    let worker_manager = manager.clone();
    let events = state.events.clone();
    let audit = state.audit.clone();
    let profile_id = session.profile_id.clone();
    let worker = tokio::spawn(async move {
        let permit = worker_manager.semaphore.acquire().await;
        if permit.is_err() {
            TransferManager::fail(&transfer, events.as_ref(), "transfer manager stopped").await;
            return;
        }
        if !TransferManager::set_transferring(&transfer).await {
            return;
        }
        let task_id = transfer.task.lock().await.id.clone();
        let temp_path = std::env::temp_dir().join(format!(
            "{DOWNLOAD_TEMP_PREFIX}{task_id}{}",
            if zipped { ".zip" } else { "" }
        ));
        *transfer.download_path.lock().await = Some(temp_path.clone());
        let stage_path = std::env::temp_dir().join(format!("{DOWNLOAD_STAGE_PREFIX}{task_id}"));
        let result = async {
            if zipped {
                tokio::fs::create_dir_all(&stage_path)
                    .await
                    .map_err(|error| error.to_string())?;
                let local = FileBackend::Local;
                let stage_root = local_path_to_api(&stage_path);
                for path in &paths {
                    if transfer.cancel.is_cancelled() {
                        return Err("transfer cancelled".into());
                    }
                    let info = backend.stat(path).await?;
                    let relative = clean_path(path).trim_start_matches('/').replace(':', "_");
                    let destination = if relative.is_empty() {
                        stage_root.clone()
                    } else {
                        join_path(&stage_root, &relative)
                    };
                    if info.is_dir {
                        copy_directory(
                            &backend,
                            path,
                            &local,
                            &destination,
                            &transfer,
                            events.as_ref(),
                        )
                        .await?;
                    } else {
                        let parent = parent_path(&destination);
                        local.mkdir_all(&parent).await?;
                        copy_with_progress(
                            &backend,
                            path,
                            &local,
                            &destination,
                            &transfer,
                            events.as_ref(),
                        )
                        .await?;
                    }
                }
                let stage = stage_path.clone();
                let output = temp_path.clone();
                let cancel = transfer.cancel.clone();
                tokio::task::spawn_blocking(move || {
                    make_zip_from_directory(&stage, &output, &cancel)
                })
                .await
                .map_err(|error| error.to_string())??;
            } else {
                copy_with_progress(
                    &backend,
                    &paths[0],
                    &FileBackend::Local,
                    &local_path_to_api(&temp_path),
                    &transfer,
                    events.as_ref(),
                )
                .await?;
            }
            Ok::<(), SftpError>(())
        }
        .await;
        if zipped {
            let _ = tokio::fs::remove_dir_all(&stage_path).await;
        }
        match result {
            Ok(()) => {
                TransferManager::complete(&transfer, events.as_ref()).await;
                let _ = audit.record(
                    profile_id,
                    "sftp_download",
                    format!("file={file_name} size={size}"),
                );
            }
            Err(error) => {
                if let Some(path) = transfer.download_path.lock().await.take() {
                    let _ = tokio::fs::remove_file(path).await;
                }
                TransferManager::fail(&transfer, events.as_ref(), error.to_string()).await;
            }
        }
    });
    manager.track_worker(task_id, worker).await;
    Ok(response)
}

pub(crate) async fn sftp_download_chunk(
    state: &SftpService,
    task_id: String,
    offset: u64,
    max_bytes: u32,
) -> Result<Vec<u8>, CommandError> {
    if max_bytes == 0 || max_bytes as usize > MAX_IPC_CHUNK_SIZE {
        return Err(CommandError::new(
            "VALIDATION",
            format!("max_bytes must be between 1 and {MAX_IPC_CHUNK_SIZE}"),
        ));
    }
    let entry = state
        .transfers
        .tasks
        .read()
        .await
        .get(&task_id)
        .cloned()
        .ok_or_else(|| CommandError::new("NOT_FOUND", "transfer task not found"))?;
    if entry.task.lock().await.status != "completed" {
        return Err(CommandError::new("NOT_READY", "transfer is not completed"));
    }
    let path = entry
        .download_path
        .lock()
        .await
        .clone()
        .ok_or_else(|| CommandError::new("NOT_FOUND", "download file expired or cleaned up"))?;
    let bytes = read_file_chunk(&path, offset, max_bytes as usize)
        .await
        .map_err(|error| CommandError::new("INTERNAL", error.to_string()))?;
    Ok(bytes)
}

pub(crate) async fn sftp_download_chunk_base64(
    state: &SftpService,
    task_id: String,
    offset: u64,
    max_bytes: u32,
) -> Result<String, CommandError> {
    if max_bytes == 0 || max_bytes as usize > MAX_IPC_CHUNK_SIZE {
        return Err(CommandError::new(
            "VALIDATION",
            format!("max_bytes must be between 1 and {MAX_IPC_CHUNK_SIZE}"),
        ));
    }
    let entry = state
        .transfers
        .tasks
        .read()
        .await
        .get(&task_id)
        .cloned()
        .ok_or_else(|| CommandError::new("NOT_FOUND", "transfer task not found"))?;
    if entry.task.lock().await.status != "completed" {
        return Err(CommandError::new("NOT_READY", "transfer is not completed"));
    }
    let path = entry
        .download_path
        .lock()
        .await
        .clone()
        .ok_or_else(|| CommandError::new("NOT_FOUND", "download file expired or cleaned up"))?;
    let bytes = read_file_chunk(&path, offset, max_bytes as usize)
        .await
        .map_err(|error| CommandError::new("INTERNAL", error.to_string()))?;
    Ok(STANDARD.encode(bytes))
}

async fn read_file_chunk(path: &Path, offset: u64, max_bytes: usize) -> Result<Vec<u8>, SftpError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| error.to_string())?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| error.to_string())?;
    let mut bytes = vec![0_u8; max_bytes];
    let read = file
        .read(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    bytes.truncate(read);
    Ok(bytes)
}

pub(crate) async fn sftp_download_close(
    state: &SftpService,
    task_id: String,
) -> Result<(), CommandError> {
    if let Some(entry) = state.transfers.tasks.write().await.remove(&task_id) {
        entry.cancel.cancel();
        state.transfers.abort_worker(&task_id).await;
        if let Some(path) = entry.download_path.lock().await.take() {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    Ok(())
}

async fn auto_rename(backend: &FileBackend, path: &str) -> Result<String, SftpError> {
    let (stem, extension) = match base_name(path).rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_owned(), format!(".{extension}")),
        _ => (base_name(path), String::new()),
    };
    let parent = parent_path(path);
    for index in 1..10_000 {
        let candidate = join_path(&parent, &format!("{stem} ({index}){extension}"));
        if backend.stat(&candidate).await.is_err() {
            return Ok(candidate);
        }
    }
    Err("cannot find an available destination name".into())
}

fn parent_path(path: &str) -> String {
    let path = clean_path(path);
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or(".")
        .to_owned()
}

fn path_within(candidate: &str, root: &str) -> bool {
    let candidate = clean_path(candidate);
    let root = clean_path(root);
    candidate == root || candidate.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

async fn resolve_destination(
    backend: &FileBackend,
    destination: String,
    resolution: &str,
) -> Result<Option<String>, SftpError> {
    if backend.stat(&destination).await.is_err() {
        return Ok(Some(destination));
    }
    match resolution {
        "overwrite" => {
            remove_all(backend, &destination).await?;
            Ok(Some(destination))
        }
        "rename" => Ok(Some(auto_rename(backend, &destination).await?)),
        "skip" | "ask" => Ok(None),
        _ => Err("invalid conflict_resolution".into()),
    }
}

fn remove_all<'a>(
    backend: &'a FileBackend,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SftpError>> + Send + 'a>> {
    Box::pin(async move {
        let info = backend.stat(path).await?;
        if !info.is_dir {
            return backend.remove_file(path).await;
        }
        for child in backend.list(path).await? {
            remove_all(backend, &child.path).await?;
        }
        backend.remove_dir(path).await
    })
}

fn copy_directory<'a>(
    source: &'a FileBackend,
    source_root: &'a str,
    target: &'a FileBackend,
    target_root: &'a str,
    transfer: &'a TransferEntry,
    events: &'a dyn SftpEventSink,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SftpError>> + Send + 'a>> {
    Box::pin(async move {
        target.mkdir_all(target_root).await?;
        for child in source.list(source_root).await? {
            let destination = join_path(target_root, &child.name);
            if child.is_dir {
                copy_directory(source, &child.path, target, &destination, transfer, events).await?;
            } else {
                copy_with_progress(source, &child.path, target, &destination, transfer, events)
                    .await?;
            }
        }
        Ok(())
    })
}

async fn copy_plain(
    source: &FileBackend,
    source_path: &str,
    target: &FileBackend,
    target_path: &str,
) -> Result<(), SftpError> {
    let mut reader = source.open_read(source_path).await?;
    let mut writer = target.open_write(target_path).await?;
    tokio::io::copy(&mut reader, &mut writer)
        .await
        .map_err(|error| error.to_string())?;
    Ok(writer.shutdown().await.map_err(|error| error.to_string())?)
}

fn copy_directory_plain<'a>(
    source: &'a FileBackend,
    source_root: &'a str,
    target: &'a FileBackend,
    target_root: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SftpError>> + Send + 'a>> {
    Box::pin(async move {
        target.mkdir_all(target_root).await?;
        for child in source.list(source_root).await? {
            let destination = join_path(target_root, &child.name);
            if child.is_dir {
                copy_directory_plain(source, &child.path, target, &destination).await?;
            } else {
                copy_plain(source, &child.path, target, &destination).await?;
            }
        }
        Ok(())
    })
}

impl SftpService {
    pub(crate) async fn materialize_paths(
        &self,
        source_session_id: &str,
        paths: &[String],
        destination_dir: &str,
    ) -> Result<(), CommandError> {
        let (_, source) = self.backend(source_session_id).await?;
        let target = FileBackend::Local;
        let destination_dir = clean_path(destination_dir);
        target.mkdir_all(&destination_dir).await.map_err(internal)?;
        for raw in paths {
            let path = clean_path(raw);
            let info = source.stat(&path).await.map_err(internal)?;
            let destination = join_path(&destination_dir, &info.name);
            if target.stat(&destination).await.is_ok() {
                remove_all(&target, &destination).await.map_err(internal)?;
            }
            if info.is_dir {
                copy_directory_plain(&source, &path, &target, &destination)
                    .await
                    .map_err(internal)?;
            } else {
                copy_plain(&source, &path, &target, &destination)
                    .await
                    .map_err(internal)?;
            }
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_transfer(
    state: &SftpService,
    source_session_id: String,
    target_session_id: String,
    paths: Vec<String>,
    dest_dir: String,
    conflict_resolution: Option<String>,
    directory_mode: Option<String>,
) -> Result<SftpTransferResponse, CommandError> {
    if paths.is_empty() {
        return Err(CommandError::new("VALIDATION", "paths is required"));
    }
    let (_, source) = state.backend(&source_session_id).await?;
    let (_, target) = state.backend(&target_session_id).await?;
    let resolution = conflict_resolution.unwrap_or_else(|| "ask".into());
    let directory_mode = directory_mode.unwrap_or_else(|| "archive".into());
    if !matches!(resolution.as_str(), "ask" | "overwrite" | "rename" | "skip") {
        return Err(CommandError::new(
            "VALIDATION",
            "invalid conflict_resolution",
        ));
    }
    if !matches!(directory_mode.as_str(), "archive" | "preserve") {
        return Err(CommandError::new(
            "VALIDATION",
            "directory_mode must be preserve or archive",
        ));
    }
    let paths = paths
        .into_iter()
        .map(|path| clean_path(&path))
        .collect::<Vec<_>>();
    let dest_dir = clean_path(&dest_dir);
    let mut conflicts = Vec::new();
    let mut size = 0_u64;
    for path in &paths {
        let info = source.stat(path).await.map_err(internal)?;
        if info.is_dir && source_session_id == target_session_id && path_within(&dest_dir, path) {
            return Err(CommandError::new(
                "INVALID_DESTINATION",
                "cannot copy a directory into itself",
            ));
        }
        let destination_name = if info.is_dir && directory_mode == "archive" {
            archive_name(path)
        } else {
            info.name.clone()
        };
        let destination = join_path(&dest_dir, &destination_name);
        if source_session_id == target_session_id
            && clean_path(path) == destination
            && resolution == "overwrite"
        {
            return Err(CommandError::new(
                "INVALID_DESTINATION",
                "cannot overwrite a source item with itself; choose rename or skip",
            ));
        }
        if let Ok(existing) = target.stat(&destination).await {
            conflicts.push(SftpConflictInfo {
                source_path: path.clone(),
                dest_path: destination,
                source_size: info.size,
                dest_size: existing.size,
                source_is_dir: info.is_dir,
                dest_is_dir: existing.is_dir,
            });
        }
        size = size.saturating_add(tree_size(&source, path).await.map_err(internal)?);
    }
    if resolution == "ask" && !conflicts.is_empty() {
        return Ok(SftpTransferResponse {
            task_id: String::new(),
            method: String::new(),
            tasks: Vec::new(),
            conflicts,
        });
    }
    let transfer = state
        .transfers
        .create(
            source_session_id,
            paths
                .iter()
                .map(|path| base_name(path))
                .collect::<Vec<_>>()
                .join(", "),
            "transfer",
            size,
        )
        .await;
    let task_id = transfer.task.lock().await.id.clone();
    let response = SftpTransferResponse {
        task_id: task_id.clone(),
        method: "relay".into(),
        tasks: vec![TransferManager::snapshot(&transfer).await],
        conflicts: Vec::new(),
    };
    let manager = state.transfers.clone();
    let worker_manager = manager.clone();
    let worker_task_id = task_id.clone();
    let events = state.events.clone();
    let worker = tokio::spawn(async move {
        let permit = worker_manager.semaphore.acquire().await;
        if permit.is_err() {
            TransferManager::fail(&transfer, events.as_ref(), "transfer manager stopped").await;
            return;
        }
        if !TransferManager::set_transferring(&transfer).await {
            return;
        }
        let result = async {
            target.mkdir_all(&dest_dir).await?;
            let mut failures = Vec::new();
            for path in &paths {
                let result = async {
                    let info = source.stat(path).await?;
                    let destination_name = if info.is_dir && directory_mode == "archive" {
                        archive_name(path)
                    } else {
                        info.name.clone()
                    };
                    let destination = join_path(&dest_dir, &destination_name);
                    let Some(destination) =
                        resolve_destination(&target, destination, &resolution).await?
                    else {
                        return Ok::<(), SftpError>(());
                    };
                    if info.is_dir && directory_mode == "preserve" {
                        copy_directory(
                            &source,
                            path,
                            &target,
                            &destination,
                            &transfer,
                            events.as_ref(),
                        )
                        .await
                    } else if info.is_dir {
                        let staging = std::env::temp_dir().join(format!(
                            "eizhu-tx-stage-{worker_task_id}-{}",
                            uuid::Uuid::new_v4()
                        ));
                        let archive_path = std::env::temp_dir().join(format!(
                            "eizhu-tx-archive-{worker_task_id}-{}.tar.gz",
                            uuid::Uuid::new_v4()
                        ));
                        let local = FileBackend::Local;
                        let staged_source = staging.join(base_name(path));
                        let staged_source_api = local_path_to_api(&staged_source);
                        let archive_api = local_path_to_api(&archive_path);
                        let archive_result = async {
                            local.mkdir_all(&local_path_to_api(&staging)).await?;
                            copy_directory(
                                &source,
                                path,
                                &local,
                                &staged_source_api,
                                &transfer,
                                events.as_ref(),
                            )
                            .await?;
                            let source_path = staged_source.clone();
                            let output_path = archive_path.clone();
                            let cancel = transfer.cancel.clone();
                            tokio::task::spawn_blocking(move || {
                                make_tar_gz_from_directory(&source_path, &output_path, &cancel)
                            })
                            .await
                            .map_err(|error| error.to_string())??;
                            copy_with_progress(
                                &local,
                                &archive_api,
                                &target,
                                &destination,
                                &transfer,
                                events.as_ref(),
                            )
                            .await
                        }
                        .await;
                        let _ = tokio::fs::remove_dir_all(&staging).await;
                        let _ = tokio::fs::remove_file(&archive_path).await;
                        archive_result
                    } else {
                        copy_with_progress(
                            &source,
                            path,
                            &target,
                            &destination,
                            &transfer,
                            events.as_ref(),
                        )
                        .await
                    }
                }
                .await;
                if let Err(error) = result {
                    failures.push(format!("{path}: {error}"));
                }
            }
            if failures.len() == paths.len() {
                Err(SftpError::transfer(format!(
                    "all paths failed: {}",
                    failures.join("; ")
                )))
            } else {
                if !failures.is_empty() {
                    transfer.task.lock().await.error_message = failures.join("; ");
                }
                Ok(())
            }
        }
        .await;
        match result {
            Ok(()) => TransferManager::complete(&transfer, events.as_ref()).await,
            Err(error) => {
                TransferManager::fail(&transfer, events.as_ref(), error.to_string()).await
            }
        }
    });
    manager.track_worker(task_id, worker).await;
    Ok(response)
}

pub(crate) async fn sftp_move(
    state: &SftpService,
    session_id: String,
    paths: Vec<String>,
    dest_dir: String,
    conflict_resolution: Option<String>,
) -> Result<SftpMoveResponse, CommandError> {
    let (session, backend) = state.backend(&session_id).await?;
    let resolution = conflict_resolution.unwrap_or_else(|| "ask".into());
    if !matches!(resolution.as_str(), "ask" | "overwrite" | "rename" | "skip") {
        return Err(CommandError::new(
            "VALIDATION",
            "invalid conflict_resolution",
        ));
    }
    let dest_dir = clean_path(&dest_dir);
    if !backend.stat(&dest_dir).await.map_err(internal)?.is_dir {
        return Err(CommandError::new(
            "INVALID_DESTINATION",
            "dest_dir must be an existing directory",
        ));
    }
    let mut prepared = Vec::new();
    let mut conflicts = Vec::new();
    for raw in paths {
        let path = clean_path(&raw);
        let info = backend.stat(&path).await.map_err(internal)?;
        if path == "/"
            || parent_path(&path) == dest_dir
            || (info.is_dir && path_within(&dest_dir, &path))
        {
            return Err(CommandError::new(
                "INVALID_DESTINATION",
                "cannot move root or move an item to its current parent/itself",
            ));
        }
        let destination = join_path(&dest_dir, &info.name);
        if let Ok(existing) = backend.stat(&destination).await {
            conflicts.push(SftpConflictInfo {
                source_path: path.clone(),
                dest_path: destination,
                source_size: info.size,
                dest_size: existing.size,
                source_is_dir: info.is_dir,
                dest_is_dir: existing.is_dir,
            });
        }
        prepared.push((path, info));
    }
    if resolution == "ask" && !conflicts.is_empty() {
        return Ok(SftpMoveResponse {
            moved: Vec::new(),
            skipped: Vec::new(),
            failures: Vec::new(),
            conflicts,
        });
    }
    let mut response = SftpMoveResponse {
        moved: Vec::new(),
        skipped: Vec::new(),
        failures: Vec::new(),
        conflicts: Vec::new(),
    };
    for (path, info) in prepared {
        let destination = join_path(&dest_dir, &info.name);
        match resolve_destination(&backend, destination, &resolution).await {
            Ok(Some(destination)) => match backend.rename(&path, &destination).await {
                Ok(()) => response.moved.push(destination),
                Err(message) => response.failures.push(SftpMoveFailure {
                    path,
                    message: message.to_string(),
                }),
            },
            Ok(None) => response.skipped.push(path),
            Err(message) => response.failures.push(SftpMoveFailure {
                path,
                message: message.to_string(),
            }),
        }
    }
    let _ = state.audit.record(
        &session.profile_id,
        "sftp_move",
        format!(
            "dest={} moved={} skipped={} failed={}",
            dest_dir,
            response.moved.len(),
            response.skipped.len(),
            response.failures.len()
        ),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[test]
    fn tar_builder_preserves_paths_and_content() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("root");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("a.txt"), b"tar-data").unwrap();
        let output = directory.path().join("archive.tar.gz");
        make_tar_gz_from_directory(&source, &output, &CancellationToken::new()).unwrap();
        let decoder = flate2::read::GzDecoder::new(std::fs::File::open(output).unwrap());
        let mut archive = tar::Archive::new(decoder);
        let mut entries = archive.entries().unwrap();
        let _root = entries.next().unwrap().unwrap();
        let mut entry = entries.next().unwrap().unwrap();
        assert_eq!(
            entry.path().unwrap().as_ref(),
            std::path::Path::new("root/a.txt")
        );
        let mut tar_content = String::new();
        entry.read_to_string(&mut tar_content).unwrap();
        assert_eq!(tar_content, "tar-data");
    }

    #[test]
    fn zip_builder_streams_directory_to_file() {
        let source = tempfile::tempdir().unwrap();
        let nested = source.path().join("dir");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("a.txt"), b"zip-data").unwrap();
        let output_dir = tempfile::tempdir().unwrap();
        let output = output_dir.path().join("download.zip");
        make_zip_from_directory(source.path(), &output, &CancellationToken::new()).unwrap();

        let mut zip = zip::ZipArchive::new(std::fs::File::open(output).unwrap()).unwrap();
        let mut content = String::new();
        zip.by_name("dir/a.txt")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "zip-data");
    }

    #[tokio::test]
    async fn download_chunks_are_bounded_and_reconstruct_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.bin");
        let expected = (0..=255).cycle().take(1025).collect::<Vec<u8>>();
        tokio::fs::write(&path, &expected).await.unwrap();

        let mut actual = Vec::new();
        let mut offset = 0;
        loop {
            let chunk = read_file_chunk(&path, offset, 128).await.unwrap();
            if chunk.is_empty() {
                break;
            }
            assert!(chunk.len() <= 128);
            offset += chunk.len() as u64;
            actual.extend(chunk);
        }
        assert_eq!(actual, expected);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tree_size_counts_nested_files_without_loading_them() {
        let directory = tempfile::tempdir().unwrap();
        let nested = directory.path().join("nested");
        tokio::fs::create_dir(&nested).await.unwrap();
        tokio::fs::write(directory.path().join("a"), b"123")
            .await
            .unwrap();
        tokio::fs::write(nested.join("b"), b"45678").await.unwrap();
        let path = directory.path().to_string_lossy();
        assert_eq!(tree_size(&FileBackend::Local, &path).await.unwrap(), 8);
    }

    #[cfg(unix)]
    #[test]
    fn tar_builder_honors_pre_cancelled_transfer() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("data"), vec![7_u8; 256 * 1024]).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error =
            make_tar_gz_from_directory(&path, &directory.path().join("out"), &cancel).unwrap_err();
        assert_eq!(error.to_string(), "transfer cancelled");
    }
}
