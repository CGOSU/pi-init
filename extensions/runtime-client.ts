import { createConnection } from "node:net";

import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeWireError,
  decodeRuntimeResponse,
  encodeRequest,
} from "./runtime-wire.ts";
import type { RuntimeCommand, RuntimeResponse } from "./runtime-wire.ts";
import {
  createRuntimeClientConfig,
} from "./runtime-client-config.ts";
import type { RuntimeClientConfig } from "./runtime-client-config.ts";

type RequestOptions = Readonly<{
  requestId?: string;
}>;
type GraphRevisionInput = Readonly<{
  graphId?: string;
  graph_id?: string;
  revision: number;
}>;
type QueryGraphInput = Readonly<{
  graphId: string;
  revision?: number;
}>;
type ReadEventsInput = Readonly<{
  graphId: string;
  afterEventId?: number;
  limit?: number;
}>;
type ReadEventsOptions = Readonly<{
  afterEventId?: number;
  limit?: number;
}>;
type AcknowledgeEventsInput = Readonly<{
  graphId: string;
  eventId: number;
}>;
type CancelAttemptInput = Readonly<{
  graphRevision: GraphRevisionInput;
  attemptId: string;
  leaseEpoch: number;
  reason: string;
}>;
type RetryTaskInput = Readonly<{
  graphRevision: GraphRevisionInput;
  taskId: string;
  reason?: string;
}>;

type ClientErrorOptions = Readonly<{
  requestId?: string;
  retryable?: boolean;
  cause?: unknown;
}>;

const CLIENT_INSTANCE_ID = `pi-init-${process.pid}-${Date.now().toString(36)}`;
let nextClientInstance = 0;
const MAX_EVENT_LIMIT = 1000;

class RuntimeClientError extends Error {
  code: string;
  requestId?: string;
  retryable: boolean;
  cause: unknown;

  constructor(code: string, message: string, options: ClientErrorOptions = {}) {
    super(message);
    this.name = "RuntimeClientError";
    this.code = code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

class RuntimeClient {
  #config: RuntimeClientConfig;
  #sequence = 0;
  #instanceId: string;

  constructor(config: RuntimeClientConfig) {
    this.#config = createRuntimeClientConfig(config);
    nextClientInstance += 1;
    this.#instanceId = `${CLIENT_INSTANCE_ID}-${nextClientInstance}`;
  }

  get config() {
    return this.#config;
  }

  close() {
    // Requests use one bounded connection each, so there is no persistent socket to close.
  }

  async request(command: RuntimeCommand, options: RequestOptions = {}): Promise<RuntimeResponse> {
    const requestId = options.requestId ?? this.#nextRequestId();
    const frame = encodeRequest(command, requestId, {
      maxFrameBytes: this.#config.maxFrameBytes,
    });
    let lastError;
    for (let attempt = 0; attempt <= this.#config.retries; attempt += 1) {
      try {
        return await requestOnce(this.#config, frame, requestId);
      } catch (error) {
        const clientError = normalizeClientError(error, requestId);
        lastError = clientError;
        if (!clientError.retryable || attempt >= this.#config.retries) throw clientError;
        await delay(0);
      }
    }
    throw lastError ?? new RuntimeClientError("transport_error", "runtime request failed", {
      requestId,
      retryable: true,
    });
  }

  async queryGraph(
    graphIdOrOptions: string | QueryGraphInput,
    options: Readonly<{ revision?: number }> = {},
  ): Promise<Record<string, unknown>> {
    const input = typeof graphIdOrOptions === "string"
      ? { graphId: graphIdOrOptions, ...options }
      : graphIdOrOptions;
    const graphId = nonEmptyString(input?.graphId, "graph_id");
    const revision = optionalPositiveInteger(input?.revision, "revision");
    const payload = {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      graph_id: graphId,
      revision: revision ?? null,
    };
    const reply = await this.request({ command: "query_graph", payload });
    const state = expectReply(reply, "state", "query_graph").state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new RuntimeClientError("invalid_state", "runtime query returned no state");
    }
    return state;
  }

  async readEvents(
    graphIdOrOptions: string | ReadEventsInput,
    options: ReadEventsOptions = {},
  ): Promise<unknown[]> {
    const input = typeof graphIdOrOptions === "string"
      ? { graphId: graphIdOrOptions, ...options }
      : graphIdOrOptions;
    const graphId = nonEmptyString(input?.graphId, "graph_id");
    const limit = input?.limit ?? 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_EVENT_LIMIT) {
      throw new RuntimeClientError("invalid_limit", `limit must be an integer from 1 through ${MAX_EVENT_LIMIT}`);
    }
    const afterEventId = optionalNonNegativeInteger(input?.afterEventId, "after_event_id");
    const payload = {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      graph_id: graphId,
      limit,
    };
    if (afterEventId !== undefined) payload.after_event_id = afterEventId;
    const reply = await this.request({ command: "read_events", payload });
    return expectReply(reply, "events", "read_events").events;
  }

  async acknowledgeEvents(
    graphIdOrOptions: string | AcknowledgeEventsInput,
    eventId?: number | RequestOptions,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const input = typeof graphIdOrOptions === "string"
      ? { graphId: graphIdOrOptions, eventId }
      : graphIdOrOptions;
    const requestOptions: RequestOptions = typeof graphIdOrOptions === "string"
      ? options
      : eventId && typeof eventId === "object" ? eventId : {};
    const payload = {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      graph_id: nonEmptyString(input?.graphId, "graph_id"),
      event_id: nonNegativeInteger(input?.eventId, "event_id"),
    };
    const reply = await this.request({
      command: "acknowledge_events",
      payload,
    }, requestOptions);
    const acknowledged = expectReply(reply, "events_acknowledged", "acknowledge_events");
    return acknowledged;
  }

  async cancelAttempt(input: CancelAttemptInput, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    const payload = {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      graph_revision: graphRevisionPayload(input?.graphRevision),
      attempt_id: nonEmptyString(input?.attemptId, "attempt_id"),
      lease_epoch: positiveInteger(input?.leaseEpoch, "lease_epoch"),
      reason: nonEmptyString(input?.reason, "reason"),
    };
    const reply = await this.request({ command: "cancel_attempt", payload }, options);
    return expectReply(reply, "attempt_cancelled", "cancel_attempt").attempt;
  }

  async retryTask(input: RetryTaskInput, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    const payload = {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      graph_revision: graphRevisionPayload(input?.graphRevision),
      task_id: nonEmptyString(input?.taskId, "task_id"),
    };
    if (input?.reason !== undefined) payload.reason = nonEmptyString(input.reason, "reason");
    const reply = await this.request({ command: "retry_task", payload }, options);
    return expectReply(reply, "task_retried", "retry_task");
  }

  #nextRequestId() {
    this.#sequence += 1;
    return `${this.#instanceId}-${this.#sequence}`;
  }
}

function requestOnce(
  config: RuntimeClientConfig,
  frame: string,
  requestId: string,
): Promise<RuntimeResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: config.endpoint.host, port: config.endpoint.port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const failTransport = (code, message, cause) => finish(new RuntimeClientError(code, message, {
      requestId,
      retryable: true,
      cause,
    }));

