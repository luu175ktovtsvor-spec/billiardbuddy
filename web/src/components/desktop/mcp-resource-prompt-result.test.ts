import { describe, expect, test } from "vitest";
import { parseMcpPromptList, parseMcpPromptRead, parseMcpResourceList, parseMcpResourceRead } from "./mcp-resource-prompt-result";

describe("MCP resource/prompt result parsers", () => {
  test("parses resource list", () => {
    expect(parseMcpResourceList(`<mcp_resources server="local fixture">
- uri=store://profile name=store-profile mimeType=text/plain size=12
  Store profile
- template uriTemplate=store://{id} name=store mimeType=text/plain
  Store template
</mcp_resources>`)).toEqual({
      server: "local fixture",
      entries: [
        { kind: "resource", uri: "store://profile", uriTemplate: undefined, name: "store-profile", mimeType: "text/plain", size: 12, description: "Store profile" },
        { kind: "template", uri: undefined, uriTemplate: "store://{id}", name: "store", mimeType: "text/plain", size: undefined, description: "Store template" },
      ],
    });
  });

  test("parses resource read result", () => {
    expect(parseMcpResourceRead(`<mcp_resource_result server="local fixture" uri="store://profile">
profile:vip-room
</mcp_resource_result>`)).toEqual({
      server: "local fixture",
      uri: "store://profile",
      content: "profile:vip-room",
    });
  });

  test("parses prompt list", () => {
    expect(parseMcpPromptList(`<mcp_prompts server="local fixture">
- name=daily args=topic*,style
  Daily summary
</mcp_prompts>`)).toEqual({
      server: "local fixture",
      prompts: [{ name: "daily", args: ["topic*", "style"], description: "Daily summary" }],
    });
  });

  test("parses prompt read result", () => {
    expect(parseMcpPromptRead(`<mcp_prompt server="local fixture" name="daily" description="Daily prompt">
<message role="user">
daily:&lt;topic&gt;
</message>
</mcp_prompt>`)).toEqual({
      server: "local fixture",
      name: "daily",
      description: "Daily prompt",
      messages: [{ role: "user", content: "daily:<topic>" }],
    });
  });

  test("parses stored MCP resource read preview", () => {
    expect(parseMcpResourceRead(`<stored_tool_result tool="read_mcp_resource" call_id="call_1" chars="30000" bytes="32000" path="/tmp/result.txt">
<preview_head chars="80">
&lt;mcp_resource_result server="docs" uri="store://profile"&gt;
profile:
</preview_head>
<preview_tail chars="80">
vip-room
&lt;/mcp_resource_result&gt;
</preview_tail>
</stored_tool_result>`)).toEqual({
      server: "docs",
      uri: "store://profile",
      content: "profile:\nvip-room",
    });
  });
});
