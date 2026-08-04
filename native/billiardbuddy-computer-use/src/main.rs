//! BilliardBuddy's local Computer Use MCP process.
//!
//! The platform adapter is intentionally isolated from MCP transport so the
//! package can retain the native plugin lifecycle across macOS/Windows.

use std::{
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
    process::Command,
};

const SERVER_NAME: &str = "billiardbuddy-computer-use";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_message(&line) {
            // A broken stdout pipe means the Core has stopped this plugin. Do
            // not keep a helper process alive after its parent disconnects.
            // stdio MCP transports one complete JSON-RPC message per line.
            // Tool manifests are formatted as multiline Rust literals for
            // readability, so compact structural newlines before writing.
            let response = response.replace('\n', "").replace('\r', "");
            if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}

fn handle_message(message: &str) -> Option<String> {
    let id = json_member_value(message, "id");
    let method = json_string_member(message, "method");
    let Some(method) = method else {
        return Some(error_response(
            id.as_deref().unwrap_or("null"),
            -32600,
            "invalid JSON-RPC request",
        ));
    };

    let response = match method.as_str() {
        "initialize" => success_response(
            id.as_deref().unwrap_or("null"),
            &format!(
                r#"{{"protocolVersion":"2025-06-18","capabilities":{{"tools":{{"listChanged":false}}}},"serverInfo":{{"name":"{SERVER_NAME}","version":"{SERVER_VERSION}"}}}}"#,
            ),
        ),
        "ping" => success_response(id.as_deref().unwrap_or("null"), "{}"),
        "tools/list" => success_response(id.as_deref().unwrap_or("null"), tools_list()),
        "tools/call" => tool_call_response(id.as_deref().unwrap_or("null"), message),
        // JSON-RPC notifications intentionally have no response. The Core
        // sends this immediately after initialize.
        "notifications/initialized" if id.is_none() => return None,
        _ => error_response(
            id.as_deref().unwrap_or("null"),
            -32601,
            "Computer Use does not support this request",
        ),
    };
    Some(response)
}

