//! Stdio MCP endpoint for BilliardBuddy's isolated in-app Browser.
//!
//! The Electron main process owns the browser profile, permissions and window.
//! This process only forwards a bounded set of requests through its short-lived
//! authenticated loopback bridge; it cannot access a user's external browser.

use std::{env, fs, io::{self, BufRead, BufReader, Write}, net::{SocketAddr, TcpStream}, path::PathBuf, time::Duration};

const NAME: &str = "billiardbuddy-browser-use";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_RESPONSE: usize = 13 * 1024 * 1024;

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue }
        if let Some(response) = handle(&line) {
            if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() { break }
        }
    }
}

fn handle(message: &str) -> Option<String> {
    let id = member(message, "id");
    let Some(method) = string_member(message, "method") else { return Some(error(id.as_deref().unwrap_or("null"), -32600, "invalid JSON-RPC request")) };
    let response = match method.as_str() {
        "initialize" => success(id.as_deref().unwrap_or("null"), &format!(r#"{{"protocolVersion":"2025-06-18","capabilities":{{"tools":{{"listChanged":false}}}},"serverInfo":{{"name":"{NAME}","version":"{VERSION}"}}}}"#)),
        "ping" => success(id.as_deref().unwrap_or("null"), "{}"),
        "tools/list" => success(id.as_deref().unwrap_or("null"), tools()),
        "tools/call" => tool_call(id.as_deref().unwrap_or("null"), message),
        "notifications/initialized" if id.is_none() => return None,
        _ => error(id.as_deref().unwrap_or("null"), -32601, "BilliardBuddy Browser does not implement this MCP method"),
    };
    Some(response)
}

fn tools() -> &'static str { r#"{"tools":[
  {"name":"status","description":"Check isolated BilliardBuddy Browser readiness and its website policy.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
  {"name":"list_tabs","description":"List BilliardBuddy Browser tabs only; it never lists the user's Chrome or other browser tabs.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
  {"name":"open_tab","description":"Open one HTTP(S) URL in BilliardBuddy's isolated browser after a site permission confirmation.","inputSchema":{"type":"object","properties":{"url":{"type":"string","maxLength":4096}},"required":["url"],"additionalProperties":false}},
  {"name":"close_tab","description":"Close one BilliardBuddy Browser tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false}},
  {"name":"inspect_page","description":"Read a bounded page snapshot and current element IDs for one Browser tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false}},
  {"name":"capture_page","description":"Capture one Browser tab's visible page as a PNG image.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1}},"required":["tabId"],"additionalProperties":false}},
  {"name":"navigate","description":"Navigate one Browser tab to an HTTP(S) URL after website permission confirmation.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"url":{"type":"string","maxLength":4096}},"required":["tabId","url"],"additionalProperties":false}},
  {"name":"click_element","description":"Click a current element ID after user confirmation. Never use it for purchases, submission or deletion without explicit user approval.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"elementId":{"type":"string","pattern":"^bb-[1-9][0-9]*-[1-9][0-9]*$"}},"required":["tabId","elementId"],"additionalProperties":false}},
  {"name":"type_text","description":"Type into a current non-sensitive page field. Password and authentication fields are rejected by the host.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"elementId":{"type":"string","pattern":"^bb-[1-9][0-9]*-[1-9][0-9]*$"},"text":{"type":"string","minLength":1,"maxLength":4096}},"required":["tabId","elementId","text"],"additionalProperties":false}},
  {"name":"press_key","description":"Press one safe navigation key in a Browser tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer","minimum":1},"key":{"type":"string","enum":["Enter","Tab","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"]}},"required":["tabId","key"],"additionalProperties":false}}
]}"# }

fn tool_call(id: &str, message: &str) -> String {
    let Some(name) = string_member(message, "name") else { return error(id, -32602, "tools/call requires a tool name") };
    let arguments = member(message, "arguments").unwrap_or_else(|| "{}".to_owned());
    let result: Result<String, String> = match name.as_str() {
        "status" | "list_tabs" => bridge(&name, "{}"),
        "open_tab" => (|| { let url = required_string(&arguments, "url")?; valid_url(&url)?; bridge(&name, &format!(r#"{{"url":"{}"}}"#, escape(&url))) })(),
        "close_tab" | "inspect_page" | "capture_page" => with_tab(&arguments, |tab| bridge(&name, &format!(r#"{{"tabId":{tab}}"#))),
        "navigate" => with_tab(&arguments, |tab| { let url = required_string(&arguments, "url")?; valid_url(&url)?; bridge(&name, &format!(r#"{{"tabId":{tab},"url":"{}"}}"#, escape(&url))) }),
        "click_element" => with_tab(&arguments, |tab| { let element = valid_element(&arguments)?; bridge(&name, &format!(r#"{{"tabId":{tab},"elementId":"{element}"}}"#)) }),
        "type_text" => with_tab(&arguments, |tab| { let element = valid_element(&arguments)?; let text = required_string(&arguments, "text")?; if text.is_empty() || text.chars().count() > 4096 { return Err("text must contain 1-4096 characters".to_owned()) }; bridge(&name, &format!(r#"{{"tabId":{tab},"elementId":"{element}","text":"{}"}}"#, escape(&text))) }),
        "press_key" => with_tab(&arguments, |tab| { let key = required_string(&arguments, "key")?; if !matches!(key.as_str(), "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight") { return Err("unsupported Browser key".to_owned()) }; bridge(&name, &format!(r#"{{"tabId":{tab},"key":"{key}"}}"#)) }),
        _ => return error(id, -32602, "unknown BilliardBuddy Browser tool"),
    };
    let payload = match result { Ok(value) if name == "capture_page" => image_result(&value).unwrap_or_else(|reason| tool_error(&reason)), Ok(value) => tool_result(&value), Err(reason) => tool_error(&reason) };
    success(id, &payload)
}

fn with_tab<T>(arguments: &str, action: impl FnOnce(i64) -> Result<T, String>) -> Result<T, String> { let tab = member(arguments, "tabId").and_then(|value| value.parse::<i64>().ok()).filter(|value| *value > 0).ok_or_else(|| "tabId must be a positive integer".to_owned())?; action(tab) }
fn valid_element(arguments: &str) -> Result<String, String> { let value = required_string(arguments, "elementId")?; let valid = value.split_once('-').and_then(|(prefix, rest)| (prefix == "bb").then_some(rest)).is_some_and(|rest| rest.split('-').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))); if !valid || value.len() > 48 { return Err("elementId must come from inspect_page".to_owned()) }; Ok(value) }
fn valid_url(value: &str) -> Result<(), String> { if value.len() > 4096 || !(value.starts_with("https://") || value.starts_with("http://")) { Err("url must be an http or https URL no longer than 4096 characters".to_owned()) } else { Ok(()) } }

fn bridge(operation: &str, arguments: &str) -> Result<String, String> {
    let root = env::var_os("CODEX_HOME").map(PathBuf::from).ok_or_else(|| "BilliardBuddy Browser requires the private Agent runtime".to_owned())?;
    let state = fs::read_to_string(root.join("browser-use").join("bridge.json")).map_err(|_| "BilliardBuddy Browser host is not running".to_owned())?;
    let port = member(&state, "port").and_then(|value| value.parse::<u16>().ok()).filter(|value| *value > 0).ok_or_else(|| "BilliardBuddy Browser host state has an invalid port".to_owned())?;
    let token = required_string(&state, "token")?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("BilliardBuddy Browser host state has an invalid token".to_owned()) }
    let mut stream = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(2)).map_err(|_| "BilliardBuddy Browser host is unavailable".to_owned())?;
    stream.set_read_timeout(Some(Duration::from_secs(60))).map_err(|error| error.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|error| error.to_string())?;
    let request = format!(r#"{{"token":"{token}","operation":"{operation}","arguments":{arguments}}}"#);
    stream.write_all(format!("{request}\n").as_bytes()).map_err(|_| "BilliardBuddy Browser host disconnected".to_owned())?;
    stream.flush().map_err(|_| "BilliardBuddy Browser host disconnected".to_owned())?;
    let mut response = String::new(); BufReader::new(stream).read_line(&mut response).map_err(|_| "BilliardBuddy Browser host did not respond".to_owned())?;
    if response.len() > MAX_RESPONSE { return Err("BilliardBuddy Browser host returned an oversized response".to_owned()) }
    if member(&response, "ok").as_deref() != Some("true") { return Err(string_member(&response, "error").unwrap_or_else(|| "BilliardBuddy Browser request failed".to_owned())) }
    member(&response, "payload").ok_or_else(|| "BilliardBuddy Browser host returned an invalid response".to_owned())
}

fn image_result(value: &str) -> Result<String, String> { let mime = string_member(value, "mimeType").unwrap_or_default(); let data = required_string(value, "data")?; if mime != "image/png" || data.is_empty() || data.len() > 12 * 1024 * 1024 || !data.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')) { return Err("Browser returned an invalid screenshot".to_owned()) }; Ok(format!(r#"{{"content":[{{"type":"image","data":"{data}","mimeType":"image/png"}}],"isError":false}}"#)) }
fn tool_result(value: &str) -> String { format!(r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":false}}"#, escape(value)) }
fn tool_error(value: &str) -> String { format!(r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":true}}"#, escape(value)) }
fn success(id: &str, result: &str) -> String { format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#) }
fn error(id: &str, code: i32, message: &str) -> String { format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":"{}"}}}}"#, escape(message)) }
fn required_string(value: &str, key: &str) -> Result<String, String> { string_member(value, key).ok_or_else(|| format!("{key} must be a string")) }

// Small, allocation-bounded parser for the fixed JSON fields of this local
// protocol. It deliberately does not evaluate page content or accept arbitrary
// JSON paths.
fn member(value: &str, key: &str) -> Option<String> { let needle = format!(r#""{key}""#); let start = value.find(&needle)? + needle.len(); let after = value[start..].trim_start().strip_prefix(':')?.trim_start(); let end = json_end(after)?; Some(after[..end].trim().to_owned()) }
fn string_member(value: &str, key: &str) -> Option<String> { member(value, key).and_then(|raw| raw.strip_prefix('"')?.strip_suffix('"').and_then(unescape)) }
fn json_end(value: &str) -> Option<usize> { let first = *value.as_bytes().first()?; if first == b'"' { let mut escaped = false; for (index, byte) in value.bytes().enumerate().skip(1) { if escaped { escaped = false } else if byte == b'\\' { escaped = true } else if byte == b'"' { return Some(index + 1) } }; return None }; let (mut depth, mut quote, mut escaped) = (0_i32, false, false); for (index, byte) in value.bytes().enumerate() { if quote { if escaped { escaped = false } else if byte == b'\\' { escaped = true } else if byte == b'"' { quote = false }; continue } match byte { b'"' => quote = true, b'{' | b'[' => depth += 1, b'}' | b']' if depth > 0 => depth -= 1, b',' | b'}' if depth == 0 => return Some(index), _ => {} } }; Some(value.len()) }
fn unescape(value: &str) -> Option<String> { let mut output = String::new(); let mut chars = value.chars(); while let Some(character) = chars.next() { if character != '\\' { output.push(character); continue } match chars.next()? { '"' => output.push('"'), '\\' => output.push('\\'), '/' => output.push('/'), 'b' => output.push('\u{0008}'), 'f' => output.push('\u{000c}'), 'n' => output.push('\n'), 'r' => output.push('\r'), 't' => output.push('\t'), 'u' => { let code: String = (0..4).map(|_| chars.next()).collect::<Option<String>>()?; output.push(char::from_u32(u32::from_str_radix(&code, 16).ok()?)?) }, _ => return None } }; Some(output) }
fn escape(value: &str) -> String { let mut output = String::with_capacity(value.len()); for character in value.chars() { match character { '"' => output.push_str(r#"\""#), '\\' => output.push_str(r#"\\"#), '\n' => output.push_str(r#"\n"#), '\r' => output.push_str(r#"\r"#), '\t' => output.push_str(r#"\t"#), control if control.is_control() => { use std::fmt::Write; let _ = write!(output, r#"\u{:04x}"#, control as u32); }, other => output.push(other) } }; output }
