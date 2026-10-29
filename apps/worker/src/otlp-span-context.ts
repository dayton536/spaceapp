import { categorizeFailureCode, failureCategorySchema, isSafeErrorCode, parseTraceparent, type ParsedTraceparent } from "@space/contracts";

/**
 * Pure trace-context helpers shared by the workflow sandbox and the worker
 * process. No I/O: workflow code may call these, and the worker uses the same
 * rules so a replay computes the same span ids and headers.
 */

/** Temporal header that carries the workflow span to activities, children and continue-as-new. */
export const OTLP_HEADER = "space-otlp";

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;
const outcomes = new Set(["COMPLETED", "FAILED", "FAILED_RESULT", "CANCELLED", "CONTINUED"]);
const linkTypes = new Set(["continue_as_new", "background_continuation"]);
const maxDurationMs = 7 * 24 * 60 * 60 * 1000;
const nestedKeys = ["turn", "item", "input", "bridge", "turnInput"] as const;

/** How a caller workflow hands its span to the next execution. */
export type OtlpCarrierMode = "activity" | "child" | "continue_as_new";

/** Ids copied onto activity, child-workflow and continue-as-new headers. */
export interface OtlpCarrier {
  traceId: string;
  /** Span id of the workflow that wrote the header. */
  workflowSpanId: string;
  /** Parent of that workflow span (the API span, or null for a root). */
  rootParentSpanId: string | null;
  mode: OtlpCarrierMode;
}

/** One OTLP span link: the continued run or trace, ids only. */
export interface OtlpSpanLink {
  traceId: string;
  spanId: string;
}

/** Decision for the workflow span that the inbound interceptor exports. */
export interface WorkflowSpanPlan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  links: OtlpSpanLink[];
  linkType?: "continue_as_new" | "background_continuation";
}

/** Serializable span the workflow sink hands to the worker. Times are milliseconds, never bigints. */
export interface OtlpWorkflowExport {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, string | number>;
  error: boolean;
  links: OtlpSpanLink[];
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

function fnv1a(text: string): bigint {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash;
}

function hex(hash: bigint, width: number): string {
  return hash.toString(16).padStart(width, "0").slice(-width);
}

/** 16 hex chars derived from `material`. Stable across replay; never all zeros. */
export function deterministicSpanId(material: string): string {
  const id = hex(fnv1a(material), 16);
  return /^0+$/.test(id) ? "0000000000000001" : id;
}

/** 32 hex chars derived from `material`, for a workflow that has no propagated trace. */
export function deterministicTraceId(material: string): string {
  const id = `${hex(fnv1a(`trace\0${material}`), 16)}${hex(fnv1a(`trace-low\0${material}`), 16)}`;
  return /^0+$/.test(id) ? "00000000000000000000000000000001" : id;
}

/** True for a W3C trace id (32 lowercase hex chars, not all zeros). */
export function isW3cTraceId(value: unknown): value is string {
  return typeof value === "string" && traceIdPattern.test(value) && !/^0+$/.test(value);
}

/** True for a W3C span id (16 lowercase hex chars, not all zeros). */
export function isW3cSpanId(value: unknown): value is string {
  return typeof value === "string" && spanIdPattern.test(value) && !/^0+$/.test(value);
}

/** An identifier safe to export, or null. Free text, paths and URLs are rejected. */
export function otlpIdentifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value) ? value : null;
}

function boundedInt(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

function safeAttribute(key: string, value: unknown): string | number | null {
  switch (key) {
    case "space.attempt":
      return boundedInt(value, 1_000);
    case "space.duration_ms":
    case "space.queue_ms":
      return boundedInt(value, maxDurationMs);
    case "space.outcome":
      return typeof value === "string" && outcomes.has(value) ? value : null;
    case "space.link_type":
      return typeof value === "string" && linkTypes.has(value) ? value : null;
    case "space.reason_code":
      return isSafeErrorCode(value) ? value : null;
    case "space.category": {
      const parsed = failureCategorySchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    }
    case "space.trace_id":
    case "space.workflow_id":
    case "space.workflow_type":
    case "space.run_id":
    case "space.room_id":
    case "space.pane_id":
    case "space.mission_id":
    case "space.activity_type":
      return otlpIdentifier(value);
    default:
      return null;
  }
}

/**
 * Keeps only allowlisted span attributes. Prompts, model output, paths, URLs,
 * error messages and any other user text are dropped, including when stuffed
 * into an allowlisted key.
 */
export function allowlistSpanAttributes(input: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const safe = safeAttribute(key, value);
    if (safe !== null) attributes[key] = safe;
  }
  return attributes;
}