fn tools_list() -> &'static str {
    r#"{"tools":[
      {"name":"status","description":"Check Computer Use system-permission readiness without requesting or changing permissions.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
      {"name":"list_allowed_apps","description":"List only desktop apps the user has already allowed for Computer Use.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
      {"name":"list_windows","description":"List visible windows for one already allowed app.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"}},"required":["appId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
      {"name":"capture_window","description":"Capture a current image of one foreground window from an already allowed app.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1}},"required":["appId","windowId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
      {"name":"inspect_accessibility_tree","description":"Read a fresh, bounded accessibility snapshot for one current allowed foreground window. Every snapshot creates fresh elementIndex values; refresh it before using element actions. Secure field values are redacted.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"maxNodes":{"type":"integer","minimum":1,"maximum":500}},"required":["appId","windowId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
      {"name":"inspect_focused_element","description":"Read the role and label of the focused element in one already allowed foreground app. Secure text values are never returned.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1}},"required":["appId","windowId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
      {"name":"activate_app","description":"Launch or activate one already allowed app.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"}},"required":["appId"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"click_element","description":"Press one element from a fresh accessibility snapshot. elementFingerprint binds the approved index to the same native AX/UIA identity and rejects stale targets.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"elementIndex":{"type":"integer","minimum":0},"elementFingerprint":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["appId","windowId","elementIndex","elementFingerprint"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"click","description":"Click a screen coordinate inside one current, allowed foreground window.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"x":{"type":"number"},"y":{"type":"number"}},"required":["appId","windowId","x","y"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"drag","description":"Drag between two coordinates inside one current allowed foreground window. Obtain fresh bounds from the accessibility snapshot first.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"fromX":{"type":"number"},"fromY":{"type":"number"},"toX":{"type":"number"},"toY":{"type":"number"}},"required":["appId","windowId","fromX","fromY","toX","toY"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"set_value","description":"Set the value of one fingerprint-bound editable element from a fresh accessibility snapshot. Secure password fields are always refused.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"elementIndex":{"type":"integer","minimum":0},"elementFingerprint":{"type":"string","pattern":"^[a-f0-9]{64}$"},"value":{"type":"string","maxLength":4096}},"required":["appId","windowId","elementIndex","elementFingerprint","value"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"select_text","description":"Select matching text in one fingerprint-bound editable element from a fresh accessibility snapshot. Optional prefix/suffix disambiguate repeated text.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"elementIndex":{"type":"integer","minimum":0},"elementFingerprint":{"type":"string","pattern":"^[a-f0-9]{64}$"},"text":{"type":"string","minLength":1,"maxLength":4096},"prefix":{"type":"string","maxLength":4096},"suffix":{"type":"string","maxLength":4096},"selectionType":{"type":"string","enum":["text","cursor_before","cursor_after"]}},"required":["appId","windowId","elementIndex","elementFingerprint","text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"perform_secondary_action","description":"Perform one named non-primary accessibility action exposed by a fingerprint-bound element in a fresh snapshot. Do not guess action names.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"elementIndex":{"type":"integer","minimum":0},"elementFingerprint":{"type":"string","pattern":"^[a-f0-9]{64}$"},"action":{"type":"string","maxLength":256}},"required":["appId","windowId","elementIndex","elementFingerprint","action"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"type_text","description":"Type text into one current, allowed foreground window. Never use this for passwords, payment, or authentication fields.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"text":{"type":"string","maxLength":4096}},"required":["appId","windowId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"press_key","description":"Press one named key in one current, allowed foreground window.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"key":{"type":"string"}},"required":["appId","windowId","key"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"scroll","description":"Scroll inside one current, allowed foreground window.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"deltaX":{"type":"number"},"deltaY":{"type":"number"}},"required":["appId","windowId","deltaX","deltaY"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"scroll_element","description":"Scroll one fingerprint-bound element from a fresh accessibility snapshot. Uses the element's native scrolling action when exposed, otherwise a bounded wheel event at that element.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"windowId":{"type":"integer","minimum":1},"elementIndex":{"type":"integer","minimum":0},"elementFingerprint":{"type":"string","pattern":"^[a-f0-9]{64}$"},"direction":{"type":"string","enum":["up","down","left","right"]},"pages":{"type":"integer","minimum":1,"maximum":10}},"required":["appId","windowId","elementIndex","elementFingerprint","direction"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
      {"name":"wait_for_window","description":"Wait briefly for a visible window in one already allowed app.","inputSchema":{"type":"object","properties":{"appId":{"type":"string"},"timeoutMs":{"type":"integer","minimum":100,"maximum":10000}},"required":["appId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}}
    ]}"#
}

fn tool_call_response(id: &str, message: &str) -> String {
    let params = json_member_value(message, "params").unwrap_or_else(|| "{}".to_owned());
    let Some(name) = json_string_member(&params, "name") else {
        return error_response(id, -32602, "tools/call requires a tool name");
    };
    let arguments = json_member_value(&params, "arguments").unwrap_or_else(|| "{}".to_owned());
    let result = match name.as_str() {
        "status" => native_call(&["status"]).map(|text| tool_result(&text)),
        "list_allowed_apps" => native_call(&["list-allowed-apps"]).map(|text| tool_result(&text)),
        "list_windows" => with_app_id(&arguments, |bundle_id| {
            native_call(&["list-windows", bundle_id]).map(|text| tool_result(&text))
        }),
        "capture_window" => with_window_target(&arguments, |bundle_id, window_id| {
            native_call(&["capture-window", bundle_id, &window_id.to_string()])
                .and_then(|base64| image_result(&base64))
        }),
        "inspect_accessibility_tree" => with_window_target(&arguments, |bundle_id, window_id| {
            let max_nodes = optional_integer(&arguments, "maxNodes")
                .unwrap_or(250)
                .clamp(1, 500);
            native_call(&[
                "accessibility-tree",
                bundle_id,
                &window_id.to_string(),
                &max_nodes.to_string(),
            ])
            .map(|text| tool_result(&text))
        }),
        "inspect_focused_element" => with_window_target(&arguments, |bundle_id, window_id| {
            native_call(&["inspect-focused-element", bundle_id, &window_id.to_string()])
                .map(|text| tool_result(&text))
        }),
        "activate_app" => with_app_id(&arguments, |bundle_id| {
            native_call(&["activate-app", bundle_id]).map(|text| tool_result(&text))
        }),
        "click_element" => with_element_target(
            &arguments,
            |bundle_id, window_id, element_index, fingerprint| {
                native_call(&[
                    "click-element",
                    bundle_id,
                    &window_id.to_string(),
                    &element_index.to_string(),
                    fingerprint,
                ])
                .map(|text| tool_result(&text))
            },
        ),
        "click" => with_window_target(&arguments, |bundle_id, window_id| {
            let x = required_number(&arguments, "x")?;
            let y = required_number(&arguments, "y")?;
            native_call(&[
                "click",
                bundle_id,
                &window_id.to_string(),
                &x.to_string(),
                &y.to_string(),
            ])
            .map(|text| tool_result(&text))
        }),
        "drag" => with_window_target(&arguments, |bundle_id, window_id| {
            let from_x = required_number(&arguments, "fromX")?;
            let from_y = required_number(&arguments, "fromY")?;
            let to_x = required_number(&arguments, "toX")?;
            let to_y = required_number(&arguments, "toY")?;
            native_call(&[
                "drag",
                bundle_id,
                &window_id.to_string(),
                &from_x.to_string(),
                &from_y.to_string(),
                &to_x.to_string(),
                &to_y.to_string(),
            ])
            .map(|text| tool_result(&text))
        }),
        "set_value" => with_element_target(
            &arguments,
            |bundle_id, window_id, element_index, fingerprint| {
                let value = limited_string(&arguments, "value", 4096)?;
                native_call(&[
                    "set-value",
                    bundle_id,
                    &window_id.to_string(),
                    &element_index.to_string(),
                    fingerprint,
                    &value,
                ])
                .map(|text| tool_result(&text))
            },
        ),
        "select_text" => with_element_target(
            &arguments,
            |bundle_id, window_id, element_index, fingerprint| {
                let text = limited_string(&arguments, "text", 4096)?;
                if text.is_empty() {
                    return Err("text must not be empty".to_owned());
                }
                let prefix = optional_limited_string(&arguments, "prefix", 4096)?;
                let suffix = optional_limited_string(&arguments, "suffix", 4096)?;
                let selection_type = optional_limited_string(&arguments, "selectionType", 32)?
                    .unwrap_or_else(|| "text".to_owned());
                if !matches!(
                    selection_type.as_str(),
                    "text" | "cursor_before" | "cursor_after"
                ) {
                    return Err(
                        "selectionType must be text, cursor_before, or cursor_after".to_owned()
                    );
                }
                native_call(&[
                    "select-text",
                    bundle_id,
                    &window_id.to_string(),
                    &element_index.to_string(),
                    fingerprint,
                    &text,
                    &prefix.unwrap_or_default(),
                    &suffix.unwrap_or_default(),
                    &selection_type,
                ])
                .map(|text| tool_result(&text))
            },
        ),
        "perform_secondary_action" => with_element_target(
            &arguments,
            |bundle_id, window_id, element_index, fingerprint| {
                let action = limited_string(&arguments, "action", 256)?;
                native_call(&[
                    "secondary-action",
                    bundle_id,
                    &window_id.to_string(),
                    &element_index.to_string(),
                    fingerprint,
                    &action,
                ])
                .map(|text| tool_result(&text))
            },
        ),
        "type_text" => with_window_target(&arguments, |bundle_id, window_id| {
            let text = required_string(&arguments, "text")?;
            if text.chars().count() > 4096 {
                return Err("type_text text is limited to 4096 characters".to_owned());
            }
            native_call(&["type-text", bundle_id, &window_id.to_string(), &text])
                .map(|text| tool_result(&text))
        }),
        "press_key" => with_window_target(&arguments, |bundle_id, window_id| {
            let key = required_string(&arguments, "key")?;
            native_call(&["press-key", bundle_id, &window_id.to_string(), &key])
                .map(|text| tool_result(&text))
        }),
        "scroll" => with_window_target(&arguments, |bundle_id, window_id| {
            let delta_x = required_number(&arguments, "deltaX")?;
            let delta_y = required_number(&arguments, "deltaY")?;
            native_call(&[
                "scroll",
                bundle_id,
                &window_id.to_string(),
                &delta_x.to_string(),
                &delta_y.to_string(),
            ])
            .map(|text| tool_result(&text))
        }),
        "scroll_element" => with_element_target(
            &arguments,
            |bundle_id, window_id, element_index, fingerprint| {
                let direction = limited_string(&arguments, "direction", 16)?;
                if !matches!(direction.as_str(), "up" | "down" | "left" | "right") {
                    return Err("direction must be up, down, left, or right".to_owned());
                }
                let pages = optional_integer(&arguments, "pages")
                    .unwrap_or(1)
                    .clamp(1, 10);
                native_call(&[
                    "scroll-element",
                    bundle_id,
                    &window_id.to_string(),
                    &element_index.to_string(),
                    fingerprint,
                    &direction,
                    &pages.to_string(),
                ])
                .map(|text| tool_result(&text))
            },
        ),
        "wait_for_window" => with_app_id(&arguments, |bundle_id| {
            let timeout_ms = optional_integer(&arguments, "timeoutMs")
                .unwrap_or(3_000)
                .clamp(100, 10_000);
            native_call(&["wait-for-window", bundle_id, &timeout_ms.to_string()])
                .map(|text| tool_result(&text))
        }),
        _ => return error_response(id, -32602, "unknown BilliardBuddy Computer Use tool"),
    };

    match result {
        Ok(payload) => success_response(id, &payload),
        Err(message) => success_response(id, &tool_error_result(&message)),
    }
}

fn with_app_id<T>(
    arguments: &str,
    action: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    let bundle_id = required_string(arguments, "appId")?;
    validate_app_id(&bundle_id)?;
    action(&bundle_id)
}

fn with_window_target<T>(
    arguments: &str,
    action: impl FnOnce(&str, u64) -> Result<T, String>,
) -> Result<T, String> {
    with_app_id(arguments, |bundle_id| {
        let window_id = required_integer(arguments, "windowId")?;
        if window_id <= 0 {
            return Err("windowId must be greater than zero".to_owned());
        }
        action(bundle_id, window_id as u64)
    })
}

fn with_element_target<T>(
    arguments: &str,
    action: impl FnOnce(&str, u64, i64, &str) -> Result<T, String>,
) -> Result<T, String> {
    with_window_target(arguments, |bundle_id, window_id| {
        let element_index = required_integer(arguments, "elementIndex")?;
        if !(0..=499).contains(&element_index) {
            return Err(
                "elementIndex must refer to an element in a fresh, bounded accessibility snapshot"
                    .to_owned(),
            );
        }
        let fingerprint = required_string(arguments, "elementFingerprint")?;
        if fingerprint.len() != 64
            || !fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(
                "elementFingerprint must come from a fresh accessibility snapshot".to_owned(),
            );
        }
        action(bundle_id, window_id, element_index, &fingerprint)
    })
}

fn validate_app_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4_096 || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("appId must be a concrete allowed application identifier".to_owned());
    }
    Ok(())
}

fn required_string(arguments: &str, key: &str) -> Result<String, String> {
    json_string_member(arguments, key).ok_or_else(|| format!("{key} must be a string"))
}

fn limited_string(arguments: &str, key: &str, max_characters: usize) -> Result<String, String> {
    let value = required_string(arguments, key)?;
    if value.chars().count() > max_characters {
        return Err(format!("{key} is limited to {max_characters} characters"));
    }
    Ok(value)
}

fn optional_limited_string(
    arguments: &str,
    key: &str,
    max_characters: usize,
) -> Result<Option<String>, String> {
    let Some(value) = json_string_member(arguments, key) else {
        return Ok(None);
    };
    if value.chars().count() > max_characters {
        return Err(format!("{key} is limited to {max_characters} characters"));
    }
    Ok(Some(value))
}

fn required_integer(arguments: &str, key: &str) -> Result<i64, String> {
    optional_integer(arguments, key).ok_or_else(|| format!("{key} must be an integer"))
}

fn optional_integer(arguments: &str, key: &str) -> Option<i64> {
    json_member_value(arguments, key)?
        .trim()
        .parse::<i64>()
        .ok()
}

fn required_number(arguments: &str, key: &str) -> Result<f64, String> {
    let value = json_member_value(arguments, key)
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("{key} must be a finite number"))?;
    if value.abs() > 100_000.0 {
        return Err(format!(
            "{key} is outside the safe desktop coordinate range"
        ));
    }
    Ok(value)
}

fn native_call(arguments: &[&str]) -> Result<String, String> {
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Err(format!(
            "Computer Use is unavailable on {}",
            platform_name()
        ));
    }
    let executable = native_service_path()?;
    let mut command = Command::new(&executable);
    command
        .args(arguments)
        .env_remove("DYLD_INSERT_LIBRARIES")
        // Appshots are an Electron-host-only, per-call capability. An MCP
        // plugin process must never inherit it or call the private command.
        .env_remove("BILLIARDBUDDY_APPSHOT_CAPABILITY");
    remove_sensitive_environment(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("unable to start the local Computer Use service: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("local Computer Use service failed with {}", output.status)
        } else {
            detail
        });
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "local Computer Use service returned non-text output".to_owned())?;
    let stdout = stdout.trim();
    if stdout.is_empty() {
        return Err("local Computer Use service returned no result".to_owned());
    }
    Ok(stdout.to_owned())
}

