#[cfg(windows)]
const DOCUMENTATION_URL: &str = "https://younescodes.github.io/control-room/";

/// Open only the published documentation. Callers cannot supply URLs or paths.
#[tauri::command]
pub fn open_documentation() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

        let url: Vec<u16> = DOCUMENTATION_URL.encode_utf16().chain(Some(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        // SAFETY: Both strings are NUL-terminated and live through the call.
        // The fixed HTTPS URL is opened without parameters or a working directory.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        browser_launch_result(result as isize)
    }
    #[cfg(not(windows))]
    Err("Opening documentation is supported on Windows.".into())
}

#[cfg(any(windows, test))]
fn browser_launch_result(code: isize) -> Result<(), String> {
    if code > 32 {
        Ok(())
    } else {
        let recovery = match code {
            5 => {
                "Windows denied access. Check your browser permissions or contact your administrator."
            }
            27 | 31 => "Set a default web browser in Windows Settings and try again.",
            _ => "Check your default browser and try again.",
        };
        Err(format!(
            "Windows could not launch your default browser (error {code}). {recovery}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_windows_browser_launch_failures() {
        // ShellExecute returns error codes through 32, including missing associations.
        for code in [0, 2, 5, 31, 32] {
            let error = browser_launch_result(code).unwrap_err();
            assert!(error.contains(&format!("error {code}")));
            assert!(error.contains("default browser"));
        }
        assert!(
            browser_launch_result(5)
                .unwrap_err()
                .contains("denied access")
        );
        assert!(
            browser_launch_result(31)
                .unwrap_err()
                .contains("Set a default web browser")
        );
        assert!(browser_launch_result(33).is_ok());
        assert!(browser_launch_result(1024).is_ok());
    }
}
