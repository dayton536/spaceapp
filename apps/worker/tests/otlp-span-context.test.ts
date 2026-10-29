import { describe, expect, it } from "vitest";
import { otlpTraceRequest, type ServerSpan } from "@space/runtime";
import {
  allowlistSpanAttributes,
  allowlistSpanLinks,
  decodeOtlpHeader,
  deterministicSpanId,
  deterministicTraceId,
  encodeOtlpHeader,
  isBackgroundContinuation,
  otlpSpanName,
  resolveWorkflowSpanContext,
  traceparentFromArgs
} from "../src/otlp-span-context.js";
import { workerOtlpWorkerOptions, workflowExportToSpan } from "../src/worker-otlp.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;
const secret = "SECRET USER PROMPT sk-live-otlp /tmp/private/notes.txt https://user.example/secret please summarize this";

describe("span attribute allowlist", () => {
  it("keeps ids, types, attempt, outcome, codes and durations and drops everything else", () => {
    const attributes = allowlistSpanAttributes({
      "space.trace_id": "req:abcdefghijkl",
      "space.workflow_id": "workflow:codex:room:a",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.run_id": "11111111-2222-3333-4444-555555555555",
      "space.room_id": "room:alpha01",
      "space.pane_id": "pane:alpha01",
      "space.mission_id": "mission:1",
      "space.activity_type": "runCodexAppServerTurn",
      "space.attempt": 2,
      "space.outcome": "FAILED",
      "space.reason_code": "TOOL_UNAVAILABLE",
      "space.category": "TOOL_UNAVAILABLE",
      "space.duration_ms": 150,
      "space.queue_ms": 20,
      "space.link_type": "continue_as_new",
      "space.prompt": secret,
      "http.url": "https://user.example/secret",
      "error.message": secret,
      "space.reason_code_text": "database said /tmp/private/notes.txt",
      "space.room_id_raw": "room alpha has a space",
      note: secret
    });
    // A bad reason code on the allowlisted key is rejected; the safe one above is kept.
    expect(allowlistSpanAttributes({ "space.reason_code": "database said /tmp/private/notes.txt", "space.category": "not a category", "space.outcome": "user text", "space.attempt": -1, "space.duration_ms": 1.5 })).toEqual({});
    expect(attributes).toEqual({
      "space.trace_id": "req:abcdefghijkl",
      "space.workflow_id": "workflow:codex:room:a",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.run_id": "11111111-2222-3333-4444-555555555555",
      "space.room_id": "room:alpha01",
      "space.pane_id": "pane:alpha01",
      "space.mission_id": "mission:1",
      "space.activity_type": "runCodexAppServerTurn",
      "space.attempt": 2,
      "space.outcome": "FAILED",
      "space.reason_code": "TOOL_UNAVAILABLE",
      "space.category": "TOOL_UNAVAILABLE",
      "space.duration_ms": 150,
      "space.queue_ms": 20,
      "space.link_type": "continue_as_new"
    });
    const wire = JSON.stringify({ attributes, name: otlpSpanName("workflow", secret), links: allowlistSpanLinks([{ traceId, spanId: parentId }, { traceId: secret, spanId: parentId }]) });
    expect(wire).not.toMatch(/SECRET|sk-live|notes\.txt|user\.example|please summarize/);
    expect(otlpSpanName("workflow", secret)).toBe("workflow unknown");
    expect(otlpSpanName("activity", "runTurn")).toBe("activity runTurn");
  });

  it("does not put link attributes on the OTLP request", () => {
    const span: ServerSpan = {
      traceId,
      spanId: "a1b2c3d4e5f60718",
      parentSpanId: parentId,
      name: "workflow codexAppServerTurnWorkflow",
      startTimeUnixNano: 1n,
      endTimeUnixNano: 2n,
      attributes: { "space.outcome": "CONTINUED" },
      error: false,
      kind: 1,
      links: [{ traceId, spanId: parentId }]
    };
    const body = otlpTraceRequest([span], "space-worker");
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.links).toEqual([{ traceId, spanId: parentId }]);
  });
});

