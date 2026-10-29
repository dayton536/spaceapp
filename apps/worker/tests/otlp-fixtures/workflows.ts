import { continueAsNew, executeChild, proxyActivities, workflowInfo } from "@temporalio/workflow";

/**
 * Workflows used only by the OTLP integration test. They do no tracing I/O;
 * spans come from the worker's interceptors and sink.
 */

interface WorkInput {
  traceparent?: string;
  traceId?: string;
  roomId?: string;
  paneId?: string;
  missionId?: string;
  prompt?: string;
  path?: string;
  url?: string;
  failUntilAttempt?: number;
}

interface ParentInput extends WorkInput {
  withChild?: boolean;
  continueOnce?: boolean;
}

const { work } = proxyActivities<{ work(input: WorkInput): Promise<string> }>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 4, initialInterval: "1 second" }
});

/** Child workflow: one activity, nested under whoever started it. */
export async function otlpChildWorkflow(input: WorkInput): Promise<string> {
  await work({ ...input, failUntilAttempt: 0 });
  return "child";
}

/** Parent workflow: a retried activity, an optional child, and an optional continue-as-new. */
export async function otlpParentWorkflow(input: ParentInput): Promise<string> {
  await work(input);
  if (input.withChild) {
    await executeChild(otlpChildWorkflow, {
      args: [{
        traceparent: input.traceparent,
        traceId: input.traceId,
        roomId: input.roomId,
        paneId: input.paneId,
        missionId: input.missionId,
        prompt: input.prompt,
        path: input.path,
        url: input.url
      }],
      workflowId: `${workflowInfo().workflowId}-child`
    });
  }
  if (input.continueOnce) {
    await continueAsNew<typeof otlpParentWorkflow>({ ...input, continueOnce: false, withChild: false, failUntilAttempt: 0 });
  }
  return "parent";
}

/** Starts a background continuation child (`trace:bg-…`) so the span link can be asserted. */
export async function otlpBackgroundWorkflow(input: { traceparent: string; prompt?: string }): Promise<string> {
  await executeChild(otlpChildWorkflow, {
    args: [{
      traceparent: input.traceparent,
      traceId: "trace:bg-0123456789abcdef",
      roomAgentContinuation: { sourceRunId: "agent_run:source0001", generation: 1 },
      prompt: input.prompt
    }],
    workflowId: `${workflowInfo().workflowId}-bg`
  });
  return "background";
}
