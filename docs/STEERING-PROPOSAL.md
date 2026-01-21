# Proposal: User Steering for Hands-Free Sessions

## Problem

When the user sees the agent struggling in a hands-free session, they have no way to redirect the agent without fully taking over. Current options:

1. **Take over** → User types directly to subprocess, agent is passive
2. **Kill** → Abort and restart with different instructions
3. **Do nothing** → Watch the agent flail

None of these allow the user to **guide** the agent while it continues working.

## Proposed Solution: Steering Notes

Add a mechanism for users to leave notes that the controlling agent sees on status queries.

### UX: User Side

When viewing a hands-free session, user can press a hotkey (e.g., `Ctrl+N`) to open a "note to agent" prompt:

```
╭─────────────────────────────────────────────────────╮
│ pi "Fix the bugs"                          PID: 123 │
│ 🤖 Hands-free (2m 34s) • Type anything to take over │
├─────────────────────────────────────────────────────┤
│ > Working on auth.ts...                             │
│ > Found 3 issues...                                 │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ 📝 Note to agent (Enter to send, Esc to cancel) │ │
│ │ > Look at user.ts too, there's a related bug_   │ │
│ └─────────────────────────────────────────────────┘ │
╰─────────────────────────────────────────────────────╯
```

The note is stored but does NOT:
- Trigger user takeover
- Send anything to the subprocess

### UX: Agent Side

When the controlling agent queries status, they see the note:

```typescript
interactive_shell({ sessionId: "calm-reef" })
// Returns:
{
  status: "running",
  output: "Working on auth.ts...",
  runtime: 154000,
  userNote: "Look at user.ts too, there's a related bug",  // ← NEW
  userNoteAt: 1706123456789  // ← timestamp
}
```

The agent can then:
1. Acknowledge the note
2. Send input to the subprocess based on the guidance
3. Clear the note after reading

### API Additions

```typescript
// Query returns userNote if present
interface StatusQueryResult {
  // ... existing fields ...
  userNote?: string;
  userNoteAt?: number;  // Unix timestamp when note was set
}

// Agent can clear the note after reading
interactive_shell({ 
  sessionId: "calm-reef", 
  clearNote: true  // Acknowledge receipt
})

// Or replace with agent's own note back to user
interactive_shell({
  sessionId: "calm-reef",
  agentNote: "Got it, looking at user.ts now"  // User sees in overlay
})
```

### Overlay Display

When agent sends an `agentNote`, user sees it:

```
╭─────────────────────────────────────────────────────╮
│ pi "Fix the bugs"                          PID: 123 │
│ 🤖 Hands-free (3m 12s) • Type anything to take over │
│ 💬 Agent: Got it, looking at user.ts now            │ ← Agent's response
├─────────────────────────────────────────────────────┤
```

## Implementation Sketch

### overlay-component.ts changes

```typescript
// New state
private userNote: string | null = null;
private userNoteAt: number | null = null;
private agentNote: string | null = null;

// New method for user to set note
private openNoteInput(): void {
  // Opens mini input field, collects note, stores in userNote
  // Does NOT trigger takeover
}

// Modified getStatus to include notes
getSessionStatus() {
  return {
    status: this.getStatusString(),
    userNote: this.userNote,
    userNoteAt: this.userNoteAt,
    agentNote: this.agentNote,
  };
}
```

### Hotkey

- `Ctrl+N` → Open note input (doesn't trigger takeover)
- `Shift+Up/Down` → Scroll (already doesn't trigger takeover)

## Alternative: Simpler File-Based Approach

If implementation complexity is a concern, a simpler approach:

1. Document a convention: `~/.pi/agent/steer-{sessionId}.txt`
2. User writes notes there manually
3. Agent checks the file periodically

Pros: No code changes needed
Cons: Requires user to know the convention, more friction

## Recommendation

Implement the note feature. It's:
- Non-intrusive (optional hotkey)
- Doesn't disrupt hands-free operation
- Provides clear feedback loop
- Low implementation complexity (mostly UI work)