/** Span name from a workflow or activity type. Anything that is not an identifier becomes `unknown`. */
export function otlpSpanName(kind: "workflow" | "activity", typeName: string): string {
  const safe = otlpIdentifier(typeName);
  return safe ? `${kind} ${safe}` : `${kind} unknown`;
}

/** Drops links whose ids are not W3C trace and span ids. Link attributes are never kept. */
export function allowlistSpanLinks(links: readonly OtlpSpanLink[] | undefined): OtlpSpanLink[] {
  if (!links?.length) return [];
  return links.flatMap((link) => (
    isW3cTraceId(link.traceId) && isW3cSpanId(link.spanId) ? [{ traceId: link.traceId, spanId: link.spanId }] : []
  ));
}

/**
 * Payload bytes as a local Uint8Array. Workflow isolates fail `instanceof Uint8Array`
 * for buffers that crossed the sandbox boundary, so any array-like value is copied.
 */
function bytesOf(data: unknown): Uint8Array | null {
  if (data == null) return null;
  if (typeof data === "string") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.length ? bytes : null;
  }
  if (typeof data !== "object" || !("length" in data) || typeof data.length !== "number" || !Number.isInteger(data.length) || data.length < 0) {
    return null;
  }
  const view = data as ArrayLike<number>;
  const bytes = new Uint8Array(view.length);
  for (let index = 0; index < view.length; index += 1) bytes[index] = view[index] ?? 0;
  return bytes.length ? bytes : null;
}

/** Encodes a carrier as a JSON Temporal payload. The same bytes are decoded by the activity worker. */
export function encodeOtlpHeader(carrier: OtlpCarrier): { metadata: Record<string, Uint8Array>; data: Uint8Array } {
  return {
    metadata: { encoding: new TextEncoder().encode("json/plain") },
    data: new TextEncoder().encode(JSON.stringify(carrier))
  };
}

/** Decodes a carrier header. Returns null when the payload is missing or not a valid carrier. */
export function decodeOtlpHeader(payload: { data?: unknown } | null | undefined): OtlpCarrier | null {
  const bytes = bytesOf(payload?.data);
  if (!bytes?.length) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<OtlpCarrier>;
    if (parsed.mode !== "activity" && parsed.mode !== "child" && parsed.mode !== "continue_as_new") return null;
    if (!isW3cTraceId(parsed.traceId) || !isW3cSpanId(parsed.workflowSpanId)) return null;
    return {
      traceId: parsed.traceId,
      workflowSpanId: parsed.workflowSpanId,
      rootParentSpanId: isW3cSpanId(parsed.rootParentSpanId) ? parsed.rootParentSpanId : null,
      mode: parsed.mode
    };
  } catch {
    return null;
  }
}

function readNested(value: unknown, depth: number, visit: (record: Record<string, unknown>) => boolean): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    if (depth <= 0) return false;
    return value.some((entry) => readNested(entry, depth - 1, visit));
  }
  const record = value as Record<string, unknown>;
  if (visit(record)) return true;
  if (depth <= 0) return false;
  return nestedKeys.some((key) => readNested(record[key], depth - 1, visit));
}

/** First valid traceparent in workflow or activity arguments (identifiers only; prompts are never read). */
export function traceparentFromArgs(args: readonly unknown[]): ParsedTraceparent | null {
  let found: ParsedTraceparent | null = null;
  readNested(args, 4, (record) => {
    const parsed = parseTraceparent(record.traceparent);
    if (!parsed) return false;
    found = parsed;
    return true;
  });
  return found;
}

/**
 * True when an argument is a background continuation (`trace:bg-…` or
 * `roomAgentContinuation`). The prompt and other text on that object are not read.
 */
export function isBackgroundContinuation(args: readonly unknown[]): boolean {
  return readNested(args, 4, (record) => {
    if (typeof record.traceId === "string" && record.traceId.startsWith("trace:bg-")) return true;
    const continuation = record.roomAgentContinuation;
    return Boolean(continuation && typeof continuation === "object");
  });
}

