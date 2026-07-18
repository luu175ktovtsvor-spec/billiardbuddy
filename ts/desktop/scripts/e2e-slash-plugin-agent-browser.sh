#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser is required but was not found in PATH" >&2
  exit 1
fi

API_URL="${API_URL:-http://127.0.0.1:3457}"
WEB_URL="${WEB_URL:-http://127.0.0.1:5175/?serverUrl=http://127.0.0.1:3457}"
RUN_ID="$(date +%s)-$RANDOM"
SESSION_NAME="billiardbuddy-webui-e2e-${RUN_ID}"
ARTIFACT_DIR="$(mktemp -d "/tmp/billiardbuddy-webui-e2e-${RUN_ID}-XXXX")"
AB=(agent-browser --session "${SESSION_NAME}")

cleanup() {
  local exit_code=$?
  "${AB[@]}" close >/dev/null 2>&1 || true
  echo "Artifacts kept at: ${ARTIFACT_DIR}" >&2
}
trap cleanup EXIT

wait_for_text() {
  local needle="$1"
  if ! "${AB[@]}" wait "text=${needle}" >/dev/null 2>&1; then
    echo "Timed out waiting for page text: ${needle}" >&2
    "${AB[@]}" screenshot "${ARTIFACT_DIR}/failure-wait-$(echo "${needle}" | tr ' /' '__').png" >/dev/null 2>&1 || true
    return 1
  fi
}

press_escape() {
  "${AB[@]}" press Escape >/dev/null 2>&1 || true
}

focus_composer() {
  "${AB[@]}" click textarea >/dev/null 2>&1 || "${AB[@]}" focus textarea >/dev/null 2>&1 || true
}

submit_slash_command() {
  local command="$1"
  focus_composer
  "${AB[@]}" fill textarea "${command}"
  "${AB[@]}" press Enter
}

healthcheck() {
  curl -fsS "${API_URL}/health" >/dev/null
}

select_plugin_targets() {
  DETAIL_PLUGIN_ID="$(curl -fsS "${API_URL}/api/plugins" | jq -r '
    .plugins
    | sort_by(-(.componentCounts.commands + .componentCounts.agents + .componentCounts.hooks + .componentCounts.skills + .componentCounts.mcpServers))
    | .[0].id // empty
  ')"

  if [[ -z "${DETAIL_PLUGIN_ID}" ]]; then
    echo "No plugin was found in current API data." >&2
    exit 1
  fi

  DETAIL_JSON="$(curl -fsS --get --data-urlencode "id=${DETAIL_PLUGIN_ID}" "${API_URL}/api/plugins/detail")"
  DETAIL_PLUGIN_NAME="$(jq -r '.detail.name' <<<"${DETAIL_JSON}")"

  if ! jq -e '
    .detail | (keys | sort) == ["canManage", "componentCounts", "descriptionKind", "enabled", "id", "name", "scope", "status"]
  ' <<<"${DETAIL_JSON}" >/dev/null; then
    echo "Plugin detail API returned non-summary fields." >&2
    exit 1
  fi
}

open_plugin_detail() {
  local plugin_name="$1"
  local escaped_name="${plugin_name//\"/\\\"}"
  if "${AB[@]}" eval "const target=[...document.querySelectorAll('button')].find((node)=>node.textContent?.includes(\"${escaped_name}\")); if(!target) throw new Error('plugin button not found'); target.click();" >/dev/null 2>&1; then
    wait_for_text "Capability summary"
    return 0
  fi

  echo "Failed to open plugin detail for: ${plugin_name}" >&2
  "${AB[@]}" screenshot "${ARTIFACT_DIR}/failure-open-plugin-${plugin_name}.png" >/dev/null 2>&1 || true
  return 1
}

healthcheck
select_plugin_targets

echo "Using detail plugin: ${DETAIL_PLUGIN_NAME} (${DETAIL_PLUGIN_ID})"

"${AB[@]}" open "${WEB_URL}"
"${AB[@]}" wait --load networkidle
wait_for_text "BilliardBuddy"
"${AB[@]}" screenshot "${ARTIFACT_DIR}/01-home.png" >/dev/null

# Always work from a fresh chat surface so slash-command behavior is deterministic.
"${AB[@]}" find role button click --name "New session"
"${AB[@]}" wait textarea >/dev/null

submit_slash_command "/mcp"
wait_for_text "Available MCP tools"
"${AB[@]}" screenshot "${ARTIFACT_DIR}/02-mcp-panel.png" >/dev/null
press_escape
"${AB[@]}" wait 300 >/dev/null

submit_slash_command "/skills"
wait_for_text "Available skills"
"${AB[@]}" screenshot "${ARTIFACT_DIR}/03-skills-panel.png" >/dev/null
press_escape
"${AB[@]}" wait 300 >/dev/null

submit_slash_command "/plugin"
wait_for_text "Browse installed plugins"
wait_for_text "Plugin Manager"
"${AB[@]}" screenshot "${ARTIFACT_DIR}/04-plugins-list.png" >/dev/null

open_plugin_detail "${DETAIL_PLUGIN_NAME}"
wait_for_text "Commands"
wait_for_text "Agents"
wait_for_text "Hooks"
wait_for_text "Skills"
wait_for_text "Configuration details remain private."
"${AB[@]}" screenshot "${ARTIFACT_DIR}/05-plugin-detail-main.png" >/dev/null

echo "agent-browser web UI regression passed"
echo "Artifacts: ${ARTIFACT_DIR}"
