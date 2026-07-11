//! Inject imported HTTP cookies into WebKit's default cookie store.
//!
//! grove's browser tabs are wry `WKWebView`s backed by
//! `WKWebsiteDataStore.defaultDataStore()`. Writing `NSHTTPCookie`s into that
//! store's `httpCookieStore` makes the user appear logged in on the next load.
//!
//! All Objective-C calls here must run on the macOS main thread; the caller is
//! responsible for that (the Tauri command invokes this on the main-thread
//! handler). `set_cookies` early-returns 0 if it detects it is off the main
//! thread.

use grove_core::browser_cookies::ImportedCookie;

/// Inject `cookies` into WebKit's default persistent cookie store and return
/// how many were set successfully. Must be called on the macOS main thread.
#[cfg(target_os = "macos")]
pub fn set_cookies(cookies: &[ImportedCookie]) -> usize {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::CString;
    use std::ptr;

    /// Build an autoreleased `NSString` from `s`. Interior NUL bytes are
    /// stripped so `CString::new` never fails.
    unsafe fn ns_string(s: &str) -> *mut AnyObject {
        let cleaned: Vec<u8> = s.bytes().filter(|&b| b != 0).collect();
        let c = CString::new(cleaned).expect("no interior nul after filter");
        let cls = class!(NSString);
        msg_send![cls, stringWithUTF8String: c.as_ptr()]
    }

    unsafe {
        // Reject off-main-thread callers: the WebKit objects below are not
        // thread-safe and touching them off-main can crash the app.
        let is_main: bool = msg_send![class!(NSThread), isMainThread];
        if !is_main {
            eprintln!("[grove:cookies] set_cookies called off the main thread; skipping");
            return 0;
        }

        let store: *mut AnyObject = msg_send![class!(WKWebsiteDataStore), defaultDataStore];
        if store.is_null() {
            eprintln!("[grove:cookies] defaultDataStore returned nil");
            return 0;
        }
        let cookie_store: *mut AnyObject = msg_send![store, httpCookieStore];
        if cookie_store.is_null() {
            eprintln!("[grove:cookies] httpCookieStore returned nil");
            return 0;
        }

        let mut count = 0usize;
        for cookie in cookies {
            // NSHTTPCookie property keys are compared by string value, so
            // constructing NSStrings of the documented key names works without
            // linking the NSHTTPCookieProperty* constant symbols.
            let dict: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
            if dict.is_null() {
                continue;
            }

            let set = |key: &str, value: *mut AnyObject| {
                if !value.is_null() {
                    let k = ns_string(key);
                    let _: () = msg_send![dict, setObject: value, forKey: k];
                }
            };

            set("Name", ns_string(&cookie.name));
            set("Value", ns_string(&cookie.value));
            set("Domain", ns_string(&cookie.host));
            let path = if cookie.path.is_empty() { "/" } else { &cookie.path };
            set("Path", ns_string(path));
            set("Version", ns_string("0"));

            if cookie.secure {
                set("Secure", ns_string("TRUE"));
            }

            if let Some(unix) = cookie.expires_utc {
                let date: *mut AnyObject =
                    msg_send![class!(NSDate), dateWithTimeIntervalSince1970: unix as f64];
                set("Expires", date);
            }

            // NSHTTPCookie has no stable property-dict key for httpOnly or
            // sameSite across macOS versions; name/value/domain/path/secure/
            // expires are enough to establish a logged-in session, so skip them.

            let cookie_obj: *mut AnyObject =
                msg_send![class!(NSHTTPCookie), cookieWithProperties: dict];
            if cookie_obj.is_null() {
                continue;
            }

            let _: () = msg_send![
                cookie_store,
                setCookie: cookie_obj,
                completionHandler: ptr::null::<AnyObject>()
            ];
            count += 1;
        }
        count
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_cookies(_cookies: &[ImportedCookie]) -> usize {
    0
}
