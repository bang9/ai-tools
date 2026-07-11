//! macOS browser cookie import: detect installed browsers and read+decrypt
//! their cookie stores into a normalized list. Chromium cookies are decrypted
//! with the AES-128-CBC key derived from the browser's Keychain "Safe Storage"
//! password; Safari and Firefox stores are plaintext.

use aes::Aes128;
use cbc::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};
use cbc::Decryptor;
use pbkdf2::pbkdf2_hmac;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha1::Sha1;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

type Aes128CbcDec = Decryptor<Aes128>;

// Chromium 127+ prepends a 32-byte per-host HMAC to the plaintext before encrypting.
const CHROMIUM_COOKIE_HMAC_LEN: usize = 32;
// Microseconds between the Windows/Chromium 1601 epoch and the Unix 1970 epoch.
const CHROMIUM_EPOCH_OFFSET_SECS: i64 = 11_644_473_600;
// Seconds between the Mac 2001 epoch (Safari) and the Unix 1970 epoch.
const MAC_EPOCH_DELTA_SECS: i64 = 978_307_200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCookie {
    pub host: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub expires_utc: Option<i64>,
    pub same_site: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBrowser {
    pub family: String,
    pub label: String,
    pub available: bool,
}

struct ChromiumDef {
    family: &'static str,
    label: &'static str,
    /// Path to the cookie store relative to `~/Library/Application Support`.
    subpath: &'static str,
    keychain_service: &'static str,
    keychain_account: &'static str,
}

const CHROMIUM_DEFS: [ChromiumDef; 5] = [
    ChromiumDef {
        family: "chrome",
        label: "Google Chrome",
        subpath: "Google/Chrome/Default/Cookies",
        keychain_service: "Chrome Safe Storage",
        keychain_account: "Chrome",
    },
    ChromiumDef {
        family: "arc",
        label: "Arc",
        subpath: "Arc/User Data/Default/Cookies",
        keychain_service: "Arc Safe Storage",
        keychain_account: "Arc",
    },
    ChromiumDef {
        family: "brave",
        label: "Brave",
        subpath: "BraveSoftware/Brave-Browser/Default/Cookies",
        keychain_service: "Brave Safe Storage",
        keychain_account: "Brave",
    },
    ChromiumDef {
        family: "edge",
        label: "Microsoft Edge",
        subpath: "Microsoft Edge/Default/Cookies",
        keychain_service: "Microsoft Edge Safe Storage",
        keychain_account: "Microsoft Edge",
    },
    ChromiumDef {
        family: "chromium",
        label: "Chromium",
        subpath: "Chromium/Default/Cookies",
        keychain_service: "Chromium Safe Storage",
        keychain_account: "Chromium",
    },
];

fn app_support_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Library").join("Application Support"))
}

fn chromium_cookie_path(def: &ChromiumDef) -> Option<PathBuf> {
    app_support_dir().map(|base| base.join(def.subpath))
}

fn safari_cookie_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join("Library/Cookies/Cookies.binarycookies"),
        home.join(
            "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
        ),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Firefox stores cookies under a randomly-named profile dir; return the first
/// profile that has a `cookies.sqlite`.
fn firefox_cookie_path() -> Option<PathBuf> {
    let profiles_root = app_support_dir()?.join("Firefox/Profiles");
    let entries = fs::read_dir(&profiles_root).ok()?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            candidates.push(entry.path());
        }
    }
    // Prefer a `default-release` profile, matching Firefox's primary install.
    candidates.sort_by_key(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.contains("default-release") {
            0
        } else if name.contains("default") {
            1
        } else {
            2
        }
    });
    candidates
        .into_iter()
        .map(|dir| dir.join("cookies.sqlite"))
        .find(|p| p.exists())
}