describe("workflow span context", () => {
  const runId = "run-1111-2222";
  const workflowType = "codexAppServerTurnWorkflow";

  it("parents a workflow to the propagated traceparent", () => {
    const plan = resolveWorkflowSpanContext({
      runId, workflowType, header: null,
      traceparent: { traceId, parentId, flags: "01" },
      backgroundContinuation: false
    });
    expect(plan.traceId).toBe(traceId);
    expect(plan.parentSpanId).toBe(parentId);
    expect(plan.links).toEqual([]);
    expect(plan.spanId).toBe(deterministicSpanId(`${runId}\0${workflowType}`));
    expect(plan.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("nests a child workflow under its parent and links a background continuation to the continued trace", () => {
    const parent = resolveWorkflowSpanContext({
      runId: "supervisor-run", workflowType: "roomAgentSupervisorWorkflow", header: null,
      traceparent: { traceId, parentId, flags: "01" },
      backgroundContinuation: false
    });
    const child = resolveWorkflowSpanContext({
      runId: "child-run", workflowType: "memoryConsolidationWorkflow",
      header: { traceId, workflowSpanId: parent.spanId, rootParentSpanId: parentId, mode: "child" },
      traceparent: null,
      backgroundContinuation: false
    });
    expect(child.traceId).toBe(traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.links).toEqual([]);

    const continuation = resolveWorkflowSpanContext({
      runId: "bg-run", workflowType: "codexAppServerTurnWorkflow",
      header: { traceId, workflowSpanId: parent.spanId, rootParentSpanId: parentId, mode: "child" },
      traceparent: { traceId, parentId, flags: "01" },
      backgroundContinuation: true
    });
    expect(continuation.parentSpanId).toBe(parent.spanId);
    expect(continuation.links).toEqual([{ traceId, spanId: parentId }]);
    expect(continuation.linkType).toBe("background_continuation");
    expect(isBackgroundContinuation([{ turn: { traceId: "trace:bg-0123456789abcdef", prompt: secret } }])).toBe(true);
    expect(isBackgroundContinuation([{ prompt: secret }])).toBe(false);
  });

  it("links a continue-as-new run to the previous run and keeps the original parent", () => {
    const first = deterministicSpanId(`previous\0${workflowType}`);
    const next = resolveWorkflowSpanContext({
      runId: "next-run", workflowType,
      header: { traceId, workflowSpanId: first, rootParentSpanId: parentId, mode: "continue_as_new" },
      traceparent: { traceId, parentId, flags: "01" },
      backgroundContinuation: false
    });
    expect(next.parentSpanId).toBe(parentId);
    expect(next.links).toEqual([{ traceId, spanId: first }]);
    expect(next.linkType).toBe("continue_as_new");
    expect(deterministicTraceId("same")).toBe(deterministicTraceId("same"));
    expect(deterministicTraceId("same")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("round-trips a carrier header and reads a traceparent without reading prompts", () => {
    const encoded = encodeOtlpHeader({ traceId, workflowSpanId: parentId, rootParentSpanId: null, mode: "activity" });
    expect(decodeOtlpHeader(encoded)).toEqual({ traceId, workflowSpanId: parentId, rootParentSpanId: null, mode: "activity" });
    // Workflow isolates do not share Node's Uint8Array, so a copied array must still decode.
    expect(decodeOtlpHeader({ data: Array.from(encoded.data) })).toEqual({ traceId, workflowSpanId: parentId, rootParentSpanId: null, mode: "activity" });
    expect(decodeOtlpHeader(undefined)).toBeNull();
    expect(traceparentFromArgs([{ turn: { traceparent, prompt: secret } }])).toEqual({ traceId, parentId, flags: "01" });
    expect(JSON.stringify(traceparentFromArgs([{ prompt: secret }]))).not.toContain("SECRET");
  });
});

describe("worker export wiring", () => {
  it("exports nothing and loads no workflow interceptor when the exporter is off", () => {
    const options = workerOtlpWorkerOptions(null);
    expect(options.sinks).toBeUndefined();
    expect(options.interceptors?.workflowModules).toBeUndefined();
    expect(options.interceptors?.activity).toHaveLength(1);
  });

  it("turns a workflow export into an INTERNAL span and drops a bad trace id", () => {
    const span = workflowExportToSpan({
      traceId, spanId: parentId, parentSpanId: "1111111111111111",
      name: "workflow codexAppServerTurnWorkflow",
      startTimeMs: 10, endTimeMs: 40,
      attributes: { "space.outcome": "COMPLETED", "space.prompt": secret },
      error: false,
      links: [{ traceId, spanId: "2222222222222222" }]
    });
    expect(span).toMatchObject({ kind: 1, parentSpanId: "1111111111111111", startTimeUnixNano: 10_000_000n, endTimeUnixNano: 40_000_000n });
    expect(span?.attributes).toEqual({ "space.outcome": "COMPLETED" });
    expect(span?.links).toEqual([{ traceId, spanId: "2222222222222222" }]);
    expect(workflowExportToSpan({
      traceId: "nope", spanId: parentId, parentSpanId: null, name: "workflow x",
      startTimeMs: 0, endTimeMs: 0, attributes: {}, error: false, links: []
    })).toBeNull();
  });
});
