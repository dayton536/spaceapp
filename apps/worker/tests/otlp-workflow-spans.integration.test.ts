import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { deterministicSpanId } from "../src/otlp-span-context.js";
import { createOtlpWorkflowSinks, otlpWorkflowInterceptorsPath } from "../src/worker-otlp.js";

/**
 * One real Temporal time-skipping server and a loopback OTLP collector.
 * Workflow code under test does no tracing I/O; the production interceptors do.
 */

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiSpanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${apiSpanId}-01`;
const secret = "SECRET USER PROMPT sk-live-otlp-secret /tmp/private/notes.txt https://user.example/secret";
const workflowsPath = fileURLToPath(new URL("./otlp-fixtures/workflows.ts", import.meta.url));

interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes?: Array<{ key: string; value?: { stringValue?: string; intValue?: string } }>;
  links?: Array<{ traceId: string; spanId: string; attributes?: unknown }>;
  status?: { code?: number };
}

const collected: CollectedSpan[] = [];
let server: ReturnType<typeof createServer> | undefined;
let exporter: SpanExporter | undefined;
let env: TestWorkflowEnvironment | undefined;
let collectorUrl = "";

function attr(span: CollectedSpan, key: string): string | undefined {
  const found = span.attributes?.find((entry) => entry.key === key);
  return found?.value?.stringValue ?? found?.value?.intValue;
}

async function listen(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: CollectedSpan[] }> }>;
      };
      for (const resource of body.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans ?? []) collected.push(...(scope.spans ?? []));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  collectorUrl = `http://127.0.0.1:${port}`;
}

async function run(workflowType: string, workflowId: string, args: unknown[]) {
  const taskQueue = `otlp-${workflowId}`;
  const worker = await Worker.create({
    connection: env!.nativeConnection,
    namespace: env!.namespace ?? "default",
    taskQueue,
    workflowsPath,
    activities: {
      async work(input: { failUntilAttempt?: number; prompt?: string }) {
        const attempt = Context.current().info.attempt;
        if ((input.failUntilAttempt ?? 0) > attempt) {
          throw Object.assign(new Error(`database exploded ${secret}`), { code: "TOOL_UNAVAILABLE" });
        }
        return "ok";
      }
    },
    interceptors: {
      activity: [createActivityObservabilityInterceptors({ spans: exporter })],
      workflowModules: [otlpWorkflowInterceptorsPath()]
    },
    sinks: createOtlpWorkflowSinks(exporter!)
  });
  const handle = await env!.client.workflow.start(workflowType, { taskQueue, workflowId, args });
  await worker.runUntil(handle.result());
  await exporter!.flush();
  return handle;
}