fn remove_sensitive_environment(command: &mut Command) {
    for (name, _) in env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"]
            .iter()
            .any(|marker| upper.contains(marker))
        {
            command.env_remove(name);
        }
    }
}

fn native_service_path() -> Result<PathBuf, String> {
    let current = env::current_exe()
        .map_err(|error| format!("cannot locate Computer Use plugin: {error}"))?;
    let directory = current
        .parent()
        .ok_or_else(|| "Computer Use plugin has no executable directory".to_owned())?;
    let service = if cfg!(target_os = "macos") {
        directory
            .join("BilliardBuddy Computer Use.app")
            .join("Contents")
            .join("MacOS")
            .join("BilliardBuddyComputerUseService")
    } else if cfg!(target_os = "windows") {
        directory.join("BilliardBuddyComputerUseService.exe")
    } else {
        return Err(format!(
            "Computer Use is not available on {}",
            platform_name()
        ));
    };
    if service.is_file() {
        Ok(service)
    } else {
        Err("BilliardBuddy Computer Use is incomplete. Reinstall BilliardBuddy".to_owned())
    }
}

fn image_result(base64: &str) -> Result<String, String> {
    if base64.len() > 16 * 1024 * 1024
        || base64.is_empty()
        || !base64
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("local Computer Use service returned an invalid screenshot".to_owned());
    }
    Ok(format!(
        r#"{{"content":[{{"type":"image","data":"{base64}","mimeType":"image/png"}}],"isError":false}}"#,
    ))
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else {
        "this unsupported platform"
    }
}

