import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR } from "./constants.js";
import {
  parseTranscriptFile,
  extractUserMessages,
  extractToolUses,
  extractToolErrors,
  countInterrupts,
  getSessionTimeRange,
  extractCodexCwd,
} from "./parser.js";

const decodeProjectName = (encodedName: string): string =>
  encodedName.replace(/-/g, "/").replace(/^\//, "");

const encodeProjectName = (cwdPath: string): string =>
  cwdPath.replace(/^\//, "").replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "");

export const getProjectsDir = (): string =>
  path.join(os.homedir(), CLAUDE_PROJECTS_DIR);

export const getCodexSessionsDir = (): string =>
  path.join(os.homedir(), CODEX_SESSIONS_DIR);

export const discoverProjects = (projectsDir: string): string[] => {
  if (!fs.existsSync(projectsDir)) return [];
  return fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
};

export const discoverSessions = (projectDir: string): string[] => {
  const results: string[] = [];

  // Top-level session files
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(entry.name);
    }
    // Walk into <session-id>/subagents/ for agent session files
    if (entry.isDirectory()) {
      const subagentsDir = path.join(projectDir, entry.name, "subagents");
      if (fs.existsSync(subagentsDir)) {
        for (const sub of fs.readdirSync(subagentsDir)) {
          if (sub.endsWith(".jsonl")) {
            results.push(path.join(entry.name, "subagents", sub));
          }
        }
      }
    }
  }

  return results;
};

/** Recursively find all .jsonl files under the Codex sessions directory. */
const discoverCodexSessionFiles = (baseDir: string): string[] => {
  const results: string[] = [];
  if (!fs.existsSync(baseDir)) return results;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  };

  walk(baseDir);
  return results;
};

export const buildSessionMetadata = async (
  filePath: string,
  projectPath: string,
  projectName: string,
): Promise<SessionMetadata> => {
  const sessionId = path.basename(filePath, ".jsonl");
  const events = await parseTranscriptFile(filePath);
  const userMessages = extractUserMessages(events);
  const toolUses = extractToolUses(events);
  const toolErrorCount = extractToolErrors(events);
  const interruptCount = countInterrupts(events);
  const { start, end } = getSessionTimeRange(events);

  const assistantMessageCount = events.filter(
    (event) => event.type === "assistant",
  ).length;

  return {
    sessionId,
    projectPath,
    projectName,
    filePath,
    startTime: start,
    endTime: end,
    userMessageCount: userMessages.length,
    assistantMessageCount,
    toolCallCount: toolUses.length,
    toolErrorCount,
    interruptCount,
  };
};

/** Index Codex rollout sessions, grouped by cwd from session_meta. */
const indexCodexProjects = async (
  projectFilter?: string,
): Promise<ProjectMetadata[]> => {
  const codexDir = getCodexSessionsDir();
  const sessionFiles = discoverCodexSessionFiles(codexDir);

  if (sessionFiles.length === 0) return [];

  // Group files by cwd (extracted from session_meta)
  const projectMap = new Map<string, string[]>();

  for (const filePath of sessionFiles) {
    try {
      const cwd = await extractCodexCwd(filePath);
      const key = cwd ?? "unknown";
      if (!projectMap.has(key)) projectMap.set(key, []);
      projectMap.get(key)!.push(filePath);
    } catch {
      /* skip unreadable files */
    }
  }

  const projects: ProjectMetadata[] = [];

  for (const [cwd, files] of projectMap.entries()) {
    const encodedName = encodeProjectName(cwd);
    const decodedName = cwd.replace(/\\/g, "/").replace(/^\//, "");

    if (projectFilter && !decodedName.includes(projectFilter)) continue;

    const sessions: SessionMetadata[] = [];
    for (const filePath of files) {
      try {
        const metadata = await buildSessionMetadata(
          filePath,
          decodedName,
          encodedName,
        );
        sessions.push(metadata);
      } catch {
        /* skip unreadable session files */
      }
    }

    if (sessions.length === 0) continue;

    sessions.sort(
      (left, right) => left.startTime.getTime() - right.startTime.getTime(),
    );

    projects.push({
      projectPath: decodedName,
      projectName: encodedName,
      sessions,
      totalSessions: sessions.length,
    });
  }

  return projects;
};

export const indexAllProjects = async (
  projectFilter?: string,
): Promise<ProjectMetadata[]> => {
  const projectsDir = getProjectsDir();
  const projectDirs = discoverProjects(projectsDir);
  const projects: ProjectMetadata[] = [];

  // Claude Code sessions
  for (const encodedName of projectDirs) {
    const decodedName = decodeProjectName(encodedName);

    if (projectFilter && !decodedName.includes(projectFilter)) continue;

    const projectDir = path.join(projectsDir, encodedName);
    const sessionFiles = discoverSessions(projectDir);

    if (sessionFiles.length === 0) continue;

    const sessions: SessionMetadata[] = [];
    for (const sessionFile of sessionFiles) {
      const filePath = path.join(projectDir, sessionFile);
      try {
        const metadata = await buildSessionMetadata(
          filePath,
          decodedName,
          encodedName,
        );
        sessions.push(metadata);
      } catch {
        /* skip unreadable session files */
      }
    }

    sessions.sort(
      (left, right) => left.startTime.getTime() - right.startTime.getTime(),
    );

    projects.push({
      projectPath: decodedName,
      projectName: encodedName,
      sessions,
      totalSessions: sessions.length,
    });
  }

  // Codex sessions
  const codexProjects = await indexCodexProjects(projectFilter);
  for (const codexProject of codexProjects) {
    // Merge with existing project if same path, otherwise append
    const existing = projects.find(
      (p) => p.projectPath === codexProject.projectPath,
    );
    if (existing) {
      existing.sessions.push(...codexProject.sessions);
      existing.sessions.sort(
        (left, right) => left.startTime.getTime() - right.startTime.getTime(),
      );
      existing.totalSessions = existing.sessions.length;
    } else {
      projects.push(codexProject);
    }
  }

  projects.sort((left, right) => right.totalSessions - left.totalSessions);

  return projects;
};
