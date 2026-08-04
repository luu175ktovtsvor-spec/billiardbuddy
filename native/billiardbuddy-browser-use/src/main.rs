//! Stdio MCP endpoint for BilliardBuddy's isolated in-app Browser.
//!
//! The Electron main process owns the browser profile, permissions and window.
//! This process only forwards a bounded set of requests through its short-lived
//! authenticated loopback bridge; it cannot access a user's external browser.

use std::{
    env, fs,
    io::{self, BufRead, BufReader, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    time::Duration,
};

const NAME: &str = "billiardbuddy-browser-use";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_SCREENSHOT_DATA: usize = 16 * 1024 * 1024;
const MAX_RESPONSE: usize = MAX_SCREENSHOT_DATA + 1024 * 1024;

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle(&line) {
            let response = response.replace('\n', "").replace('\r', "");
            if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}

fn handle(message: &str) -> Option<String> {
    let id = member(message, "id");
    let Some(method) = string_member(message, "method") else {
        return Some(error(
            id.as_deref().unwrap_or("null"),
            -32600,
            "invalid JSON-RPC request",
        ));
    };
    let response = match method.as_str() {
        "initialize" => success(
            id.as_deref().unwrap_or("null"),
            &format!(
                r#"{{"protocolVersion":"2025-06-18","capabilities":{{"tools":{{"listChanged":false}}}},"serverInfo":{{"name":"{NAME}","version":"{VERSION}"}}}}"#
            ),
        ),
        "ping" => success(id.as_deref().unwrap_or("null"), "{}"),
        "tools/list" => success(id.as_deref().unwrap_or("null"), tools()),
        "tools/call" => tool_call(id.as_deref().unwrap_or("null"), message),
        "notifications/initialized" if id.is_none() => return None,
        _ => error(
            id.as_deref().unwrap_or("null"),
            -32601,
            "BilliardBuddy Browser does not support this request",
        ),
    };
    Some(response)
}

fn tools() -> &'static str {
    r#"{"tools":[
  {"name":"status","description":"Check isolated BilliardBuddy Browser readiness and its website policy.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
  {"name":"list_tabs","description":"List BilliardBuddy Browser tabs only; it never lists the user's Chrome or other browser tabs.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
  {"name":"open_tab","description":"Open one HTTP(S) URL in BilliardBuddy's isolated browser after a site permission confirmation.","inputSchema":{"type":"object","properties":{"url":{"type":"string","maxLength":4096}},"required":["url"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}},
  {"name":"close_tab","description":"Close one BilliardBuddy Browser tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
  {"name":"inspect_page","description":"Read a bounded page snapshot and current element IDs for one Browser tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
  {"name":"capture_page","description":"Capture one Browser tab's visible page as a PNG image.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
  {"name":"developer_snapshot","description":"Read a bounded Console, Network and Performance summary for one BilliardBuddy Browser tab. The host omits headers, cookies, storage, bodies and raw CDP access, removes URL credentials, query strings, fragments and sensitive path identifiers, and applies best-effort redaction to console text.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
  {"name":"cdp_send","description":"Run one read-only, allowlisted developer inspection in an approved Browser tab. Only DOM.getDocument, Page.getLayoutMetrics, and Performance.getMetrics are accepted. Results are projected and redacted by the host; this never accepts arbitrary JavaScript, CDP parameters, cookies, storage, headers, credentials, response bodies, or mutation commands.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"method":{"type":"string","enum":["DOM.getDocument","Page.getLayoutMetrics","Performance.getMetrics"]}},"required":["tabId","method"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
  {"name":"cdp_read_events","description":"Read bounded, redacted developer events after a cursor from one approved Browser tab. Events contain only Console, Network and navigation summaries; they never include headers, cookies, storage, request/response bodies or raw CDP payloads.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"afterSequence":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
  {"name":"wait_for_page","description":"Wait, for at most 10 seconds, until an approved Browser tab reaches a complete document state or a visible text fragment appears. The text is never returned and cannot be used to inspect form values, cookies, storage or hidden page state.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"text":{"type":"string","minLength":1,"maxLength":256},"timeoutMs":{"type":"integer","minimum":1,"maximum":10000}},"required":["tabId"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":true}},
  {"name":"navigate","description":"Navigate one Browser tab to an HTTP(S) URL after website permission confirmation.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"url":{"type":"string","maxLength":4096}},"required":["tabId","url"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}},
  {"name":"click_element","description":"Click a current element ID after user confirmation. Never use it for purchases, submission or deletion without explicit user approval.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"elementId":{"type":"string","pattern":"^bb-[1-9][0-9]*-[1-9][0-9]*$"}},"required":["tabId","elementId"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}},
  {"name":"type_text","description":"Type into a current non-sensitive page field. Password and authentication fields are rejected by the host.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"elementId":{"type":"string","pattern":"^bb-[1-9][0-9]*-[1-9][0-9]*$"},"text":{"type":"string","minLength":1,"maxLength":4096}},"required":["tabId","elementId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}},
  {"name":"press_key","description":"Press one safe navigation key in a Browser tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"key":{"type":"string","enum":["Enter","Tab","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"]}},"required":["tabId","key"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}}
]}"#
}

fn tool_call(id: &str, message: &str) -> String {
    let params = member(message, "params").unwrap_or_else(|| "{}".to_owned());
    let Some(name) = string_member(&params, "name") else {
        return error(id, -32602, "tools/call requires a tool name");
    };
    let arguments = member(&params, "arguments").unwrap_or_else(|| "{}".to_owned());
    let result: Result<String, String> = match name.as_str() {
        "status" | "list_tabs" => bridge(&name, "{}"),
        "open_tab" => (|| {
            let url = required_string(&arguments, "url")?;
            valid_url(&url)?;
            bridge(&name, &format!(r#"{{"url":"{}"}}"#, escape(&url)))
        })(),
        "close_tab" | "inspect_page" | "capture_page" | "developer_snapshot" => {
            with_tab(&arguments, |tab| {
                bridge(&name, &format!(r#"{{"tabId":{tab}}}"#))
            })
        }
        "cdp_send" => with_tab(&arguments, |tab| {
            let method = required_string(&arguments, "method")?;
            if !matches!(
                method.as_str(),
                "DOM.getDocument" | "Page.getLayoutMetrics" | "Performance.getMetrics"
            ) {
                return Err("unsupported Browser developer method".to_owned());
            }
            bridge(&name, &format!(r#"{{"tabId":{tab},"method":"{method}"}}"#))
        }),
        "cdp_read_events" => with_tab(&arguments, |tab| {
            let after_sequence =
                optional_non_negative_integer(&arguments, "afterSequence")?.unwrap_or(0);
            let limit = optional_non_negative_integer(&arguments, "limit")?.unwrap_or(50);
            if !(1..=100).contains(&limit) {
                return Err("limit must be an integer from 1 to 100".to_owned());
            }
            bridge(
                &name,
                &format!(r#"{{"tabId":{tab},"afterSequence":{after_sequence},"limit":{limit}}}"#),
            )
        }),
        "wait_for_page" => with_tab(&arguments, |tab| {
            let text = string_member(&arguments, "text");
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
                .map(|value| format!(",\"text\":\"{}\"", escape(&value)))
                .unwrap_or_default();
            bridge(
                &name,
                &format!(r#"{{"tabId":{tab},"timeoutMs":{timeout_ms}{text_field}}}"#),
            )
        }),
        "navigate" => with_tab(&arguments, |tab| {
            let url = required_string(&arguments, "url")?;
            valid_url(&url)?;
            bridge(
                &name,
                &format!(r#"{{"tabId":{tab},"url":"{}"}}"#, escape(&url)),
            )
        }),
        "click_element" => with_tab(&arguments, |tab| {
            let element = valid_element(&arguments)?;
            bridge(
                &name,
                &format!(r#"{{"tabId":{tab},"elementId":"{element}"}}"#),
            )
        }),
        "type_text" => with_tab(&arguments, |tab| {
            let element = valid_element(&arguments)?;
            let text = required_string(&arguments, "text")?;
            if text.is_empty() || text.chars().count() > 4096 {
                return Err("text must contain 1-4096 characters".to_owned());
            };
            bridge(
                &name,
                &format!(
                    r#"{{"tabId":{tab},"elementId":"{element}","text":"{}"}}"#,
                    escape(&text)
                ),
            )
        }),
        "press_key" => with_tab(&arguments, |tab| {
            let key = required_string(&arguments, "key")?;
            if !matches!(
                key.as_str(),
                "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
            ) {
                return Err("unsupported Browser key".to_owned());
            };
            bridge(&name, &format!(r#"{{"tabId":{tab},"key":"{key}"}}"#))
        }),
        _ => return error(id, -32602, "unknown BilliardBuddy Browser tool"),
    };
    let payload = match result {
        Ok(value) if name == "capture_page" => {
            image_result(&value).unwrap_or_else(|reason| tool_error(&reason))
        }
        Ok(value) => tool_result(&value),
        Err(reason) => tool_error(&reason),
    };
    success(id, &payload)
}

fn with_tab<T>(
    arguments: &str,
    action: impl FnOnce(i64) -> Result<T, String>,
) -> Result<T, String> {
    let tab = member(arguments, "tabId")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "tabId must be a positive integer".to_owned())?;
    action(tab)
}
fn valid_element(arguments: &str) -> Result<String, String> {
    let value = required_string(arguments, "elementId")?;
    let valid = value
        .split_once('-')
        .and_then(|(prefix, rest)| (prefix == "bb").then_some(rest))
        .is_some_and(|rest| {
            rest.split('-')
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        });
    if !valid || value.len() > 48 {
        return Err("elementId must come from inspect_page".to_owned());
    };
    Ok(value)
}
fn valid_url(value: &str) -> Result<(), String> {
    if value.len() > 4096 || !(value.starts_with("https://") || value.starts_with("http://")) {
        Err("url must be an http or https URL no longer than 4096 characters".to_owned())
    } else {
        Ok(())
    }
}
fn optional_non_negative_integer(value: &str, key: &str) -> Result<Option<i64>, String> {
    member(value, key)
        .map(|raw| {
            raw.parse::<i64>()
                .ok()
                .filter(|number| *number >= 0)
                .ok_or_else(|| format!("{key} must be a non-negative integer"))
        })
        .transpose()
}

fn bridge(operation: &str, arguments: &str) -> Result<String, String> {
    let root = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "BilliardBuddy Browser is not connected to the app".to_owned())?;
    let state = fs::read_to_string(root.join("browser-use").join("bridge.json")).map_err(|_| {
        "BilliardBuddy Browser is not ready. Reopen BilliardBuddy and try again".to_owned()
    })?;
    let port = member(&state, "port")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "BilliardBuddy Browser host state has an invalid port".to_owned())?;
    let token = required_string(&state, "token")?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("BilliardBuddy Browser host state has an invalid token".to_owned());
    }
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    )
    .map_err(|_| "BilliardBuddy Browser host is unavailable".to_owned())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    let request =
        format!(r#"{{"token":"{token}","operation":"{operation}","arguments":{arguments}}}"#);
    stream
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|_| "BilliardBuddy Browser host disconnected".to_owned())?;
    stream
        .flush()
        .map_err(|_| "BilliardBuddy Browser host disconnected".to_owned())?;
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .map_err(|_| "BilliardBuddy Browser host did not respond".to_owned())?;
    if response.len() > MAX_RESPONSE {
        return Err("BilliardBuddy Browser host returned an oversized response".to_owned());
    }
    if member(&response, "ok").as_deref() != Some("true") {
        return Err(string_member(&response, "error")
            .unwrap_or_else(|| "BilliardBuddy Browser request failed".to_owned()));
    }
    member(&response, "payload")
        .ok_or_else(|| "BilliardBuddy Browser host returned an invalid response".to_owned())
}

fn image_result(value: &str) -> Result<String, String> {
    let mime = string_member(value, "mimeType").unwrap_or_default();
    let data = required_string(value, "data")?;
    if mime != "image/png"
        || data.is_empty()
        || data.len() > MAX_SCREENSHOT_DATA
        || !data
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("Browser returned an invalid screenshot".to_owned());
    };
    Ok(format!(
        r#"{{"content":[{{"type":"image","data":"{data}","mimeType":"image/png"}}],"isError":false}}"#
    ))
}
fn tool_result(value: &str) -> String {
    format!(
        r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":false}}"#,
        escape(value)
    )
}
fn tool_error(value: &str) -> String {
    format!(
        r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":true}}"#,
        escape(value)
    )
}
fn success(id: &str, result: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)
}
fn error(id: &str, code: i32, message: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":"{}"}}}}"#,
        escape(message)
    )
}
fn required_string(value: &str, key: &str) -> Result<String, String> {
    string_member(value, key).ok_or_else(|| format!("{key} must be a string"))
}

// Small, allocation-bounded parser for the fixed JSON fields of this local
// protocol. It deliberately does not evaluate page content or accept arbitrary
// JSON paths.
fn member(value: &str, key: &str) -> Option<String> {
    let mut remainder = value.trim().strip_prefix('{')?;
    loop {
        remainder = remainder.trim_start();
        if remainder.starts_with('}') {
            return None;
        }
        if let Some(after_comma) = remainder.strip_prefix(',') {
            remainder = after_comma.trim_start();
        }
        let key_end = json_end(remainder)?;
        let member_key = remainder[..key_end]
            .strip_prefix('"')?
            .strip_suffix('"')
            .and_then(unescape)?;
        remainder = remainder[key_end..]
            .trim_start()
            .strip_prefix(':')?
            .trim_start();
        let value_end = json_end(remainder)?;
        if member_key == key {
            return Some(remainder[..value_end].trim().to_owned());
        }
        remainder = &remainder[value_end..];
    }
}
fn string_member(value: &str, key: &str) -> Option<String> {
    member(value, key).and_then(|raw| raw.strip_prefix('"')?.strip_suffix('"').and_then(unescape))
}
fn json_end(value: &str) -> Option<usize> {
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
    };
    let (mut depth, mut quote, mut escaped) = (0_i32, false, false);
    for (index, byte) in value.bytes().enumerate() {
        if quote {
            if escaped {
                escaped = false
            } else if byte == b'\\' {
                escaped = true
            } else if byte == b'"' {
                quote = false
            };
            continue;
        }
        match byte {
            b'"' => quote = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' if depth > 0 => depth -= 1,
            b',' | b'}' if depth == 0 => return Some(index),
            _ => {}
        }
    }
    Some(value.len())
}
fn unescape(value: &str) -> Option<String> {
    let mut output = String::new();
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        match chars.next()? {
            '"' => output.push('"'),
            '\\' => output.push('\\'),
            '/' => output.push('/'),
            'b' => output.push('\u{0008}'),
            'f' => output.push('\u{000c}'),
            'n' => output.push('\n'),
            'r' => output.push('\r'),
            't' => output.push('\t'),
            'u' => {
                let code: String = (0..4).map(|_| chars.next()).collect::<Option<String>>()?;
                output.push(char::from_u32(u32::from_str_radix(&code, 16).ok()?)?)
            }
            _ => return None,
        }
    }
    Some(output)
}
fn escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str(r#"\""#),
            '\\' => output.push_str(r#"\\"#),
            '\n' => output.push_str(r#"\n"#),
            '\r' => output.push_str(r#"\r"#),
            '\t' => output.push_str(r#"\t"#),
            control if control.is_control() => {
                use std::fmt::Write;
                let _ = write!(output, r#"\u{:04x}"#, control as u32);
            }
            other => output.push(other),
        }
    }
    output
}

#[cfg(test)]
mod parser_tests {
    use super::*;

    #[test]
    fn top_level_member_ignores_field_like_text() {
        let input = r#"{"text":"contains \"tabId\":999","tabId":42}"#;
        assert_eq!(member(input, "tabId").as_deref(), Some("42"));
    }

    #[test]
    fn tools_call_reads_name_only_from_nested_params() {
        let request = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"status","arguments":{"text":"contains \"name\":\"wrong\""}}}"#;
        let response = handle(request).expect("request must receive a response");
        assert!(!response.contains("tools/call requires a tool name"));
        assert!(response.contains(r#""id":7"#));
    }

    #[test]
    fn mutating_browser_tools_explicitly_require_core_approval() {
        for name in [
            "open_tab",
            "close_tab",
            "navigate",
            "click_element",
            "type_text",
            "press_key",
        ] {
            let needle = format!(r#""name":"{name}""#);
            let tool = tools()
                .lines()
                .find(|line| line.contains(&needle))
                .expect("mutating Browser tool must be declared");
            assert!(tool.contains(r#""readOnlyHint":false"#), "{name}");
            assert!(tool.contains(r#""destructiveHint":true"#), "{name}");
        }
    }
}
