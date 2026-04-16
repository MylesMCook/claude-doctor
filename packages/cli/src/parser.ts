import * as fs from "node:fs";
import * as readline from "node:readline";
import { META_MESSAGE_PATTERNS, INTERRUPT_PATTERN, MAX_USER_MESSAGE_LENGTH } from "./constants.js";

const isUserEvent = (event: TranscriptEvent): event is UserEvent =>
  event.type === "user";

const isAssistantEvent = (event: TranscriptEvent): event is AssistantEvent =>
  event.type === "assistant";

/* ── Codex rollout format detection and normalization ── */

interface CodexRolloutLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

const isCodexFormat = (firstLine: unknown): boolean => {
  if (typeof firstLine !== "object" || firstLine === null) return false;
  const { type } = firstLine as Record<string, unknown>;
  if (type === "turn_context" || type === "event_msg") return true;
  if (type === "session_meta" && typeof (firstLine as Record<string, Record<string, unknown>>).payload?.cwd === "string") return true;
  if (type === "response_item" && "payload" in firstLine) {
    const pt = (firstLine as Record<string, Record<string, unknown>>).payload?.type;
    return pt === "message" || pt === "function_call" || pt === "function_call_output" || pt === "reasoning" || pt === "web_search_call";
  }
  return false;
};

const normalizeCodexEvent = (raw: CodexRolloutLine, sessionId: string): TranscriptEvent | null => {
  const { timestamp, type, payload } = raw;

  if (type === "session_meta" || type === "turn_context" || type === "event_msg") {
    return null;
  }

  if (type !== "response_item" || !payload) return null;

  const itemType = payload.type as string;
  const role = payload.role as string | undefined;
  const content = payload.content as unknown[] | undefined;

  // User text messages
  if (role === "user" && itemType === "message" && Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "input_text"
      ) {
        textParts.push((block as Record<string, string>).text ?? "");
      }
    }
    if (textParts.length > 0) {
      return {
        type: "user",
        message: { role: "user", content: textParts.join("\n") },
        timestamp,
        sessionId,
      } as UserEvent;
    }
    return null;
  }

  // Developer messages — skip
  if (role === "developer") return null;

  // Assistant text messages
  if (role === "assistant" && itemType === "message" && Array.isArray(content)) {
    const blocks: ContentBlock[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "output_text"
      ) {
        blocks.push({
          type: "text",
          text: (block as Record<string, string>).text ?? "",
        } as TextBlock);
      }
    }
    if (blocks.length > 0) {
      return {
        type: "assistant",
        message: { role: "assistant", content: blocks },
        timestamp,
        sessionId,
      } as AssistantEvent;
    }
    return null;
  }

  // Function calls → tool_use
  if (itemType === "function_call") {
    const callId = (payload.call_id ?? payload.id ?? "") as string;
    const name = (payload.name ?? "unknown") as string;
    const args = payload.arguments;
    let input: Record<string, unknown> = {};
    try {
      input =
        typeof args === "string" ? JSON.parse(args) : (args as Record<string, unknown>) ?? {};
    } catch {
      input = { raw: args };
    }

    // Extract file_path from apply_patch headers (*** Update File: path, *** Add File: path, etc.)
    if (name === "apply_patch" && typeof args === "string") {
      const patchFileMatch = args.match(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)/);
      if (patchFileMatch) {
        input.file_path = patchFileMatch[1].trim();
      }
    }

    return {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name, input, id: callId } as ToolUseBlock],
      },
      timestamp,
      sessionId,
    } as AssistantEvent;
  }

  // Function call outputs → tool_result
  if (itemType === "function_call_output") {
    const callId = (payload.call_id ?? "") as string;
    let output = payload.output;
    if (Array.isArray(output)) output = JSON.stringify(output);
    else if (typeof output !== "string") output = String(output ?? "");
    const outputStr = output as string;
    const isError = (payload.status as string) === "failed";

    return {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: callId,
            is_error: isError,
            content: outputStr.slice(0, 2000),
          } as ToolResultBlock,
        ],
      },
      timestamp,
      sessionId,
    } as UserEvent;
  }

  return null;
};

