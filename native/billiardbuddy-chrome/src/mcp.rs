//! BilliardBuddy Chrome's stdio MCP process.
//!
//! This process does not open Chrome, read a profile, or keep a browser
//! connection. It reads the short-lived loopback endpoint published by the
//! BilliardBuddy Chrome native-messaging host and asks that host to relay one
//! constrained request to the Chrome extension.

use std::{
    env, fs,
    io::{self, BufRead, BufReader, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    time::Duration,
};

const SERVER_NAME: &str = "billiardbuddy-chrome";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_SCREENSHOT_DATA: usize = 16 * 1024 * 1024;
const MAX_BRIDGE_RESPONSE: usize = MAX_SCREENSHOT_DATA + 1024 * 1024;

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_message(&line) {
            let response = response.replace('\n', "").replace('\r', "");
            if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}

fn handle_message(message: &str) -> Option<String> {
    let id = json_member_value(message, "id");
    let Some(method) = json_string_member(message, "method") else {
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
                r#"{{"protocolVersion":"2025-06-18","capabilities":{{"tools":{{"listChanged":false}}}},"serverInfo":{{"name":"{SERVER_NAME}","version":"{SERVER_VERSION}"}}}}"#
            ),
        ),
        "ping" => success_response(id.as_deref().unwrap_or("null"), "{}"),
        "tools/list" => success_response(id.as_deref().unwrap_or("null"), tools_list()),
        "tools/call" => tool_call_response(id.as_deref().unwrap_or("null"), message),
        "notifications/initialized" if id.is_none() => return None,
        _ => error_response(
            id.as_deref().unwrap_or("null"),
            -32601,
            "BilliardBuddy Chrome does not support this request",
        ),
    };
    Some(response)
}

