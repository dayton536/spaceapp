import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InjectedSinks, WorkerOptions } from "@temporalio/worker";
import type { Sinks } from "@temporalio/workflow";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { allowlistSpanAttributes, allowlistSpanLinks, isW3cSpanId, isW3cTraceId, type OtlpWorkflowExport } from "./otlp-span-context.js";

/**
 * Worker-process side of workflow span export. The sink only enqueues a span;
 * it never waits on the collector, so a slow or failing export cannot delay a
 * workflow task. `callDuringReplay: false` keeps replay from emitting again.
 */

interface OtlpWorkflowSinks extends Sinks {
  otlp: {
    exportSpan(span: OtlpWorkflowExport): void;
  };
}

/** Converts a sandbox export into a server span, or null when its ids are not W3C ids. */
export function workflowExportToSpan(exported: OtlpWorkflowExport): ServerSpan | null {
  if (!isW3cTraceId(exported.traceId) || !isW3cSpanId(exported.spanId)) return null;
  const startMs = Number.isFinite(exported.startTimeMs) ? Math.max(0, Math.round(exported.startTimeMs)) : 0;
  const endMs = Number.isFinite(exported.endTimeMs) ? Math.max(startMs, Math.round(exported.endTimeMs)) : startMs;
  const parentSpanId = isW3cSpanId(exported.parentSpanId) ? exported.parentSpanId : null;
  return {
    traceId: exported.traceId,
    spanId: exported.spanId,
    parentSpanId,
    name: exported.name,
    startTimeUnixNano: BigInt(startMs) * 1_000_000n,
    endTimeUnixNano: BigInt(endMs) * 1_000_000n,
    attributes: allowlistSpanAttributes(exported.attributes),
    error: exported.error === true,
    kind: 1,
    links: allowlistSpanLinks(exported.links)
  };
}

/**
 * Sink implementations for one worker process. The function returns immediately
 * after `record`, which only queues the span.
 */
export function createOtlpWorkflowSinks(spans: SpanExporter): InjectedSinks<OtlpWorkflowSinks> {
  return {
    otlp: {
      exportSpan: {
        fn(_info, exported) {
          const span = workflowExportToSpan(exported);
          if (span) spans.record(span);
        },
        callDuringReplay: false
      }
    }
  };
}

/**
 * Path of the workflow interceptor module. Compiled workers load the `.js`
 * sibling; a source checkout (no build yet) loads the `.ts` file.
 */
export function otlpWorkflowInterceptorsPath(): string {
  const compiled = fileURLToPath(new URL("./otlp-workflow-interceptors.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  const source = compiled.replace(/\.js$/, ".ts");
  return existsSync(source) ? source : compiled;
}

/**
 * Activity interceptors plus, when `spans` is set, the workflow interceptor
 * module and the export sink. When `spans` is null the worker exports nothing
 * and does not load the workflow interceptor.
 */
export function workerOtlpWorkerOptions(spans: SpanExporter | null): Pick<WorkerOptions, "interceptors" | "sinks"> {
  const interceptors: NonNullable<WorkerOptions["interceptors"]> = {
    activity: [createActivityObservabilityInterceptors({ spans })]
  };
  if (!spans) return { interceptors };
  interceptors.workflowModules = [otlpWorkflowInterceptorsPath()];
  return { interceptors, sinks: createOtlpWorkflowSinks(spans) };
}