fn tool_result(text: &str) -> String {
    format!(
        r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":false}}"#,
        json_escape(text),
    )
}

fn tool_error_result(text: &str) -> String {
    format!(
        r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":true}}"#,
        json_escape(text),
    )
}

fn success_response(id: &str, result: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)
}

fn error_response(id: &str, code: i32, message: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":"{}"}}}}"#,
        json_escape(message),
    )
}

/// Return a top-level JSON-RPC member as raw JSON. This is intentionally small
/// because the transport has no dependencies and only accepts the scalar `id` member.
/// The Core controls the stdio peer; unsupported shapes fail closed instead of
/// being interpreted as a tool call.
fn json_member_value(input: &str, key: &str) -> Option<String> {
    let mut remainder = input.trim().strip_prefix('{')?;
    loop {
        remainder = remainder.trim_start();
        if remainder.starts_with('}') {
            return None;
        }
        if let Some(after_comma) = remainder.strip_prefix(',') {
            remainder = after_comma.trim_start();
        }
        let key_end = raw_json_value_end(remainder)?;
        let member_key = remainder[..key_end]
            .strip_prefix('"')?
            .strip_suffix('"')
            .and_then(json_unescape)?;
        remainder = remainder[key_end..]
            .trim_start()
            .strip_prefix(':')?
            .trim_start();
        let value_end = raw_json_value_end(remainder)?;
        if member_key == key {
            return Some(remainder[..value_end].trim().to_owned());
        }
        remainder = &remainder[value_end..];
    }
}

