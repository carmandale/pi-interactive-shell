/**
 * Session Steering Extension
 * 
 * Enables users to steer agents during hands-free sessions by:
 * 1. Watching for guidance files: ~/.pi/steer/{sessionId}.txt
 * 2. Injecting the guidance as a message the agent sees
 * 3. Notifying when hands-free sessions have significant output
 * 
 * Usage:
 *   # User writes guidance while agent is working
 *   echo "Look at auth.ts instead" > ~/.pi/steer/calm-reef.txt
 *   
 *   # Agent receives: "[USER GUIDANCE]: Look at auth.ts instead"
 *   # File is deleted after delivery
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { watch, existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STEER_DIR = join(homedir(), ".pi", "steer");
const CHECK_INTERVAL_MS = 5000; // Check every 5 seconds

export default function sessionSteeringExtension(pi: ExtensionAPI) {
  // Ensure steer directory exists
  if (!existsSync(STEER_DIR)) {
    mkdirSync(STEER_DIR, { recursive: true });
  }

  // Track active sessions we're watching
  const activeSessions = new Set<string>();
  let checkInterval: ReturnType<typeof setInterval> | null = null;

  // Check for guidance files
  function checkForGuidance() {
    try {
      const files = readdirSync(STEER_DIR);
      for (const file of files) {
        if (!file.endsWith(".txt")) continue;
        
        const sessionId = file.replace(".txt", "");
        const filePath = join(STEER_DIR, file);
        
        try {
          const guidance = readFileSync(filePath, "utf-8").trim();
          if (guidance) {
            // Inject the guidance as a steering message
            pi.sendMessage({
              customType: "user-guidance",
              content: `[USER GUIDANCE for session ${sessionId}]: ${guidance}

The user has sent you guidance while you're working. Please acknowledge and adjust your approach accordingly.`,
              display: true,
              details: { sessionId, guidance, source: "steer-file" },
            }, {
              deliverAs: "steer",  // Interrupts current work
              triggerTurn: true,   // Makes agent respond
            });
          }
          
          // Delete the file after processing
          unlinkSync(filePath);
        } catch (err) {
          // File might have been deleted already, ignore
        }
      }
    } catch (err) {
      // Directory might not exist or be inaccessible
    }
  }

  // Start monitoring on session start
  pi.on("session_start", async (_event, ctx) => {
    // Start periodic check for guidance files
    if (!checkInterval) {
      checkInterval = setInterval(checkForGuidance, CHECK_INTERVAL_MS);
    }
    
    ctx.ui.notify("Session steering enabled: ~/.pi/steer/{sessionId}.txt", "info");
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  });

  // Watch for tool results from interactive_shell to track active sessions
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "interactive_shell") return;
    
    const details = event.details as Record<string, unknown>;
    const sessionId = details?.sessionId as string | undefined;
    
    if (sessionId && details?.status === "running") {
      activeSessions.add(sessionId);
      
      // Notify user how to steer this session
      ctx.ui.setStatus("steer", `Steer: echo "guidance" > ~/.pi/steer/${sessionId}.txt`);
    }
    
    // Clear tracking when session ends
    if (sessionId && (details?.status === "killed" || details?.status === "exited")) {
      activeSessions.delete(sessionId);
      if (activeSessions.size === 0) {
        ctx.ui.setStatus("steer", undefined);
      }
    }
  });

  // Register command to send guidance
  pi.registerCommand("steer", {
    description: "Send guidance to yourself for a hands-free session. Usage: /steer <sessionId> <message>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /steer <sessionId> <message>", "error");
        return;
      }
      
      const sessionId = parts[0]!;
      const message = parts.slice(1).join(" ");
      
      // Inject immediately
      pi.sendMessage({
        customType: "user-guidance",
        content: `[USER GUIDANCE for session ${sessionId}]: ${message}

The user has sent you guidance. Please acknowledge and adjust accordingly.`,
        display: true,
        details: { sessionId, guidance: message, source: "command" },
      }, {
        deliverAs: "steer",
        triggerTurn: true,
      });
      
      ctx.ui.notify(`Guidance sent to session ${sessionId}`, "success");
    },
  });
}
