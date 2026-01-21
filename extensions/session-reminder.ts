/**
 * Session Reminder Extension
 * 
 * Periodically reminds the agent to check on hands-free sessions.
 * Prevents the "sitting there doing nothing" problem.
 * 
 * When a hands-free session is active, this extension:
 * 1. Tracks active session IDs from interactive_shell tool results
 * 2. After configurable delay, injects a reminder message
 * 3. Continues reminding until session is killed or exits
 * 
 * Config (in ~/.pi/agent/session-reminder.json):
 * {
 *   "reminderIntervalMs": 30000,  // Remind every 30s (default)
 *   "enabled": true
 * }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface Config {
  reminderIntervalMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: Config = {
  reminderIntervalMs: 15000, // 15 seconds
  enabled: true,
};

function loadConfig(): Config {
  const configPath = join(homedir(), ".pi", "agent", "session-reminder.json");
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
}

interface ActiveSession {
  sessionId: string;
  command: string;
  startedAt: number;
  lastRemindedAt: number;
  status: string;
  reminderCount: number;
}

export default function sessionReminderExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  
  if (!config.enabled) {
    return;
  }

  const activeSessions = new Map<string, ActiveSession>();
  let reminderInterval: ReturnType<typeof setInterval> | null = null;

  const MAX_REMINDERS = 10; // Stop after 10 reminders
  const MAX_SESSION_AGE_MS = 10 * 60 * 1000; // 10 minutes max tracking

  function checkAndRemind() {
    const now = Date.now();
    
    for (const [sessionId, session] of activeSessions) {
      // Only remind for running sessions
      if (session.status !== "running") {
        activeSessions.delete(sessionId);
        continue;
      }
      
      // Auto-cleanup old sessions (likely stale)
      const sessionAge = now - session.startedAt;
      if (sessionAge > MAX_SESSION_AGE_MS) {
        activeSessions.delete(sessionId);
        continue;
      }
      
      // Stop after max reminders (agent is clearly ignoring us)
      if (session.reminderCount >= MAX_REMINDERS) {
        activeSessions.delete(sessionId);
        continue;
      }
      
      const timeSinceLastReminder = now - session.lastRemindedAt;
      
      if (timeSinceLastReminder >= config.reminderIntervalMs) {
        const runtime = Math.round((now - session.startedAt) / 1000);
        
        session.reminderCount++;
        
        pi.sendMessage({
          customType: "session-reminder",
          content: `⏰ REMINDER (${session.reminderCount}/${MAX_REMINDERS}): You have an active hands-free session!

Session: ${sessionId}
Command: ${session.command}
Runtime: ${runtime}s

Check on it NOW:
\`\`\`typescript
interactive_shell({ sessionId: "${sessionId}" })
\`\`\`

Or kill it if done:
\`\`\`typescript
interactive_shell({ sessionId: "${sessionId}", kill: true })
\`\`\``,
          display: true,
          details: { 
            sessionId, 
            runtime,
            reminderType: "periodic",
            reminderCount: session.reminderCount,
          },
        }, {
          deliverAs: "followUp",  // Wait for current work, don't interrupt mid-task
          triggerTurn: true,
        });
        
        session.lastRemindedAt = now;
      }
    }
  }

  // Start reminder loop on session start
  pi.on("session_start", async (_event, ctx) => {
    if (!reminderInterval) {
      // Check more frequently than reminder interval to catch sessions promptly
      reminderInterval = setInterval(checkAndRemind, Math.min(10000, config.reminderIntervalMs / 3));
    }
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    if (reminderInterval) {
      clearInterval(reminderInterval);
      reminderInterval = null;
    }
    activeSessions.clear();
  });

  // Track interactive_shell sessions
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "interactive_shell") return;
    
    const details = event.details as Record<string, unknown>;
    const sessionId = details?.sessionId as string | undefined;
    const status = details?.status as string | undefined;
    const command = details?.command as string | undefined;
    const error = details?.error as string | undefined;
    
    if (!sessionId) return;
    
    // Session not found = remove from tracking immediately
    if (error === "session_not_found" || event.isError) {
      activeSessions.delete(sessionId);
      return;
    }
    
    // New session started
    if (status === "running" && command) {
      const now = Date.now();
      activeSessions.set(sessionId, {
        sessionId,
        command,
        startedAt: now,
        lastRemindedAt: now, // Don't remind immediately
        status: "running",
        reminderCount: 0,
      });
      return;
    }
    
    // Terminal states - remove from tracking
    // killed, exited, backgrounded, user-takeover all mean stop reminding
    if (status === "killed" || status === "exited" || status === "backgrounded" || status === "user-takeover") {
      activeSessions.delete(sessionId);
      return;
    }
    
    // Any other non-running status for a tracked session = remove
    if (status && status !== "running") {
      activeSessions.delete(sessionId);
      return;
    }
    
    // Session still running - update last activity
    if (activeSessions.has(sessionId) && status === "running") {
      const session = activeSessions.get(sessionId)!;
      session.status = status;
    }
  });

  // Also track when agent queries a session (reset reminder timer)
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "interactive_shell") return;
    
    const input = event.input as Record<string, unknown>;
    const sessionId = input?.sessionId as string | undefined;
    
    if (sessionId && activeSessions.has(sessionId)) {
      // Agent is checking on the session, reset reminder timer
      activeSessions.get(sessionId)!.lastRemindedAt = Date.now();
    }
  });
}