/* ── Shared parser ── */

export const parseTranscriptFile = async (
  filePath: string,
): Promise<TranscriptEvent[]> => {
  const events: TranscriptEvent[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let isCodex: boolean | null = null;
  const fileSessionId = filePath.replace(/.*[/\\]/, "").replace(/\.jsonl$/, "");

  for await (const line of lineReader) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);

      // Auto-detect format on first parseable line
      if (isCodex === null) {
        isCodex = isCodexFormat(parsed);
      }

      if (isCodex) {
        const normalized = normalizeCodexEvent(parsed as CodexRolloutLine, fileSessionId);
        if (normalized) events.push(normalized);
      } else {
        events.push(parsed);
      }
    } catch {
      /* malformed JSONL line */
    }
  }

  return events;
};

export const extractUserMessages = (events: TranscriptEvent[]): string[] => {
  const messages: string[] = [];

  for (const event of events) {
    if (!isUserEvent(event)) continue;
    const content = event.message?.content;
    if (typeof content !== "string") continue;
    if (event.isMeta) continue;

    const isMetaMessage = META_MESSAGE_PATTERNS.some((pattern) =>
      pattern.test(content),
    );
    if (isMetaMessage) continue;

    if (content.length > MAX_USER_MESSAGE_LENGTH) continue;

    messages.push(content);
  }

  return messages;
};

export const extractToolUses = (events: TranscriptEvent[]): ToolUseEntry[] => {
  const toolUses: ToolUseEntry[] = [];

  for (const event of events) {
    if (!isAssistantEvent(event)) continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "tool_use") {
        const toolBlock = block as ToolUseBlock;
        toolUses.push({
          name: toolBlock.name,
          input: toolBlock.input,
          id: toolBlock.id,
        });
      }
    }
  }

  return toolUses;
};

export const extractToolErrors = (events: TranscriptEvent[]): number => {
  let errorCount = 0;

  for (const event of events) {
    if (!isUserEvent(event)) continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "tool_result") {
        const resultBlock = block as ToolResultBlock;
        if (resultBlock.is_error) {
          errorCount++;
          continue;
        }
        const resultContent =
          typeof resultBlock.content === "string"
            ? resultBlock.content
            : resultBlock.content
                ?.map((innerBlock: { type: string; text?: string }) => innerBlock.text ?? "")
                .join("");
        if (resultContent?.includes("<tool_use_error>")) {
          errorCount++;
        }
      }
    }
  }

  return errorCount;
};

export const countInterrupts = (events: TranscriptEvent[]): number => {
  let count = 0;

  for (const event of events) {
    if (!isUserEvent(event)) continue;
    const content = event.message?.content;
    if (typeof content !== "string") continue;
    if (INTERRUPT_PATTERN.test(content)) {
      count++;
    }
  }

  return count;
};

export const getSessionTimeRange = (
  events: TranscriptEvent[],
): SessionTimeRange => {
  let earliest = Infinity;
  let latest = -Infinity;

  for (const event of events) {
    if (!event.timestamp) continue;
    const time = new Date(event.timestamp).getTime();
    if (time < earliest) earliest = time;
    if (time > latest) latest = time;
  }

  return {
    start: new Date(earliest === Infinity ? 0 : earliest),
    end: new Date(latest === -Infinity ? 0 : latest),
  };
};

/** Extract the cwd from a Codex rollout file's session_meta line. */
export const extractCodexCwd = async (filePath: string): Promise<string | null> => {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lineReader) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "session_meta" && parsed.payload?.cwd) {
        lineReader.close();
        stream.destroy();
        return parsed.payload.cwd as string;
      }
    } catch {
      /* skip */
    }
  }

  return null;
};

export { isUserEvent, isAssistantEvent };