fn tools_list() -> &'static str {
    r#"{"tools":[
      {"name":"status","description":"Check whether the user has connected the BilliardBuddy Chrome extension and view its domain policy.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
      {"name":"list_tabs","description":"List only Chrome tabs that the user explicitly connected and whose domains are allowed.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
      {"name":"inspect_page","description":"Read a bounded, structured snapshot of one connected Chrome tab and return current element IDs for safe follow-up actions.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
      {"name":"capture_page","description":"Capture the visible content of one connected Chrome tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
      {"name":"developer_snapshot","description":"Read a bounded Console, Network and Performance summary for one connected Chrome tab. The extension omits headers, cookies, storage, bodies and arbitrary CDP access, removes URL credentials, query strings, fragments and sensitive path identifiers, and applies best-effort redaction to console text.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
      {"name":"cdp_send","description":"Run one read-only, allowlisted developer inspection in a user-connected Chrome tab. Only DOM.getDocument, Page.getLayoutMetrics, and Performance.getMetrics are accepted. The extension projects and redacts every result; it never accepts arbitrary JavaScript, CDP parameters, cookies, storage, headers, credentials, response bodies or mutation commands.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"method":{"type":"string","enum":["DOM.getDocument","Page.getLayoutMetrics","Performance.getMetrics"]}},"required":["tabId","method"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
      {"name":"cdp_read_events","description":"Read bounded redacted Console, Network and navigation events after a cursor from one connected Chrome tab. No raw CDP event payload, headers, cookies, storage, request/response body or credential is exposed.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"afterSequence":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
      {"name":"wait_for_page","description":"Wait, for at most 10 seconds, until a connected Chrome tab reaches a complete document state or a visible text fragment appears. The fragment is never returned and cannot inspect form values, cookies, storage or hidden state.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"text":{"type":"string","minLength":1,"maxLength":256},"timeoutMs":{"type":"integer","minimum":1,"maximum":10000}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
      {"name":"navigate","description":"Navigate one connected Chrome tab to a URL whose host is already allowed by the user.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"url":{"type":"string","maxLength":4096}},"required":["tabId","url"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}},
      {"name":"click_element","description":"Click a current element ID returned by inspect_page. Ask the user before an external side effect.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"elementId":{"type":"string","pattern":"^bb-[1-9][0-9]*-[1-9][0-9]*$"}},"required":["tabId","elementId"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}},
      {"name":"type_text","description":"Type text into a current non-password element ID returned by inspect_page. Never use for passwords or authentication codes.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"elementId":{"type":"string","pattern":"^bb-[1-9][0-9]*-[1-9][0-9]*$"},"text":{"type":"string","minLength":1,"maxLength":4096}},"required":["tabId","elementId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}},
      {"name":"press_key","description":"Press Enter, Tab, Escape, or one arrow key in a connected tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"key":{"type":"string","enum":["Enter","Tab","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"]}},"required":["tabId","key"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}}
    ]}"#
}

fn tool_call_response(id: &str, message: &str) -> String {
    let params = json_member_value(message, "params").unwrap_or_else(|| "{}".to_owned());
    let Some(name) = json_string_member(&params, "name") else {
        return error_response(id, -32602, "tools/call requires a tool name");
    };
    let arguments = json_member_value(&params, "arguments").unwrap_or_else(|| "{}".to_owned());
    let result = match name.as_str() {
        "status" | "list_tabs" => bridge_call(&name, "{}"),
        "inspect_page" | "capture_page" | "developer_snapshot" => {
            with_tab_id(&arguments, |tab_id| {
                bridge_call(&name, &format!(r#"{{"tabId":{tab_id}}}"#))
            })
        }
        "cdp_send" => with_tab_id(&arguments, |tab_id| {
            let method = required_string(&arguments, "method")?;
            if !matches!(
                method.as_str(),
                "DOM.getDocument" | "Page.getLayoutMetrics" | "Performance.getMetrics"
            ) {
                return Err("unsupported Chrome developer method".to_owned());
            }
            bridge_call(
                &name,
                &format!(r#"{{"tabId":{tab_id},"method":"{method}"}}"#),
            )
        }),
        "cdp_read_events" => with_tab_id(&arguments, |tab_id| {
            let after_sequence =
                optional_non_negative_integer(&arguments, "afterSequence")?.unwrap_or(0);
            let limit = optional_non_negative_integer(&arguments, "limit")?.unwrap_or(50);
            if !(1..=100).contains(&limit) {
                return Err("limit must be an integer from 1 to 100".to_owned());
            }
            bridge_call(
                &name,
                &format!(
                    r#"{{"tabId":{tab_id},"afterSequence":{after_sequence},"limit":{limit}}}"#
                ),
            )
        }),
        "wait_for_page" => with_tab_id(&arguments, |tab_id| {
            let text = json_string_member(&arguments, "text");
            if text
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.chars().count() > 256)
            {
                return Err("text must contain 1-256 characters when supplied".to_owned());
            }
            let timeout_ms =
                optional_non_negative_integer(&arguments, "timeoutMs")?.unwrap_or(5_000);
            if !(1..=10_000).contains(&timeout_ms) {
                return Err("timeoutMs must be an integer from 1 to 10000".to_owned());
            }
            let text_field = text
                .map(|value| format!(",\"text\":\"{}\"", json_escape(&value)))
                .unwrap_or_default();
            bridge_call(
                &name,
                &format!(r#"{{"tabId":{tab_id},"timeoutMs":{timeout_ms}{text_field}}}"#),
            )
        }),
        "navigate" => with_tab_id(&arguments, |tab_id| {
            let url = required_string(&arguments, "url")?;
            if !valid_http_url(&url) {
                return Err(
                    "url must be an http or https URL no longer than 4096 characters".to_owned(),
                );
            }
            bridge_call(
                &name,
                &format!(r#"{{"tabId":{tab_id},"url":"{}"}}"#, json_escape(&url)),
            )
        }),
        "click_element" => with_tab_id(&arguments, |tab_id| {
            let element_id = element_id(&arguments)?;
            bridge_call(
                &name,
                &format!(r#"{{"tabId":{tab_id},"elementId":"{element_id}"}}"#),
            )
        }),
        "type_text" => with_tab_id(&arguments, |tab_id| {
            let element_id = element_id(&arguments)?;
            let text = required_string(&arguments, "text")?;
            if text.is_empty() || text.chars().count() > 4096 {
                return Err("text must contain 1-4096 characters".to_owned());
            }
            bridge_call(
                &name,
                &format!(
                    r#"{{"tabId":{tab_id},"elementId":"{element_id}","text":"{}"}}"#,
                    json_escape(&text)
                ),
            )
        }),
        "press_key" => with_tab_id(&arguments, |tab_id| {
            let key = required_string(&arguments, "key")?;
            if !matches!(
                key.as_str(),
                "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
            ) {
                return Err("unsupported Chrome key".to_owned());
            }
            bridge_call(&name, &format!(r#"{{"tabId":{tab_id},"key":"{key}"}}"#))
        }),
        _ => return error_response(id, -32602, "unknown BilliardBuddy Chrome tool"),
    };
    let payload = match result {
        Ok(payload) if name == "capture_page" => {
            image_payload(&payload).unwrap_or_else(|error| tool_error_result(&error))
        }
        Ok(payload) => tool_result(&payload),
        Err(error) => tool_error_result(&error),
    };
    success_response(id, &payload)
}

fn valid_http_url(value: &str) -> bool {
    if value.len() > 4096 {
        return false;
    }
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    matches!(scheme, "http" | "https") && !rest.is_empty()
}

fn with_tab_id<T>(
    arguments: &str,
    action: impl FnOnce(i64) -> Result<T, String>,
) -> Result<T, String> {
    let tab_id = required_integer(arguments, "tabId")?;
    if tab_id < 1 {
        return Err("tabId must be greater than zero".to_owned());
    }
    action(tab_id)
}

fn element_id(arguments: &str) -> Result<String, String> {
    let value = required_string(arguments, "elementId")?;
    let valid = value.strip_prefix("bb-").and_then(|suffix| {
        let (generation, sequence) = suffix.split_once('-')?;
        let positive_digits = |part: &str| {
            part.as_bytes().first().is_some_and(u8::is_ascii_digit)
                && part.as_bytes().first() != Some(&b'0')
                && part.bytes().all(|byte| byte.is_ascii_digit())
        };
        (positive_digits(generation) && positive_digits(sequence)).then_some(())
    });
    if valid.is_none() || value.len() > 48 {
        return Err("elementId must come from inspect_page".to_owned());
    }
    Ok(value)
}

fn bridge_call(operation: &str, arguments: &str) -> Result<String, String> {
    let state = bridge_state()?;
    let port = required_integer(&state, "port")?;
    if !(1..=65535).contains(&port) {
        return Err("BilliardBuddy Chrome host state has an invalid port".to_owned());
    }
    let token = required_string(&state, "token")?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("BilliardBuddy Chrome host state has an invalid token".to_owned());
    }
    let address = SocketAddr::from(([127, 0, 0, 1], port as u16));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "BilliardBuddy Chrome is not connected. Ask the user to connect an allowed tab from the Chrome extension.".to_owned())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(45)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    let request =
        format!(r#"{{"token":"{token}","operation":"{operation}","arguments":{arguments}}}"#);
    stream
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|_| "BilliardBuddy Chrome host disconnected".to_owned())?;
    stream
        .flush()
        .map_err(|_| "BilliardBuddy Chrome host disconnected".to_owned())?;
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|_| "BilliardBuddy Chrome host did not respond".to_owned())?;
    if response.len() > MAX_BRIDGE_RESPONSE {
        return Err("BilliardBuddy Chrome host returned an oversized response".to_owned());
    }
    if json_member_value(&response, "ok").as_deref() != Some("true") {
        return Err(json_string_member(&response, "error")
            .unwrap_or_else(|| "BilliardBuddy Chrome request failed".to_owned()));
    }
    json_member_value(&response, "payload")
        .ok_or_else(|| "BilliardBuddy Chrome host returned an invalid response".to_owned())
}

fn bridge_state() -> Result<String, String> {
    let home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "BilliardBuddy Chrome is not connected to the app".to_owned())?;
    fs::read_to_string(home.join("chrome-control").join("bridge.json"))
        .map_err(|_| "BilliardBuddy Chrome native host is not running. Open Chrome and connect a tab with the BilliardBuddy extension.".to_owned())
}

fn image_payload(payload: &str) -> Result<String, String> {
    let mime = json_string_member(payload, "mimeType").unwrap_or_default();
    let data = json_string_member(payload, "data")
        .ok_or_else(|| "Chrome returned no screenshot data".to_owned())?;
    if mime != "image/png"
        || data.is_empty()
        || data.len() > MAX_SCREENSHOT_DATA
        || !data
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("Chrome returned an invalid screenshot".to_owned());
    }
    Ok(format!(
        r#"{{"content":[{{"type":"image","data":"{data}","mimeType":"image/png"}}],"isError":false}}"#
    ))
}

fn tool_result(text: &str) -> String {
    format!(
        r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":false}}"#,
        json_escape(text)
    )
}
fn tool_error_result(text: &str) -> String {
    format!(
        r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":true}}"#,
        json_escape(text)
    )
}
fn success_response(id: &str, result: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)
}
fn error_response(id: &str, code: i32, message: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":"{}"}}}}"#,
        json_escape(message)
    )
}

fn required_string(input: &str, key: &str) -> Result<String, String> {
    json_string_member(input, key).ok_or_else(|| format!("{key} must be a string"))
}
fn required_integer(input: &str, key: &str) -> Result<i64, String> {
    json_member_value(input, key)
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(|| format!("{key} must be an integer"))
}
fn optional_non_negative_integer(input: &str, key: &str) -> Result<Option<i64>, String> {
    json_member_value(input, key)
        .map(|value| {
            value
                .trim()
                .parse::<i64>()
                .ok()
                .filter(|number| *number >= 0)
                .ok_or_else(|| format!("{key} must be a non-negative integer"))
        })
        .transpose()
}

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
    json_member_value(input, key).and_then(|value| {
        value
            .strip_prefix('"')?
            .strip_suffix('"')
            .and_then(json_unescape)
    })
}
fn raw_json_value_end(value: &str) -> Option<usize> {
    let first = *value.as_bytes().first()?;
    if first == b'"' {
        let mut escaped = false;
        for (index, byte) in value.bytes().enumerate().skip(1) {
            if escaped {
                escaped = false
            } else if byte == b'\\' {
                escaped = true
            } else if byte == b'"' {
                return Some(index + 1);
            }
        }
        return None;
    }
    let (mut depth, mut quoted, mut escaped) = (0_i32, false, false);
    for (index, byte) in value.bytes().enumerate() {
        if quoted {
            if escaped {
                escaped = false
            } else if byte == b'\\' {
                escaped = true
            } else if byte == b'"' {
                quoted = false
            };
            continue;
        }
        match byte {
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
                let codepoint: String = (0..4)
                    .map(|_| characters.next())
                    .collect::<Option<String>>()?;
                output.push(char::from_u32(u32::from_str_radix(&codepoint, 16).ok()?)?)
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
        let input = r#"{"text":"contains \"tabId\":999","tabId":42}"#;
        assert_eq!(json_member_value(input, "tabId").as_deref(), Some("42"));
    }

    #[test]
    fn tools_call_reads_name_only_from_nested_params() {
        let request = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"status","arguments":{"text":"contains \"name\":\"wrong\""}}}"#;
        let response = handle_message(request).expect("request must receive a response");
        assert!(!response.contains("tools/call requires a tool name"));
        assert!(response.contains(r#""id":7"#));
    }

    #[test]
    fn mutating_chrome_tools_explicitly_require_core_approval() {
        for name in ["navigate", "click_element", "type_text", "press_key"] {
            let needle = format!(r#""name":"{name}""#);
            let tool = tools_list()
                .lines()
                .find(|line| line.contains(&needle))
                .expect("mutating Chrome tool must be declared");
            assert!(tool.contains(r#""readOnlyHint":false"#), "{name}");
            assert!(tool.contains(r#""destructiveHint":true"#), "{name}");
        }
    }
}
