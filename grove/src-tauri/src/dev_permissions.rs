//! Developer permissions status/request for terminal-launched tools.
//!
//! Port of orca's macOS "Developer Permissions" system (see
//! src/main/ipc/developer-permissions.ts in orca). Mirrors the Electron shell's
//! command contract exactly: `dev_permissions_status` returns all ids in a fixed
//! order, `dev_permissions_request` triggers the OS prompt or opens the matching
//! Privacy pane. Everything OS-specific is macOS-only; other platforms report
//! "unsupported" so the crate still compiles and the UI degrades cleanly.

use serde::Serialize;

/// The 5 permissions grove surfaces, in the order the status command returns
/// them (orca's set minus usb/bluetooth and the prompt-only automation /
/// local-network rows, which macOS re-prompts for on real use anyway).
const DEV_PERMISSION_IDS: [&str; 5] = [
    "microphone",
    "camera",
    "screen",
    "accessibility",
    "full-disk-access",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPermissionState {
    id: String,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPermissionRequestResult {
    id: String,
    status: String,
    opened_system_settings: bool,
}

#[tauri::command]
pub async fn dev_permissions_status() -> Result<Vec<DevPermissionState>, String> {
    Ok(DEV_PERMISSION_IDS
        .iter()
        .map(|id| DevPermissionState {
            id: (*id).to_string(),
            status: permission_status(id),
        })
        .collect())
}

#[tauri::command]
pub async fn dev_permissions_request(id: String) -> Result<DevPermissionRequestResult, String> {
    if !DEV_PERMISSION_IDS.contains(&id.as_str()) {
        return Ok(DevPermissionRequestResult {
            id,
            status: "unsupported".to_string(),
            opened_system_settings: false,
        });
    }
    Ok(request_permission(id).await)
}

// === macOS implementation ===

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    use block2::RcBlock;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};

    // AVMediaType string values (the four-char codes are the literal NSString
    // values of AVMediaTypeVideo / AVMediaTypeAudio, so comparing by value works
    // without linking the framework's exported constants).
    const MEDIA_VIDEO: &[u8] = b"vide\0";
    const MEDIA_AUDIO: &[u8] = b"soun\0";

    // Force-link AVFoundation so the AVCaptureDevice class is registered at
    // runtime; the empty block just pulls in the framework.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    fn privacy_pane_url(id: &str) -> &'static str {
        match id {
            "camera" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "screen" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "full-disk-access" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
            }
            _ => "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
        }
    }

    fn open_privacy_pane(id: &str) {
        let _ = std::process::Command::new("open")
            .arg(privacy_pane_url(id))
            .status();
    }

    /// Build an autoreleased NSString from a NUL-terminated C string literal.
    unsafe fn nsstring(utf8: &[u8]) -> *mut AnyObject {
        let cls = class!(NSString);
        msg_send![cls, stringWithUTF8String: utf8.as_ptr()]
    }

    /// Map AVAuthorizationStatus (0..=3) to the shared status vocabulary.
    fn media_status(media: &[u8]) -> String {
        let raw: isize = unsafe {
            let cls = class!(AVCaptureDevice);
            let media = nsstring(media);
            msg_send![cls, authorizationStatusForMediaType: media]
        };
        match raw {
            0 => "not-determined",
            1 => "restricted",
            2 => "denied",
            3 => "granted",
            _ => "unknown",
        }
        .to_string()
    }

    /// Whether the running image's main bundle carries the given Info.plist
    /// usage-description key. TCC SIGKILLs the process when requestAccess is
    /// called without it (e.g. a `tauri dev` binary built before Info.plist
    /// embedding, or a stale image after an on-disk rebuild), so this checks
    /// the exact source TCC consults before ever triggering the prompt.
    fn has_usage_description(key: &[u8]) -> bool {
        unsafe {
            let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
            if bundle.is_null() {
                return false;
            }
            let key = nsstring(key);
            let value: *mut AnyObject = msg_send![bundle, objectForInfoDictionaryKey: key];
            !value.is_null()
        }
    }

    fn usage_description_key(media: &'static [u8]) -> &'static [u8] {
        if media == MEDIA_AUDIO {
            b"NSMicrophoneUsageDescription\0"
        } else {
            b"NSCameraUsageDescription\0"
        }
    }

    /// Trigger the OS media-access prompt and await its result. Delivers the
    /// completion bool through a oneshot so the async command never blocks a
    /// runtime thread; the handler may fire on an arbitrary dispatch queue.
    async fn request_media_access(media: &'static [u8]) -> bool {
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        // send consumes the Sender, so guard it in a Mutex<Option<..>> the
        // 'static Fn block can drain exactly once.
        let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        // Scope the block so it is dropped before the await: RcBlock is not Send
        // and the tauri command future must be. requestAccessForMediaType: copies
        // the block internally, so dropping our handle here is safe.
        {
            let handler = RcBlock::new(move |granted: Bool| {
                if let Ok(mut slot) = tx.lock() {
                    if let Some(sender) = slot.take() {
                        let _ = sender.send(granted.as_bool());
                    }
                }
            });
            unsafe {
                let cls = class!(AVCaptureDevice);
                let media = nsstring(media);
                let _: () =
                    msg_send![cls, requestAccessForMediaType: media, completionHandler: &*handler];
            }
        }
        // If the sender is dropped without firing, treat it as not granted.
        rx.await.unwrap_or(false)
    }

    fn screen_status() -> String {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            "granted".to_string()
        } else {
            "unknown".to_string()
        }
    }

    fn accessibility_status() -> String {
        if unsafe { AXIsProcessTrusted() } {
            "granted".to_string()
        } else {
            "unknown".to_string()
        }
    }

    fn full_disk_status() -> String {
        // Safari bookmarks are TCC-protected, so read access is a practical Full
        // Disk Access signal without touching user project contents.
        let Some(home) = std::env::var_os("HOME") else {
            return "unknown".to_string();
        };
        let path = std::path::Path::new(&home)
            .join("Library")
            .join("Safari")
            .join("Bookmarks.plist");
        if std::fs::File::open(path).is_ok() {
            "granted".to_string()
        } else {
            "unknown".to_string()
        }
    }

    pub fn permission_status(id: &str) -> String {
        match id {
            "microphone" => media_status(MEDIA_AUDIO),
            "camera" => media_status(MEDIA_VIDEO),
            "screen" => screen_status(),
            "accessibility" => accessibility_status(),
            "full-disk-access" => full_disk_status(),
            _ => "unsupported".to_string(),
        }
    }

    async fn request_media(id: &str, media: &'static [u8]) -> DevPermissionRequestResult {
        if !has_usage_description(usage_description_key(media)) {
            open_privacy_pane(id);
            return DevPermissionRequestResult {
                id: id.to_string(),
                status: media_status(media),
                opened_system_settings: true,
            };
        }
        // askForMediaAccess only surfaces the TCC prompt when status is
        // not-determined; after a prior denial it resolves false with no prompt,
        // so fall through to the Privacy pane where the user can toggle it.
        if request_media_access(media).await {
            return DevPermissionRequestResult {
                id: id.to_string(),
                status: "granted".to_string(),
                opened_system_settings: false,
            };
        }
        let status = media_status(media);
        if matches!(status.as_str(), "denied" | "restricted" | "unknown") {
            open_privacy_pane(id);
            return DevPermissionRequestResult {
                id: id.to_string(),
                status,
                opened_system_settings: true,
            };
        }
        DevPermissionRequestResult {
            id: id.to_string(),
            status,
            opened_system_settings: false,
        }
    }

    pub async fn request_permission(id: String) -> DevPermissionRequestResult {
        match id.as_str() {
            "microphone" => request_media(&id, MEDIA_AUDIO).await,
            "camera" => request_media(&id, MEDIA_VIDEO).await,
            "accessibility" => {
                // Skip AXIsProcessTrustedWithOptions' prompt: if already trusted
                // report granted, otherwise open the Accessibility pane.
                if unsafe { AXIsProcessTrusted() } {
                    DevPermissionRequestResult {
                        id,
                        status: "granted".to_string(),
                        opened_system_settings: false,
                    }
                } else {
                    open_privacy_pane(&id);
                    DevPermissionRequestResult {
                        id,
                        status: "unknown".to_string(),
                        opened_system_settings: true,
                    }
                }
            }
            // screen / full-disk-access: no request API, just open the pane.
            _ => {
                open_privacy_pane(&id);
                DevPermissionRequestResult {
                    status: permission_status(&id),
                    id,
                    opened_system_settings: true,
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn permission_status(id: &str) -> String {
    imp::permission_status(id)
}

#[cfg(target_os = "macos")]
async fn request_permission(id: String) -> DevPermissionRequestResult {
    imp::request_permission(id).await
}

#[cfg(not(target_os = "macos"))]
fn permission_status(_id: &str) -> String {
    "unsupported".to_string()
}

#[cfg(not(target_os = "macos"))]
async fn request_permission(id: String) -> DevPermissionRequestResult {
    DevPermissionRequestResult {
        id,
        status: "unsupported".to_string(),
        opened_system_settings: false,
    }
}
