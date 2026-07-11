use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

/// Per-PTY output sink over a `tauri::ipc::Channel`. The global emit path
/// JSON-serializes, which would turn raw bytes into a number array; a channel
/// carrying an [`InvokeResponseBody::Raw`] delivers an ArrayBuffer to JS with no
/// base64 and no JSON blowup. The channel is created per `create_pty` call, so
/// each PTY owns its own channel and teardown follows the PTY reader lifecycle
/// (the channel drops when this sink drops on reader EOF).
pub struct TauriEventSink(pub Channel);

impl grove_core::PtyEventSink for TauriEventSink {
    fn on_output(&self, _pty_id: &str, data: &[u8]) {
        // The channel is per-PTY, so routing needs no id; JS routes by the ptyId
        // captured when it created the channel.
        let _ = self.0.send(InvokeResponseBody::Raw(data.to_vec()));
    }
}

#[derive(Serialize, Clone)]
struct LogPayload {
    level: String,
    tag: String,
    message: String,
}

pub struct TauriLogSink(pub AppHandle);

impl grove_core::LogEventSink for TauriLogSink {
    fn on_log(&self, level: &str, tag: &str, message: &str) {
        let payload = LogPayload {
            level: level.to_string(),
            tag: tag.to_string(),
            message: message.to_string(),
        };
        let _ = self.0.emit("grove:log", payload);
    }
}

pub struct TauriUrlOpenSink(pub AppHandle);

impl grove_core::UrlOpenSink for TauriUrlOpenSink {
    fn on_url(&self, url: &str) {
        let _ = self.0.emit("grove:open-url", url.to_string());
    }
}

pub fn init(app: &AppHandle) {
    grove_core::logger::set_log_sink(Arc::new(TauriLogSink(app.clone())));
    grove_core::url_open::start(Arc::new(TauriUrlOpenSink(app.clone())));
}

pub fn pty_sink(on_output: Channel) -> Arc<dyn grove_core::PtyEventSink> {
    Arc::new(TauriEventSink(on_output))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CloneCompletedPayload {
    pub id: String,
    pub project: grove_core::Project,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CloneFailedPayload {
    pub id: String,
    pub error: String,
}