pub fn detect_installed_browsers_impl() -> Vec<DetectedBrowser> {
    let mut detected = Vec::new();
    for def in &CHROMIUM_DEFS {
        let available = chromium_cookie_path(def).map(|p| p.exists()).unwrap_or(false);
        detected.push(DetectedBrowser {
            family: def.family.to_string(),
            label: def.label.to_string(),
            available,
        });
    }
    detected.push(DetectedBrowser {
        family: "safari".to_string(),
        label: "Safari".to_string(),
        available: safari_cookie_path().is_some(),
    });
    detected.push(DetectedBrowser {
        family: "firefox".to_string(),
        label: "Firefox".to_string(),
        available: firefox_cookie_path().is_some(),
    });
    detected
}

pub fn read_browser_cookies_impl(
    family: &str,
    host_filter: Option<&str>,
) -> Result<Vec<ImportedCookie>, String> {
    match family {
        "chrome" | "arc" | "brave" | "edge" | "chromium" => read_chromium(family, host_filter),
        "safari" => read_safari(host_filter),
        "firefox" => read_firefox(host_filter),
        other => Err(format!("unknown browser family: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Chromium decryption helpers (pure, unit-testable)
// ---------------------------------------------------------------------------

fn derive_chromium_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

/// Strip PKCS7 padding; error on a malformed pad so a bad key surfaces instead
/// of returning silently-truncated plaintext.
fn pkcs7_unpad(data: &[u8]) -> Result<Vec<u8>, String> {
    let pad = *data.last().ok_or("empty block")? as usize;
    if pad == 0 || pad > 16 || pad > data.len() {
        return Err(format!("invalid pkcs7 pad length {pad}"));
    }
    if data[data.len() - pad..].iter().any(|&b| b as usize != pad) {
        return Err("inconsistent pkcs7 padding".to_string());
    }
    Ok(data[..data.len() - pad].to_vec())
}

/// The HMAC is a hash, so roughly half its bytes fall outside printable ASCII
/// while real cookie values are overwhelmingly printable. Mirror orca's
/// heuristic: strip the leading 32 bytes when >=8 of them are non-printable.
fn strip_hmac_prefix(plaintext: &[u8]) -> &[u8] {
    if plaintext.len() <= CHROMIUM_COOKIE_HMAC_LEN {
        return plaintext;
    }
    let non_printable = plaintext[..CHROMIUM_COOKIE_HMAC_LEN]
        .iter()
        .filter(|&&b| !(0x20..=0x7e).contains(&b))
        .count();
    if non_printable >= 8 {
        &plaintext[CHROMIUM_COOKIE_HMAC_LEN..]
    } else {
        plaintext
    }
}

/// Decrypt a Chromium `encrypted_value`: a 3-byte "v10" version prefix followed
/// by AES-128-CBC ciphertext with a 16-byte space IV.
fn decrypt_chromium_value(encrypted: &[u8], key: &[u8; 16]) -> Result<Vec<u8>, String> {
    if encrypted.len() < 3 {
        return Err("ciphertext too short".to_string());
    }
    let prefix = &encrypted[..3];
    if prefix[0] != b'v' || !prefix[1].is_ascii_digit() || !prefix[2].is_ascii_digit() {
        return Err("unsupported cookie encryption version".to_string());
    }
    let ciphertext = &encrypted[3..];
    if ciphertext.is_empty() {
        return Ok(Vec::new());
    }
    if !ciphertext.len().is_multiple_of(16) {
        return Err("ciphertext length is not a multiple of the block size".to_string());
    }
    let iv = [0x20u8; 16];
    let mut buf = ciphertext.to_vec();
    let decrypted = Aes128CbcDec::new(key.into(), (&iv).into())
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("aes-128-cbc decrypt failed: {e}"))?;
    let unpadded = pkcs7_unpad(decrypted)?;
    Ok(strip_hmac_prefix(&unpadded).to_vec())
}

/// Chromium `expires_utc` is microseconds since 1601-01-01; 0 means a session
/// cookie (no expiry).
fn chromium_micros_to_unix(micros: i64) -> Option<i64> {
    if micros == 0 {
        return None;
    }
    Some(micros / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SECS)
}

/// Chromium SQLite `samesite`: -1=unspecified, 0=none, 1=lax, 2=strict.
fn chromium_same_site(raw: i64) -> Option<String> {
    match raw {
        0 => Some("no_restriction".to_string()),
        1 => Some("lax".to_string()),
        2 => Some("strict".to_string()),
        _ => None,
    }
}

/// Firefox `moz_cookies.sameSite`: 0=none, 1=lax, 2=strict.
fn firefox_same_site(raw: i64) -> Option<String> {
    match raw {
        0 => Some("no_restriction".to_string()),
        1 => Some("lax".to_string()),
        2 => Some("strict".to_string()),
        _ => None,
    }
}

/// A cookie applies to `filter_host` when its host_key equals the filter host or
/// is a parent domain of it (leading dots ignored).
fn host_matches_filter(host_key: &str, filter_host: &str) -> bool {
    let cookie_host = host_key
        .strip_prefix('.')
        .unwrap_or(host_key)
        .to_ascii_lowercase();
    let filter = filter_host
        .strip_prefix('.')
        .unwrap_or(filter_host)
        .to_ascii_lowercase();
    if cookie_host.is_empty() || filter.is_empty() {
        return false;
    }
    filter == cookie_host || filter.ends_with(&format!(".{cookie_host}"))
}

// ---------------------------------------------------------------------------
// Temp copy of a (possibly locked) SQLite store
// ---------------------------------------------------------------------------

/// Removes its temp directory on drop so cookie copies never linger on disk.
struct TempCopy {
    dir: PathBuf,
    db_path: PathBuf,
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The live store may be locked while the browser runs, so copy it (and any WAL
/// sidecars) to a private temp dir and read the copy.
fn copy_sqlite_to_temp(src: &Path) -> Result<TempCopy, String> {
    let dir = std::env::temp_dir().join(format!("grove-cookies-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).map_err(|e| format!("could not create temp dir: {e}"))?;
    let copy = TempCopy {
        dir: dir.clone(),
        db_path: dir.join("cookies.db"),
    };
    fs::copy(src, &copy.db_path).map_err(|e| format!("could not copy cookie database: {e}"))?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = append_suffix(src, suffix);
        if sidecar.exists() {
            let _ = fs::copy(&sidecar, append_suffix(&copy.db_path, suffix));
        }
    }
    Ok(copy)
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

// ---------------------------------------------------------------------------
// Chromium reader
// ---------------------------------------------------------------------------

fn get_keychain_password(service: &str, account: &str) -> Result<Vec<u8>, String> {
    // Triggers a macOS Keychain prompt on first access — expected behavior.
    let output = Command::new("security")
        .args(["find-generic-password", "-s", service, "-a", account, "-w"])
        .output()
        .map_err(|e| format!("could not run security: {e}"))?;
    if !output.status.success() {
        return Err("Keychain access denied".to_string());
    }
    let mut password = output.stdout;
    while matches!(password.last(), Some(b'\n' | b'\r')) {
        password.pop();
    }
    if password.is_empty() {
        return Err("Keychain returned an empty password".to_string());
    }
    Ok(password)
}

struct RawChromiumRow {
    host_key: String,
    name: String,
    value_plain: Vec<u8>,
    encrypted_value: Vec<u8>,
    path: String,
    is_secure: i64,
    is_httponly: i64,
    expires_utc: i64,
    samesite: i64,
}

fn read_chromium(
    family: &str,
    host_filter: Option<&str>,
) -> Result<Vec<ImportedCookie>, String> {
    let def = CHROMIUM_DEFS
        .iter()
        .find(|d| d.family == family)
        .ok_or_else(|| format!("unknown chromium family: {family}"))?;
    let cookie_path = chromium_cookie_path(def)
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    if !cookie_path.exists() {
        return Err(format!("{} cookie store not found", def.label));
    }

    let temp = copy_sqlite_to_temp(&cookie_path)?;
    let rows = query_chromium_rows(&temp.db_path)?;

    let needs_key = rows.iter().any(|r| !r.encrypted_value.is_empty());
    let key = if needs_key {
        let password = get_keychain_password(def.keychain_service, def.keychain_account)?;
        Some(derive_chromium_key(&password))
    } else {
        None
    };

    let mut cookies = Vec::new();
    for row in rows {
        if let Some(filter) = host_filter {
            if !host_matches_filter(&row.host_key, filter) {
                continue;
            }
        }
        let value = if !row.encrypted_value.is_empty() {
            match key.as_ref().and_then(|k| decrypt_chromium_value(&row.encrypted_value, k).ok()) {
                Some(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                // A single undecryptable cookie shouldn't fail the whole import.
                None => continue,
            }
        } else {
            String::from_utf8_lossy(&row.value_plain).into_owned()
        };
        cookies.push(ImportedCookie {
            host: row.host_key,
            name: row.name,
            value,
            path: row.path,
            secure: row.is_secure != 0,
            http_only: row.is_httponly != 0,
            expires_utc: chromium_micros_to_unix(row.expires_utc),
            same_site: chromium_same_site(row.samesite),
        });
    }
    Ok(cookies)
}

fn query_chromium_rows(db_path: &Path) -> Result<Vec<RawChromiumRow>, String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("could not open cookie database: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT host_key, name, value, encrypted_value, path, \
             is_secure, is_httponly, expires_utc, samesite FROM cookies",
        )
        .map_err(|e| format!("could not read cookies table: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RawChromiumRow {
                host_key: row.get(0)?,
                name: row.get(1)?,
                value_plain: row.get::<_, Vec<u8>>(2).unwrap_or_default(),
                encrypted_value: row.get::<_, Vec<u8>>(3).unwrap_or_default(),
                path: row.get(4)?,
                is_secure: row.get(5)?,
                is_httponly: row.get(6)?,
                expires_utc: row.get(7)?,
                samesite: row.get(8)?,
            })
        })
        .map_err(|e| format!("could not query cookies: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("could not read cookie row: {e}"))?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Firefox reader
// ---------------------------------------------------------------------------

fn read_firefox(host_filter: Option<&str>) -> Result<Vec<ImportedCookie>, String> {
    let cookie_path =
        firefox_cookie_path().ok_or_else(|| "Firefox cookie store not found".to_string())?;
    let temp = copy_sqlite_to_temp(&cookie_path)?;
    let conn = Connection::open_with_flags(&temp.db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("could not open Firefox cookie database: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT host, name, value, path, isSecure, isHttpOnly, expiry, sameSite \
             FROM moz_cookies",
        )
        .map_err(|e| format!("could not read moz_cookies: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let host: String = row.get(0)?;
            let expiry: i64 = row.get(6)?;
            Ok(ImportedCookie {
                host,
                name: row.get(1)?,
                value: row.get::<_, String>(2).unwrap_or_default(),
                path: row.get(3)?,
                secure: row.get::<_, i64>(4)? != 0,
                http_only: row.get::<_, i64>(5)? != 0,
                // Firefox `expiry` is already Unix seconds; 0 means session.
                expires_utc: if expiry > 0 { Some(expiry) } else { None },
                same_site: firefox_same_site(row.get(7)?),
            })
        })
        .map_err(|e| format!("could not query Firefox cookies: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let cookie = row.map_err(|e| format!("could not read Firefox cookie row: {e}"))?;
        if let Some(filter) = host_filter {
            if !host_matches_filter(&cookie.host, filter) {
                continue;
            }
        }
        out.push(cookie);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Safari binarycookies parser
// ---------------------------------------------------------------------------

fn read_safari(host_filter: Option<&str>) -> Result<Vec<ImportedCookie>, String> {
    let cookie_path =
        safari_cookie_path().ok_or_else(|| "Safari cookie store not found".to_string())?;
    let bytes = fs::read(&cookie_path).map_err(|e| {
        // Safari cookies live in a sandbox container needing Full Disk Access.
        format!("could not read Safari cookies (grant Full Disk Access): {e}")
    })?;
    let mut cookies = parse_binarycookies(&bytes);
    if let Some(filter) = host_filter {
        cookies.retain(|c| host_matches_filter(&c.host, filter));
    }
    Ok(cookies)
}

fn read_u32_be(buf: &[u8], off: usize) -> Option<u32> {
    buf.get(off..off + 4)
        .map(|s| u32::from_be_bytes(s.try_into().unwrap()))
}

fn read_u32_le(buf: &[u8], off: usize) -> Option<u32> {
    buf.get(off..off + 4)
        .map(|s| u32::from_le_bytes(s.try_into().unwrap()))
}

fn read_f64_le(buf: &[u8], off: usize) -> Option<f64> {
    buf.get(off..off + 8)
        .map(|s| f64::from_le_bytes(s.try_into().unwrap()))
}

/// Read a NUL-terminated string starting at `offset`, bounded by `end`.
fn read_cstring(buf: &[u8], offset: usize, end: usize) -> Option<String> {
    if offset >= end || offset >= buf.len() {
        return None;
    }
    let limit = end.min(buf.len());
    let slice = &buf[offset..limit];
    let nul = slice.iter().position(|&b| b == 0)?;
    Some(String::from_utf8_lossy(&slice[..nul]).into_owned())
}

/// Parse the `Cookies.binarycookies` container: magic "cook", a big-endian page
/// count and per-page sizes, then each page.
fn parse_binarycookies(buf: &[u8]) -> Vec<ImportedCookie> {
    if buf.len() < 8 || &buf[0..4] != b"cook" {
        return Vec::new();
    }
    let page_count = match read_u32_be(buf, 4) {
        Some(n) => n as usize,
        None => return Vec::new(),
    };
    let mut cursor = 8;
    let mut page_sizes = Vec::with_capacity(page_count);
    for _ in 0..page_count {
        match read_u32_be(buf, cursor) {
            Some(size) => page_sizes.push(size as usize),
            None => return Vec::new(),
        }
        cursor += 4;
    }

    let mut cookies = Vec::new();
    for page_size in page_sizes {
        let end = cursor.saturating_add(page_size).min(buf.len());
        if cursor < end {
            parse_binarycookies_page(&buf[cursor..end], &mut cookies);
        }
        cursor += page_size;
    }
    cookies
}

/// Each page: a big-endian 0x00000100 header, a little-endian cookie count, then
/// little-endian per-cookie offsets relative to the page start.
fn parse_binarycookies_page(page: &[u8], out: &mut Vec<ImportedCookie>) {
    if page.len() < 8 || read_u32_be(page, 0) != Some(0x0000_0100) {
        return;
    }
    let cookie_count = match read_u32_le(page, 4) {
        Some(n) => n as usize,
        None => return,
    };
    if 8 + cookie_count * 4 > page.len() {
        return;
    }
    for i in 0..cookie_count {
        if let Some(offset) = read_u32_le(page, 8 + i * 4) {
            let offset = offset as usize;
            if offset < page.len() {
                if let Some(cookie) = parse_binarycookies_record(&page[offset..]) {
                    out.push(cookie);
                }
            }
        }
    }
}

/// A cookie record: little-endian size, flags, field offsets, and a Mac-absolute
/// expiration (seconds since 2001-01-01) stored as an f64.
fn parse_binarycookies_record(buf: &[u8]) -> Option<ImportedCookie> {
    if buf.len() < 48 {
        return None;
    }
    // Size is file-controlled; clamp so string reads cannot escape the record.
    let size = (read_u32_le(buf, 0)? as usize).min(buf.len());
    if size < 48 {
        return None;
    }
    let flags = read_u32_le(buf, 8)?;
    let secure = flags & 1 != 0;
    let http_only = flags & 4 != 0;

    let url_offset = read_u32_le(buf, 16)? as usize;
    let name_offset = read_u32_le(buf, 20)? as usize;
    let path_offset = read_u32_le(buf, 24)? as usize;
    let value_offset = read_u32_le(buf, 28)? as usize;
    let expiration = read_f64_le(buf, 40).unwrap_or(0.0);

    let host = read_cstring(buf, url_offset, size)?;
    let name = read_cstring(buf, name_offset, size)?;
    if name.is_empty() || host.is_empty() {
        return None;
    }
    let value = read_cstring(buf, value_offset, size).unwrap_or_default();
    let path = read_cstring(buf, path_offset, size).unwrap_or_else(|| "/".to_string());

    let expires_utc = if expiration > 0.0 {
        Some(expiration.round() as i64 + MAC_EPOCH_DELTA_SECS)
    } else {
        None
    };

    Some(ImportedCookie {
        host,
        name,
        value,
        path,
        secure,
        http_only,
        expires_utc,
        same_site: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use cbc::Encryptor;

    type Aes128CbcEnc = Encryptor<Aes128>;

    fn encrypt_v10(plaintext: &[u8], key: &[u8; 16]) -> Vec<u8> {
        let iv = [0x20u8; 16];
        let mut buf = vec![0u8; plaintext.len() + 16];
        buf[..plaintext.len()].copy_from_slice(plaintext);
        let ct = Aes128CbcEnc::new(key.into(), (&iv).into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
            .expect("encrypt");
        let mut out = b"v10".to_vec();
        out.extend_from_slice(ct);
        out
    }

    #[test]
    fn decrypt_roundtrip_recovers_plaintext() {
        let key = derive_chromium_key(b"hunter2");
        let plaintext = b"session=abc123; theme=dark";
        let encrypted = encrypt_v10(plaintext, &key);
        let decrypted = decrypt_chromium_value(&encrypted, &key).expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_rejects_unknown_version() {
        let key = derive_chromium_key(b"pw");
        assert!(decrypt_chromium_value(b"xx0abcdef", &key).is_err());
    }

    #[test]
    fn pkcs7_unpad_valid_and_malformed() {
        // 4 bytes of data padded to one 16-byte block with 0x0c repeated.
        let mut block = vec![0xAAu8; 4];
        block.extend(std::iter::repeat(12u8).take(12));
        assert_eq!(pkcs7_unpad(&block).unwrap(), vec![0xAAu8; 4]);

        // Inconsistent trailing bytes must be rejected.
        let mut bad = vec![0xAAu8; 12];
        bad.extend_from_slice(&[4, 4, 3, 4]);
        assert!(pkcs7_unpad(&bad).is_err());

        // A zero pad byte is invalid.
        let zero = vec![0u8; 16];
        assert!(pkcs7_unpad(&zero).is_err());
    }

    #[test]
    fn strip_hmac_prefix_removes_binary_header() {
        let mut with_hmac = vec![0u8; CHROMIUM_COOKIE_HMAC_LEN];
        with_hmac.extend_from_slice(b"real-value");
        assert_eq!(strip_hmac_prefix(&with_hmac), b"real-value");
    }

    #[test]
    fn strip_hmac_prefix_leaves_short_value() {
        let value = b"short";
        assert_eq!(strip_hmac_prefix(value), value);
    }

    #[test]
    fn strip_hmac_prefix_leaves_printable_long_value() {
        // 40 printable bytes: first 32 are all printable, so nothing is stripped.
        let value = b"abcdefghijklmnopqrstuvwxyzabcdef01234567";
        assert_eq!(strip_hmac_prefix(value), value);
    }

    #[test]
    fn chromium_micros_conversion() {
        // 2021-01-01T00:00:00Z = 1609459200 unix.
        let micros = (1609459200 + CHROMIUM_EPOCH_OFFSET_SECS) * 1_000_000;
        assert_eq!(chromium_micros_to_unix(micros), Some(1609459200));
        assert_eq!(chromium_micros_to_unix(0), None);
    }

    #[test]
    fn same_site_mappings() {
        assert_eq!(chromium_same_site(-1), None);
        assert_eq!(chromium_same_site(0), Some("no_restriction".to_string()));
        assert_eq!(chromium_same_site(1), Some("lax".to_string()));
        assert_eq!(chromium_same_site(2), Some("strict".to_string()));
    }

    #[test]
    fn host_filter_suffix_matching() {
        assert!(host_matches_filter(".example.com", "app.example.com"));
        assert!(host_matches_filter("app.example.com", "app.example.com"));
        assert!(host_matches_filter(".example.com", "example.com"));
        assert!(!host_matches_filter(".other.com", "app.example.com"));
        assert!(!host_matches_filter(".app.example.com", "example.com"));
    }

    /// Build a minimal binarycookies buffer with one cookie and assert the
    /// parser extracts its fields.
    #[test]
    fn parse_binarycookies_single_cookie() {
        // Record: 56-byte fixed header + NUL-terminated strings.
        let url = b".example.com\0";
        let name = b"session\0";
        let path = b"/\0";
        let value = b"abc123\0";
        let url_off = 56usize;
        let name_off = url_off + url.len();
        let path_off = name_off + name.len();
        let value_off = path_off + path.len();
        let record_size = value_off + value.len();

        let mut record = vec![0u8; 56];
        record[0..4].copy_from_slice(&(record_size as u32).to_le_bytes());
        record[8..12].copy_from_slice(&1u32.to_le_bytes()); // flags: secure
        record[16..20].copy_from_slice(&(url_off as u32).to_le_bytes());
        record[20..24].copy_from_slice(&(name_off as u32).to_le_bytes());
        record[24..28].copy_from_slice(&(path_off as u32).to_le_bytes());
        record[28..32].copy_from_slice(&(value_off as u32).to_le_bytes());
        // Expiration: unix 1700000000 -> mac-absolute.
        let mac_expiry = (1700000000 - MAC_EPOCH_DELTA_SECS) as f64;
        record[40..48].copy_from_slice(&mac_expiry.to_le_bytes());
        record.extend_from_slice(url);
        record.extend_from_slice(name);
        record.extend_from_slice(path);
        record.extend_from_slice(value);

        // Page: header + cookie count + one offset, then the record.
        let cookie_offset = 12u32; // 4 (header) + 4 (count) + 4 (one offset)
        let mut page = Vec::new();
        page.extend_from_slice(&0x0000_0100u32.to_be_bytes());
        page.extend_from_slice(&1u32.to_le_bytes());
        page.extend_from_slice(&cookie_offset.to_le_bytes());
        page.extend_from_slice(&record);

        // Container: magic + page count + page size + page.
        let mut file = Vec::new();
        file.extend_from_slice(b"cook");
        file.extend_from_slice(&1u32.to_be_bytes());
        file.extend_from_slice(&(page.len() as u32).to_be_bytes());
        file.extend_from_slice(&page);

        let cookies = parse_binarycookies(&file);
        assert_eq!(cookies.len(), 1);
        let c = &cookies[0];
        assert_eq!(c.host, ".example.com");
        assert_eq!(c.name, "session");
        assert_eq!(c.value, "abc123");
        assert_eq!(c.path, "/");
        assert!(c.secure);
        assert!(!c.http_only);
        assert_eq!(c.expires_utc, Some(1700000000));
    }
}
