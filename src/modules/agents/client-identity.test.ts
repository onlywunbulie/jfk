import { describe, expect, it } from "vitest";
import { identifyClient } from "./client-identity";

describe("who an AI app really is", () => {
  it("Claude coming back to claude.ai, or Claude Code on this computer, is what it says", () => {
    expect(identifyClient("Claude", "https://claude.ai/api/mcp/auth_callback")).toEqual({ destination: "claude.ai", impersonating: false });
    expect(identifyClient("Claude Code", "http://localhost:53172/callback")).toEqual({ destination: "an app on this computer", impersonating: false });
  });

  it("an app calling itself Claude that sends the code anywhere else is flagged", () => {
    expect(identifyClient("Claude", "https://claude.ai.evil.example/cb")).toMatchObject({ impersonating: true, destination: "claude.ai.evil.example" });
    expect(identifyClient("ChatGPT", "https://chatgpt-login.example/cb")).toMatchObject({ impersonating: true });
  });

  it("an app with its own name is shown with its site, not flagged", () => {
    expect(identifyClient("Budget Buddy", "https://budgetbuddy.example/cb")).toEqual({ destination: "budgetbuddy.example", impersonating: false });
  });
});
