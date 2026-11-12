"use client";
import type {
  AgAiHarness,
  AgAiChatSession,
  AgAiChatMessage,
  AgAiAgentDescriptor,
  AgAiThreadSummary,
} from "ag-studio";
/** AG Studio's supported custom-harness surface; server Workflow owns inference and durable history. */
export function createWorkStudioHarness(
  workId: string,
  api: (body: unknown) => Promise<unknown>,
  getRevision: () => number,
): AgAiHarness & { sync: (requests: any[]) => void } {
  const listeners = new Set<(event: { type: "changed" }) => void>(),
    sessions = new Set<(event: { type: "changed" }) => void>();
  let messages: AgAiChatMessage[] = [],
    busy = false;
  const agents: AgAiAgentDescriptor[] = [
    {
      id: "workspace",
      name: "Workspace agent",
      available: true,
      userFacing: true,
    },
  ];
  const threads: AgAiThreadSummary[] = [
    {
      threadId: workId,
      agentId: "workspace",
      title: "Workspace",
      updatedAt: 0,
    },
  ];
  const emit = () => {
    for (const cb of sessions) cb({ type: "changed" });
    for (const cb of listeners) cb({ type: "changed" });
  };
  const session: AgAiChatSession = {
    threadId: workId,
    get messages() {
      return messages;
    },
    get status() {
      return busy ? "running" : "idle";
    },
    artifacts: [],
    addEventListener: (_t, fn) => {
      sessions.add(fn);
    },
    removeEventListener: (_t, fn) => {
      sessions.delete(fn);
    },
    sendMessage(text) {
      busy = true;
      emit();
      void api({
        action: "request",
        id: crypto.randomUUID(),
        workId,
        expectedRevision: getRevision(),
        prompt: text,
      }).catch((e) => {
        messages = [
          ...messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            createdAt: Date.now(),
            parts: [{ type: "error", message: String(e) }],
          },
        ];
        busy = false;
        emit();
      });
    },
    cancel() {
      /* UI cancellation is routed by persisted running request identity on sync. */ void api(
        { action: "cancel_latest" },
      ).finally(() => {
        busy = false;
        emit();
      });
    },
    close() {
      sessions.clear();
    },
  };
  return {
    agents,
    threads,
    getAgent: (id) => agents.find((a) => a.id === id),
    getThread: (id) => threads.find((t) => t.threadId === id),
    openThread: async (id) => {
      if (id !== workId) throw new Error("Thread not found");
      return session;
    },
    createThread: async () => session,
    deleteThread: async () => {
      throw new Error("Workspace history is retained");
    },
    getSession: (id) => (id === workId ? session : undefined),
    addEventListener: (_t, fn) => {
      listeners.add(fn);
    },
    removeEventListener: (_t, fn) => {
      listeners.delete(fn);
    },
    dispose() {
      listeners.clear();
      sessions.clear();
    },
    sync(requests) {
      messages = requests.flatMap(
        (r) =>
          [
            {
              id: r.id + ":user",
              role: "user",
              createdAt: new Date(r.created_at).getTime(),
              parts: [{ type: "text", text: r.prompt }],
            },
            ...(r.output
              ? [
                  {
                    id: r.id + ":assistant",
                    role: "assistant",
                    createdAt: new Date(r.created_at).getTime() + 1,
                    parts: [{ type: "text", text: r.output.message }],
                  },
                ]
              : r.status === "failed"
                ? [
                    {
                      id: r.id + ":error",
                      role: "assistant",
                      createdAt: new Date(r.created_at).getTime() + 1,
                      parts: [{ type: "error", message: r.error_code }],
                    },
                  ]
                : []),
          ] as AgAiChatMessage[],
      );
      busy = requests.some((r) => ["queued", "running"].includes(r.status));
      emit();
    },
  };
}
