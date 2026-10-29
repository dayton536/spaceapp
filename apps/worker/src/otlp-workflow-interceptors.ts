import {
  ContinueAsNew,
  isCancellation,
  patched,
  proxySinks,
  workflowInfo,
  type Headers,
  type Next,
  type Sinks,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import {
  OTLP_HEADER,
  allowlistSpanAttributes,
  allowlistSpanLinks,
  decodeOtlpHeader,
  encodeOtlpHeader,
  isBackgroundContinuation,
  otlpSpanName,
  resolveWorkflowSpanContext,
  traceparentFromArgs,
  traceparentFromMemo,
  workflowCorrelationIds,
  workflowFailureCategory,
  workflowFailureCode,
  type OtlpCarrier,
  type OtlpCarrierMode,
  type OtlpWorkflowExport,
  type WorkflowSpanPlan
} from "./otlp-span-context.js";

/**
 * Workflow-sandbox interceptors. They record no I/O: the only way a span leaves
 * the sandbox is the `otlp.exportSpan` sink, which the worker registers with
 * `callDuringReplay: false`. Header changes are gated by `patched` so a history
 * recorded before export was enabled replays with the same commands.
 */

interface OtlpSinks extends Sinks {
  otlp: {
    exportSpan(span: OtlpWorkflowExport): void;
  };
}

const { otlp } = proxySinks<OtlpSinks>();

interface ActiveTrace {
  traceId: string;
  spanId: string;
  rootParentSpanId: string | null;
  propagate: boolean;
}

function carrier(active: ActiveTrace, mode: OtlpCarrierMode): OtlpCarrier {
  return {
    traceId: active.traceId,
    workflowSpanId: active.spanId,
    rootParentSpanId: active.rootParentSpanId,
    mode
  };
}

function withCarrier<T extends { headers: Headers }>(input: T, active: ActiveTrace, mode: OtlpCarrierMode): T {
  if (!active.propagate) return input;
  return { ...input, headers: { ...input.headers, [OTLP_HEADER]: encodeOtlpHeader(carrier(active, mode)) } };
}

/** Forwards the workflow span on activity, child and continue-as-new commands when this run opted in. */
function outbound(active: ActiveTrace): WorkflowOutboundCallsInterceptor {
  return {
    scheduleActivity: (input, next) => next(withCarrier(input, active, "activity")),
    scheduleLocalActivity: (input, next) => next(withCarrier(input, active, "activity")),
    startChildWorkflowExecution: (input, next) => next(withCarrier(input, active, "child")),
    continueAsNew: (input, next) => next(withCarrier(input, active, "continue_as_new"))
  };
}

function workflowOutcome(error: unknown): { outcome: string; failed: boolean; reasonCode: string | null } {
  if (error instanceof ContinueAsNew || (error instanceof Error && error.name === "ContinueAsNew")) {
    return { outcome: "CONTINUED", failed: false, reasonCode: null };
  }
  if (isCancellation(error)) return { outcome: "CANCELLED", failed: false, reasonCode: null };
  return { outcome: "FAILED", failed: true, reasonCode: workflowFailureCode(error) };
}

function emit(info: ReturnType<typeof workflowInfo>, plan: WorkflowSpanPlan, startedMs: number, endedMs: number, error: unknown, args: readonly unknown[]): void {
  const finished = error === undefined
    ? { outcome: "COMPLETED", failed: false, reasonCode: null as string | null }
    : workflowOutcome(error);
  const ids = workflowCorrelationIds(args);
  const category = workflowFailureCategory(finished.outcome, finished.reasonCode);
  const links = allowlistSpanLinks(plan.links);
  const exported: OtlpWorkflowExport = {
    traceId: plan.traceId,
    spanId: plan.spanId,
    parentSpanId: plan.parentSpanId,
    name: otlpSpanName("workflow", info.workflowType),
    startTimeMs: startedMs,
    endTimeMs: Math.max(startedMs, endedMs),
    attributes: allowlistSpanAttributes({
      "space.workflow_type": info.workflowType,
      "space.workflow_id": info.workflowId,
      "space.run_id": info.runId,
      "space.trace_id": ids.traceId,
      "space.room_id": ids.roomId,
      "space.pane_id": ids.paneId,
      "space.mission_id": ids.missionId,
      "space.attempt": info.attempt,
      "space.outcome": finished.outcome,
      "space.reason_code": finished.reasonCode,
      "space.category": category,
      "space.duration_ms": Math.max(0, endedMs - startedMs),
      "space.link_type": links.length ? plan.linkType : undefined
    }),
    error: finished.failed,
    links
  };
  try {
    otlp.exportSpan(exported);
  } catch {
    // A missing or failing sink must not fail the workflow.
  }
}

/** Opens one workflow span for this run and exports it when the run completes, continues, fails or cancels. */
async function executeWorkflowSpan(
  active: ActiveTrace,
  input: WorkflowExecuteInput,
  next: Next<WorkflowInboundCallsInterceptor, "execute">
): Promise<unknown> {
  const info = workflowInfo();
  // Histories that predate this marker keep their original commands.
  const propagate = patched("space-otlp-workflow-spans-v1");
  const traceparent = traceparentFromArgs(input.args) ?? traceparentFromMemo(info.memo);
  const plan = resolveWorkflowSpanContext({
    runId: info.runId,
    workflowType: info.workflowType,
    header: propagate ? decodeOtlpHeader(input.headers[OTLP_HEADER]) : null,
    traceparent,
    backgroundContinuation: isBackgroundContinuation(input.args)
  });
  active.traceId = plan.traceId;
  active.spanId = plan.spanId;
  active.rootParentSpanId = plan.parentSpanId;
  active.propagate = propagate;
  const startedMs = Date.now();
  let thrown: unknown = undefined;
  try {
    return await next(input);
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    emit(info, plan, startedMs, Date.now(), thrown, input.args);
  }
}

/** Workflow interceptor factory. Loaded only when span export is enabled. */
export function interceptors() {
  const active: ActiveTrace = { traceId: "", spanId: "", rootParentSpanId: null, propagate: false };
  return {
    inbound: [{ execute: (input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">) => executeWorkflowSpan(active, input, next) }],
    outbound: [outbound(active)]
  };
}
