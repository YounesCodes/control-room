//! Install files in ~/Library/Fonts and make them available to this process immediately.
use super::{FontRegistration, Path};
use std::{ffi::c_void, os::unix::ffi::OsStrExt, ptr};

type CFRef = *const c_void;
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: CFRef,
        bytes: *const u8,
        length: isize,
        is_directory: u8,
    ) -> CFRef;
    fn CFRelease(value: CFRef);
    fn CFErrorGetCode(error: CFRef) -> isize;
}
#[link(name = "CoreText", kind = "framework")]
unsafe extern "C" {
    fn CTFontManagerRegisterFontsForURL(url: CFRef, scope: u32, error: *mut CFRef) -> u8;
    fn CTFontManagerUnregisterFontsForURL(url: CFRef, scope: u32, error: *mut CFRef) -> u8;
}

struct FontUrl(CFRef);
impl FontUrl {
    fn new(path: &Path) -> Result<Self, String> {
        let bytes = path.as_os_str().as_bytes();
        // Core Foundation copies these bytes; the owned URL is released below.
        let url = unsafe {
            CFURLCreateFromFileSystemRepresentation(
                ptr::null(),
                bytes.as_ptr(),
                bytes.len() as isize,
                0,
            )
        };
        if url.is_null() {
            Err("Could not resolve the font file URL.".into())
        } else {
            Ok(Self(url))
        }
    }
}
impl Drop for FontUrl {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

pub struct UserFonts;
impl FontRegistration for UserFonts {
    fn register(&self, path: &Path, _key: &str) -> Result<bool, String> {
        let url = FontUrl::new(path)?;
        let mut error = ptr::null();
        // Process scope gives the current WKWebView immediate access. The file
        // in Library/Fonts provides persistent, account-wide installation.
        let registered = unsafe { CTFontManagerRegisterFontsForURL(url.0, 1, &mut error) } != 0;
        let code = if error.is_null() {
            0
        } else {
            let code = unsafe { CFErrorGetCode(error) };
            unsafe { CFRelease(error) };
            code
        };
        if registered {
            Ok(true)
        } else if code == 105 {
            Ok(false)
        } else {
            Err(format!(
                "macOS could not load this font, Core Text error {code}. Remove a conflicting font in Font Book and retry."
            ))
        }
    }
    fn unregister(&self, path: &Path, _key: &str) {
        if let Ok(url) = FontUrl::new(path) {
            unsafe {
                CTFontManagerUnregisterFontsForURL(url.0, 1, ptr::null_mut());
            }
        }
    }
}
