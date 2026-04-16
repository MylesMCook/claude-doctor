import * as path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import {
  parseTranscriptFile,
  extractUserMessages,
  extractToolUses,
  extractToolErrors,
  countInterrupts,
  getSessionTimeRange,
  extractCodexCwd,
} from "../src/parser.js";

const fixture = (name: string) =>
  path.join(import.meta.dirname, "fixtures", name);

describe("parseTranscriptFile", () => {
  it("parses all events from a JSONL file", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("queue-operation");
  });

  it("includes correct event types", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    const types = new Set(events.map((event) => event.type));
    expect(types.has("queue-operation")).toBe(true);
    expect(types.has("user")).toBe(true);
    expect(types.has("assistant")).toBe(true);
  });

  it("preserves session IDs", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    for (const event of events) {
      expect(event.sessionId).toBe("happy-session-001");
    }
  });
});

describe("extractUserMessages", () => {
  it("extracts real user messages from a happy session", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    const messages = extractUserMessages(events);
    expect(messages).toContain("add a login form to the homepage");
    expect(messages).toContain("looks great, thanks!");
  });

  it("excludes tool results (array content)", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    const messages = extractUserMessages(events);
    for (const message of messages) {
      expect(message).not.toContain("File written");
    }
  });

  it("excludes meta messages", async () => {
    const events = await parseTranscriptFile(fixture("meta-only-session.jsonl"));
    const messages = extractUserMessages(events);
    expect(messages).not.toContain(
      expect.stringContaining("local-command-caveat"),
    );
    expect(messages).not.toContain(
      expect.stringContaining("command-name"),
    );
    expect(messages).not.toContain(
      expect.stringContaining("local-command-stdout"),
    );
  });

  it("excludes task-notification messages", async () => {
    const events = await parseTranscriptFile(fixture("meta-only-session.jsonl"));
    const messages = extractUserMessages(events);
    for (const message of messages) {
      expect(message).not.toMatch(/^<task-notification/);
    }
  });

  it("excludes environment injection messages", async () => {
    const events = await parseTranscriptFile(fixture("meta-only-session.jsonl"));
    const messages = extractUserMessages(events);
    for (const message of messages) {
      expect(message).not.toMatch(/^<environment>/);
    }
  });

  it("excludes license/code block pasted content", async () => {
    const events = await parseTranscriptFile(fixture("meta-only-session.jsonl"));
    const messages = extractUserMessages(events);
    for (const message of messages) {
      expect(message).not.toMatch(/^\/\*\*/);
    }
  });

  it("keeps the one real message from meta-heavy session", async () => {
    const events = await parseTranscriptFile(fixture("meta-only-session.jsonl"));
    const messages = extractUserMessages(events);
    expect(messages).toEqual(["actual user message here"]);
  });

  it("extracts frustrated messages including profanity", async () => {
    const events = await parseTranscriptFile(
      fixture("frustrated-session.jsonl"),
    );
    const messages = extractUserMessages(events);
    expect(messages).toContain("fix the broken login page");
    expect(messages).toContain("no that's wrong, revert that change");
    expect(messages).toContain("none of this shit works, undo everything");
  });
});

describe("extractToolUses", () => {
  it("extracts tool uses from assistant events", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    const toolUses = extractToolUses(events);
    expect(toolUses.length).toBe(2);
    expect(toolUses[0].name).toBe("Read");
    expect(toolUses[1].name).toBe("Write");
  });

  it("extracts tool input correctly", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    const toolUses = extractToolUses(events);
    expect(toolUses[0].input).toHaveProperty("file_path", "src/app/page.tsx");
  });

  it("counts many tool uses in thrashing session", async () => {
    const events = await parseTranscriptFile(
      fixture("thrashing-session.jsonl"),
    );
    const toolUses = extractToolUses(events);
    expect(toolUses.length).toBe(7);
  });
});

describe("extractToolErrors", () => {
  it("returns zero for a clean session", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    expect(extractToolErrors(events)).toBe(0);
  });

  it("counts is_error tool results", async () => {
    const events = await parseTranscriptFile(
      fixture("error-loop-session.jsonl"),
    );
    const errorCount = extractToolErrors(events);
    expect(errorCount).toBeGreaterThanOrEqual(4);
  });

  it("counts tool_use_error markers", async () => {
    const events = await parseTranscriptFile(
      fixture("error-loop-session.jsonl"),
    );
    const errorCount = extractToolErrors(events);
    expect(errorCount).toBe(7);
  });
});

describe("countInterrupts", () => {
  it("returns zero for sessions without interrupts", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    expect(countInterrupts(events)).toBe(0);
  });

  it("detects user interrupts", async () => {
    const events = await parseTranscriptFile(
      fixture("frustrated-session.jsonl"),
    );
    expect(countInterrupts(events)).toBe(1);
  });
});

describe("Codex format support", () => {
  it("auto-detects and parses Codex rollout JSONL", async () => {
    const events = await parseTranscriptFile(fixture("codex-session.jsonl"));
    expect(events.length).toBeGreaterThan(0);
    // Developer messages should be skipped
    const devEvents = events.filter(
      (e) => e.type === "user" && typeof (e as any).message?.content === "string" && (e as any).message.content.includes("You are Codex"),
    );
    expect(devEvents.length).toBe(0);
  });

  it("extracts user messages from Codex sessions", async () => {
    const events = await parseTranscriptFile(fixture("codex-session.jsonl"));
    const messages = extractUserMessages(events);
    expect(messages).toContain("Fix the login bug in auth.ts");
    expect(messages).toContain("no that's wrong, the bug is in the session handler");
  });

  it("normalizes function_call to tool_use", async () => {
    const events = await parseTranscriptFile(fixture("codex-session.jsonl"));
    const toolUses = extractToolUses(events);
    expect(toolUses.length).toBe(4);
    expect(toolUses.map((t) => t.name)).toEqual(["shell", "apply_patch", "shell", "shell"]);
  });

  it("extracts file_path from apply_patch headers", async () => {
    const events = await parseTranscriptFile(fixture("codex-session.jsonl"));
    const toolUses = extractToolUses(events);
    const patch = toolUses.find((t) => t.name === "apply_patch");
    expect(patch?.input.file_path).toBe("src/auth.ts");
  });

  it("uses only payload.status for error detection", async () => {
    const events = await parseTranscriptFile(fixture("codex-session.jsonl"));
    const errorCount = extractToolErrors(events);
    // Only the lint failure (status: "failed") should count, not "0 errors found"
    expect(errorCount).toBe(1);
  });

  it("populates sessionId from filename", async () => {
    const events = await parseTranscriptFile(fixture("codex-session.jsonl"));
    const userEvent = events.find((e) => e.type === "user");
    expect(userEvent?.sessionId).toBe("codex-session");
  });
});

describe("extractCodexCwd", () => {
  it("extracts cwd from Codex session_meta", async () => {
    const cwd = await extractCodexCwd(fixture("codex-session.jsonl"));
    expect(cwd).toBe("/home/user/project");
  });

  it("returns null for Claude Code sessions", async () => {
    const cwd = await extractCodexCwd(fixture("happy-session.jsonl"));
    expect(cwd).toBeNull();
  });
});

describe("getSessionTimeRange", () => {
  it("returns correct time range", async () => {
    const events = await parseTranscriptFile(fixture("happy-session.jsonl"));
    const { start, end } = getSessionTimeRange(events);
    expect(start.getTime()).toBeLessThan(end.getTime());
    expect(start.toISOString()).toBe("2026-04-01T10:00:00.000Z");
    expect(end.toISOString()).toBe("2026-04-01T10:00:20.000Z");
  });
});
