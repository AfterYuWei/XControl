//! Ownership boundary for active SSH sessions and their background tasks.

use std::{collections::HashMap, sync::Arc};

use tokio::{
    sync::{Mutex, RwLock},
    task::JoinHandle,
};

use crate::error::CommandError;

use super::session::{Session, SessionInfo};

#[derive(Clone, Default)]
pub(super) struct SessionManager {
    sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
    tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl SessionManager {
    pub(super) async fn register(&self, session: Arc<Session>) {
        self.sessions
            .write()
            .await
            .insert(session.id().to_owned(), session);
        self.reap_finished().await;
    }

    pub(super) async fn track(&self, id: String, task: JoinHandle<()>) {
        self.tasks.lock().await.insert(id, task);
    }

    pub(super) async fn replace(&self, id: &str, session: Arc<Session>) {
        if let Some(previous) = self.sessions.write().await.insert(id.to_owned(), session) {
            previous.cancel();
        }
        if let Some(task) = self.tasks.lock().await.remove(id) {
            let _ = task.await;
        }
    }

    pub(super) async fn sessions(&self) -> Vec<Arc<Session>> {
        self.sessions.read().await.values().cloned().collect()
    }

    pub(super) async fn suspend_all(&self) {
        for session in self.sessions().await {
            session.suspend_for_background_limit();
        }
        let tasks = self
            .tasks
            .lock()
            .await
            .drain()
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        for task in tasks {
            let _ = task.await;
        }
    }

    pub(super) async fn get(&self, id: &str) -> Result<Arc<Session>, CommandError> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| CommandError::new("NOT_FOUND", "session not found"))
    }

    pub(super) async fn list(&self) -> Vec<SessionInfo> {
        self.reap_finished().await;
        self.sessions
            .read()
            .await
            .values()
            .map(|session| session.info())
            .collect()
    }

    pub(super) async fn close(&self, id: &str) -> Result<(), CommandError> {
        let session = self.get(id).await?;
        session.cancel();
        self.sessions.write().await.remove(id);
        if let Some(task) = self.tasks.lock().await.remove(id) {
            let _ = task.await;
        }
        Ok(())
    }

    pub(super) async fn shutdown(&self) {
        let sessions = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            session.cancel();
        }

        let tasks = self
            .tasks
            .lock()
            .await
            .drain()
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        for task in tasks {
            let _ = task.await;
        }
        self.sessions.write().await.clear();
    }

    async fn reap_finished(&self) {
        let finished = {
            let tasks = self.tasks.lock().await;
            tasks
                .iter()
                .filter(|(_, task)| task.is_finished())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>()
        };
        let mut tasks = self.tasks.lock().await;
        for id in finished {
            tasks.remove(&id);
        }
    }
}