fn json_string_member(input: &str, key: &str) -> Option<String> {
    let value = json_member_value(input, key)?;
    let value = value.trim();
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    json_unescape(inner)
}

fn raw_json_value_end(value: &str) -> Option<usize> {
    let first = value.as_bytes().first().copied()?;
    if first == b'"' {
        let mut escaped = false;
        for (index, byte) in value.as_bytes().iter().enumerate().skip(1) {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                return Some(index + 1);
            }
        }
        return None;
    }
    let mut depth = 0_i32;
    let mut quoted = false;
    let mut escaped = false;
    for (index, byte) in value.as_bytes().iter().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match *byte {
            b'"' => quoted = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' if depth > 0 => depth -= 1,
            b',' | b'}' if depth == 0 => return Some(index),
            _ => {}
        }
    }
    Some(value.len())
}

fn json_unescape(value: &str) -> Option<String> {
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        match characters.next()? {
            '"' => output.push('"'),
            '\\' => output.push('\\'),
            '/' => output.push('/'),
            'b' => output.push('\u{0008}'),
            'f' => output.push('\u{000c}'),
            'n' => output.push('\n'),
            'r' => output.push('\r'),
            't' => output.push('\t'),
            'u' => {
                let mut codepoint = String::with_capacity(4);
                for _ in 0..4 {
                    codepoint.push(characters.next()?);
                }
                let value = u32::from_str_radix(&codepoint, 16).ok()?;
                output.push(char::from_u32(value)?);
            }
            _ => return None,
        }
    }
    Some(output)
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str(r#"\""#),
            '\\' => escaped.push_str(r#"\\"#),
            '\n' => escaped.push_str(r#"\n"#),
            '\r' => escaped.push_str(r#"\r"#),
            '\t' => escaped.push_str(r#"\t"#),
            control if control.is_control() => {
                use std::fmt::Write;
                let _ = write!(escaped, r#"\u{:04x}"#, control as u32);
            }
            other => escaped.push(other),
        }
    }
    escaped
}

#[cfg(test)]
mod parser_tests {
    use super::*;

    #[test]
    fn top_level_member_ignores_field_like_text() {
        let input = r#"{"text":"contains \"windowId\":999","windowId":42}"#;
        assert_eq!(json_member_value(input, "windowId").as_deref(), Some("42"));
    }

    #[test]
    fn tools_call_reads_name_only_from_nested_params() {
        let request = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"status","arguments":{"text":"contains \"name\":\"wrong\""}}}"#;
        let response = handle_message(request).expect("request must receive a response");
        assert!(!response.contains("tools/call requires a tool name"));
        assert!(response.contains(r#""id":7"#));
    }

    #[test]
    fn mutating_computer_tools_explicitly_require_core_approval() {
        for name in [
            "activate_app",
            "click_element",
            "click",
            "drag",
            "set_value",
            "select_text",
            "perform_secondary_action",
            "type_text",
            "press_key",
            "scroll",
            "scroll_element",
        ] {
            let needle = format!(r#""name":"{name}""#);
            let tool = tools_list()
                .lines()
                .find(|line| line.contains(&needle))
                .expect("mutating Computer Use tool must be declared");
            assert!(tool.contains(r#""readOnlyHint":false"#), "{name}");
            assert!(tool.contains(r#""destructiveHint":true"#), "{name}");
        }

        let wait = tools_list()
            .lines()
            .find(|line| line.contains(r#""name":"wait_for_window""#))
            .expect("wait_for_window must be declared");
        assert!(wait.contains(r#""readOnlyHint":true"#));
    }
}