    socket.setTimeout(config.timeoutMs, () => {
      failTransport("transport_timeout", "runtime request timed out");
    });
    socket.on("connect", () => {
      socket.write(frame, (error) => {
        if (error) failTransport("transport_write_failed", `runtime request write failed: ${error.message}`, error);
      });
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.length > config.maxFrameBytes + 1) {
        finish(new RuntimeClientError("response_frame_too_large", "runtime response exceeds the frame limit", {
          requestId,
        }));
        return;
      }
      const delimiter = buffer.indexOf(0x0a);
      if (delimiter < 0) return;
      const frameBytes = buffer.subarray(0, delimiter);
      let line;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(frameBytes);
      } catch (error) {
        finish(new RuntimeClientError("invalid_response_utf8", "runtime response is not valid UTF-8", {
          requestId,
          cause: error,
        }));
        return;
      }
      try {
        const trailing = buffer.subarray(delimiter + 1);
        if ([...trailing].some((byte) => byte !== 0x0d && byte !== 0x0a && byte !== 0x20 && byte !== 0x09)) {
          throw new RuntimeWireError(
            "unexpected_extra_frame",
            "runtime returned more than one response frame",
            { requestId },
          );
        }
        const response = decodeRuntimeResponse(line, { maxFrameBytes: config.maxFrameBytes });
        if (response.requestId !== requestId) {
          throw new RuntimeWireError(
            "response_request_id_mismatch",
            "runtime response request_id does not match the request",
            { requestId },
          );
        }
        finish(undefined, response.response);
      } catch (error) {
        finish(normalizeClientError(error, requestId));
      }
    });
    socket.on("error", (error) => {
      failTransport("transport_error", `runtime connection failed: ${error.message}`, error);
    });
    socket.on("end", () => {
      if (!settled) failTransport("transport_closed", "runtime connection closed before a response");
    });
    socket.on("close", () => {
      if (!settled) failTransport("transport_closed", "runtime connection closed before a response");
    });
  });
}

function normalizeClientError(error: unknown, requestId: string): RuntimeClientError {
  if (error instanceof RuntimeClientError) return error;
  if (error instanceof RuntimeWireError) {
    return new RuntimeClientError(error.code, error.message, {
      requestId: error.requestId ?? requestId,
      retryable: false,
      cause: error,
    });
  }
  return new RuntimeClientError("transport_error", error instanceof Error ? error.message : String(error), {
    requestId,
    retryable: true,
    cause: error,
  });
}

function expectReply(
  reply: RuntimeResponse,
  responseName: string,
  commandName: string,
): { payload: Record<string, any> } {
  if (!reply || reply.response !== responseName || !reply.payload || typeof reply.payload !== "object") {
    throw new RuntimeClientError(
      "unexpected_response",
      `runtime ${commandName} response was not ${responseName}`,
    );
  }
  return reply.payload;
}

function graphRevisionPayload(value: GraphRevisionInput | undefined): {
  graph_id: string;
  revision: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeClientError("invalid_graph_revision", "graph_revision must contain graph_id and revision");
  }
  return {
    graph_id: nonEmptyString(value.graphId ?? value.graph_id, "graph_id"),
    revision: positiveInteger(value.revision, "revision"),
  };
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeClientError(`invalid_${field}`, `${field} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError(`invalid_${field}`, `${field} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return positiveInteger(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RuntimeClientError(`invalid_${field}`, `${field} must be a non-negative integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return nonNegativeInteger(value, field);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export {
  RuntimeClient,
  RuntimeClientError,
  MAX_EVENT_LIMIT,
};
export type {
  AcknowledgeEventsInput,
  CancelAttemptInput,
  GraphRevisionInput,
  QueryGraphInput,
  ReadEventsInput,
  RequestOptions,
  RetryTaskInput,
};
export * from "./runtime-client-config.ts";
export * from "./runtime-wire.ts";