/** Allowlisted ids from workflow arguments, for span attributes. */
export function workflowCorrelationIds(args: readonly unknown[]): { traceId?: string; roomId?: string; paneId?: string; missionId?: string } {
  const found: { traceId?: string; roomId?: string; paneId?: string; missionId?: string } = {};
  readNested(args, 4, (record) => {
    if (!found.traceId) {
      const traceId = otlpIdentifier(record.traceId);
      if (traceId) found.traceId = traceId;
    }
    if (!found.roomId) {
      const roomId = otlpIdentifier(record.roomId);
      if (roomId) found.roomId = roomId;
    }
    if (!found.paneId) {
      const paneId = otlpIdentifier(record.paneId);
      if (paneId) found.paneId = paneId;
    }
    if (!found.missionId) {
      const missionId = otlpIdentifier(record.missionId) ?? otlpIdentifier(record.roomAgentMissionId);
      if (missionId) found.missionId = missionId;
    }
    return Boolean(found.traceId && found.roomId && found.paneId && found.missionId);
  });
  return found;
}

/** Traceparent stored on the Temporal memo, if the API put one there. */
export function traceparentFromMemo(memo: Record<string, unknown> | undefined): ParsedTraceparent | null {
  return parseTraceparent(memo?.traceparent);
}

function linkTo(traceId: string, spanId: string): OtlpSpanLink[] {
  return isW3cTraceId(traceId) && isW3cSpanId(spanId) ? [{ traceId, spanId }] : [];
}

/**
 * Chooses the workflow span's trace, parent and links.
 *
 * A propagated traceparent parents the span to that span id. A child workflow
 * with no trace of its own nests under the caller. Continue-as-new keeps the
 * original parent and links the previous run. A background continuation links
 * the trace it continues.
 */
export function resolveWorkflowSpanContext(input: {
  runId: string;
  workflowType: string;
  header: OtlpCarrier | null;
  traceparent: ParsedTraceparent | null;
  backgroundContinuation: boolean;
}): WorkflowSpanPlan {
  const spanId = deterministicSpanId(`${input.runId}\0${input.workflowType}`);
  const header = input.header;
  const traceparent = input.traceparent;
  const headerSpan = header && isW3cTraceId(header.traceId) && isW3cSpanId(header.workflowSpanId) ? header : null;

  if (headerSpan?.mode === "continue_as_new") {
    return {
      traceId: headerSpan.traceId,
      spanId,
      parentSpanId: headerSpan.rootParentSpanId,
      links: linkTo(headerSpan.traceId, headerSpan.workflowSpanId),
      linkType: "continue_as_new"
    };
  }

  if (traceparent && headerSpan && headerSpan.traceId !== traceparent.traceId) {
    return {
      traceId: traceparent.traceId,
      spanId,
      parentSpanId: traceparent.parentId,
      links: linkTo(headerSpan.traceId, headerSpan.workflowSpanId),
      linkType: input.backgroundContinuation ? "background_continuation" : undefined
    };
  }

  if (headerSpan?.mode === "child") {
    const continued = input.backgroundContinuation
      ? (traceparent ? linkTo(traceparent.traceId, traceparent.parentId) : linkTo(headerSpan.traceId, headerSpan.workflowSpanId))
      : [];
    return {
      traceId: headerSpan.traceId,
      spanId,
      parentSpanId: headerSpan.workflowSpanId,
      links: continued,
      linkType: continued.length ? "background_continuation" : undefined
    };
  }

  if (traceparent) {
    const links = input.backgroundContinuation && headerSpan ? linkTo(headerSpan.traceId, headerSpan.workflowSpanId) : [];
    return {
      traceId: traceparent.traceId,
      spanId,
      parentSpanId: traceparent.parentId,
      links,
      linkType: links.length ? "background_continuation" : undefined
    };
  }

  return {
    traceId: deterministicTraceId(input.runId),
    spanId,
    parentSpanId: null,
    links: []
  };
}

/** Stable error code from a workflow failure chain. Messages are never read. */
export function workflowFailureCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { type?: unknown; code?: unknown; cause?: unknown };
    if (isSafeErrorCode(record.type)) return record.type;
    if (isSafeErrorCode(record.code)) return record.code;
    current = record.cause;
  }
  return null;
}

/** Category for a workflow outcome. Failures use the shared code map; cancellation is CANCELLED. */
export function workflowFailureCategory(outcome: string, reasonCode: string | null): string | null {
  if (outcome === "CANCELLED") return "CANCELLED";
  if (outcome === "FAILED") return categorizeFailureCode(reasonCode);
  return null;
}