describe("OTLP workflow and activity spans", () => {
  beforeAll(async () => {
    await listen();
    exporter = createOtlpSpanExporter({
      endpoint: collectorUrl,
      serviceName: "space-worker",
      flushIntervalMs: 60_000
    });
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 180_000);

  afterAll(async () => {
    await exporter?.close();
    await env?.teardown();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it("connects the API span, the workflow, each activity attempt and a nested child", async () => {
    const start = collected.length;
    const workflowId = "otlp-parent-tree";
    const handle = await run("otlpParentWorkflow", workflowId, [{
      traceparent,
      traceId: "req:otlptest0001",
      roomId: "room:alpha01",
      paneId: "pane:alpha01",
      missionId: "mission:1",
      prompt: secret,
      path: "/tmp/private/notes.txt",
      url: "https://user.example/secret",
      failUntilAttempt: 2,
      withChild: true
    }]);
    const spans = collected.slice(start);
    const body = JSON.stringify(spans);
    expect(body).not.toMatch(/SECRET|sk-live-otlp-secret|notes\.txt|user\.example|database exploded/);

    const runId = handle.firstExecutionRunId;
    expect(runId).toBeTruthy();
    const workflowSpanId = deterministicSpanId(`${runId}\0otlpParentWorkflow`);
    const workflow = spans.find((span) => span.spanId === workflowSpanId);
    expect(workflow).toMatchObject({ traceId, parentSpanId: apiSpanId, name: "workflow otlpParentWorkflow" });
    expect(attr(workflow!, "space.outcome")).toBe("COMPLETED");
    expect(attr(workflow!, "space.room_id")).toBe("room:alpha01");
    expect(attr(workflow!, "space.mission_id")).toBe("mission:1");
    expect(attr(workflow!, "space.workflow_type")).toBe("otlpParentWorkflow");
    expect(workflow!.links ?? []).toEqual([]);

    const attempts = spans.filter((span) => span.name === "activity work" && span.parentSpanId === workflowSpanId);
    expect(attempts.map((span) => attr(span, "space.attempt")).sort()).toEqual(["1", "2"]);
    const failed = attempts.find((span) => attr(span, "space.attempt") === "1");
    const succeeded = attempts.find((span) => attr(span, "space.attempt") === "2");
    expect(failed).toMatchObject({ traceId, status: { code: 2 } });
    expect(attr(failed!, "space.outcome")).toBe("FAILED");
    expect(attr(failed!, "space.reason_code")).toBe("TOOL_UNAVAILABLE");
    expect(attr(failed!, "space.category")).toBe("TOOL_UNAVAILABLE");
    expect(attr(succeeded!, "space.outcome")).toBe("COMPLETED");
    expect(succeeded!.status?.code ?? 0).toBe(0);

    const child = spans.find((span) => span.name === "workflow otlpChildWorkflow");
    expect(child).toMatchObject({ traceId, parentSpanId: workflowSpanId });
    const childActivity = spans.find((span) => span.name === "activity work" && span.parentSpanId === child!.spanId);
    expect(childActivity).toMatchObject({ traceId });
    expect(attr(childActivity!, "space.attempt")).toBe("1");
    expect(spans.every((span) => span.traceId === traceId)).toBe(true);
  }, 180_000);

  it("links continue-as-new to the previous run and a background continuation to the trace it continues", async () => {
    const start = collected.length;
    const continued = await run("otlpParentWorkflow", "otlp-parent-continue", [{
      traceparent, traceId: "req:otlptest0002", prompt: secret, continueOnce: true
    }]);
    const described = await continued.describe();
    const firstSpanId = deterministicSpanId(`${continued.firstExecutionRunId}\0otlpParentWorkflow`);
    const nextSpanId = deterministicSpanId(`${described.runId}\0otlpParentWorkflow`);
    expect(nextSpanId).not.toBe(firstSpanId);
    const spans = collected.slice(start);
    const next = spans.find((span) => span.spanId === nextSpanId);
    const first = spans.find((span) => span.spanId === firstSpanId);
    expect(first).toMatchObject({ traceId, parentSpanId: apiSpanId });
    expect(attr(first!, "space.outcome")).toBe("CONTINUED");
    expect(next).toMatchObject({ traceId, parentSpanId: apiSpanId });
    expect(next!.links).toEqual([{ traceId, spanId: firstSpanId }]);
    expect(attr(next!, "space.link_type")).toBe("continue_as_new");

    const beforeBackground = collected.length;
    await run("otlpBackgroundWorkflow", "otlp-background", [{ traceparent, prompt: secret }]);
    const background = collected.slice(beforeBackground);
    const parent = background.find((span) => span.name === "workflow otlpBackgroundWorkflow");
    const child = background.find((span) => span.name === "workflow otlpChildWorkflow");
    expect(parent).toMatchObject({ traceId, parentSpanId: apiSpanId });
    expect(child).toMatchObject({ traceId, parentSpanId: parent!.spanId });
    expect(child!.links).toEqual([{ traceId, spanId: apiSpanId }]);
    expect(attr(child!, "space.link_type")).toBe("background_continuation");
    expect(attr(child!, "space.trace_id")).toBe("trace:bg-0123456789abcdef");
    expect(JSON.stringify(background)).not.toMatch(/SECRET|sk-live-otlp-secret|user\.example/);
  }, 180_000);

  it("emits no spans when a recorded history is replayed", async () => {
    const workflowId = "otlp-parent-replay";
    const handle = await run("otlpParentWorkflow", workflowId, [{
      traceparent, traceId: "req:otlptest0003", prompt: secret, failUntilAttempt: 2, withChild: true
    }]);
    const before = collected.length;
    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({
      workflowsPath,
      interceptors: { workflowModules: [otlpWorkflowInterceptorsPath()] },
      sinks: createOtlpWorkflowSinks(exporter!)
    }, history, workflowId);
    await exporter!.flush();
    expect(collected).toHaveLength(before);
  }, 180_000);
});
