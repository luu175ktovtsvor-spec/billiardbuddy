/**
 * Mock data for the AgentTeams demo view — replace with real API calls once
 * the four-column workspace consumes the live team/session data.
 */

// ─── Agent Teams ──────────────────────────────────────────────────
export const mockTeam = {
  name: 'session-dev',
  memberCount: 4,
  members: [
    { id: 'a1', role: 'Architect', status: 'completed' as const, color: '#16a34a' },
    { id: 'a2', role: 'Frontend Dev', status: 'running' as const, color: '#dc2626' },
    { id: 'a3', role: 'Backend Dev', status: 'running' as const, color: '#2563eb' },
    { id: 'a4', role: 'Tester', status: 'idle' as const, color: '#9333ea' },
  ],
}

export const mockTeamMessages = {
  userMessage: "Refactor the authentication middleware to support JWT and OAuth2 simultaneously. Ensure we have proper test coverage for the edge cases.",
  assistantMessage: "I've initiated the agent team for this task. The architect is designing the interface, while the developers are preparing the boilerplate for the new strategies.",
  systemInfo: `Info: spawning child_processes for parallel development
active: session-dev cluster initiated
ready: 4 agents assigned`,
}
