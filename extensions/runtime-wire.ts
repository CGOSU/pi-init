const RUNTIME_WIRE_VERSION = 1;
const RUNTIME_PROTOCOL_VERSION = 2;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_JSON_FRAME_BYTES = 128 * 1024;

type LoopbackEndpoint = Readonly<{
  host: string;
  port: number;
  address: string;
}>;
type RuntimeCommand = Readonly<{
  command: string;
  payload?: unknown;
}>;
type RuntimeResponse = Readonly<{
  response: string;
  payload: Record<string, any>;
}>;
type WireErrorOptions = Readonly<{
  requestId?: string;
}>;

class RuntimeWireError extends Error {
  code: string;
  requestId?: string;
  retryable: false;

  constructor(code: string, message: string, options: WireErrorOptions = {}) {
    super(message);
    this.name = "RuntimeWireError";
    this.code = code;
    this.requestId = options.requestId;
    this.retryable = false;
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateRequestId(requestId: unknown): void {
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw new RuntimeWireError("invalid_request_id", "request_id must be a non-empty string");
  }
  if (requestId.includes("\n") || requestId.includes("\r")) {
    throw new RuntimeWireError("invalid_request_id", "request_id must not contain line breaks");
  }
  if (byteLength(requestId) > MAX_REQUEST_ID_BYTES) {
    throw new RuntimeWireError("request_id_too_large", `request_id exceeds ${MAX_REQUEST_ID_BYTES} bytes`);
  }
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function isLoopbackHost(host: string): boolean {
  if (host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.slice(1).every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
}

function formatEndpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function parseLoopbackEndpoint(endpoint: string): LoopbackEndpoint {
  if (typeof endpoint !== "string" || endpoint.trim() !== endpoint || endpoint === "") {
    throw new RuntimeWireError("invalid_endpoint", "runtime endpoint must be an explicit address");
  }
  let host;
  let portText;
  if (endpoint.startsWith("[")) {
    const close = endpoint.indexOf("]");
    if (close < 0 || endpoint[close + 1] !== ":") {
      throw new RuntimeWireError("invalid_endpoint", "IPv6 endpoint must use [host]:port");
    }
    host = endpoint.slice(1, close);
    portText = endpoint.slice(close + 2);
  } else {
    const separator = endpoint.lastIndexOf(":");
    if (separator <= 0 || endpoint.slice(0, separator).includes(":")) {
      throw new RuntimeWireError("invalid_endpoint", "endpoint must be host:port or [host]:port");
    }
    host = endpoint.slice(0, separator);
    portText = endpoint.slice(separator + 1);
  }
  const port = parsePort(portText);
  if (!isLoopbackHost(host) || port === undefined) {
    throw new RuntimeWireError("invalid_endpoint", "runtime endpoint must be a numeric loopback address");
  }
  return Object.freeze({ host, port, address: formatEndpoint(host, port) });
}

function encodeRequest(
  command: RuntimeCommand,
  requestId: string,
  options: Readonly<{ version?: number; maxFrameBytes?: number }> = {},
): string {
  validateRequestId(requestId);
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new RuntimeWireError("invalid_command", "runtime command must be an object", { requestId });
  }
  if (typeof command.command !== "string" || command.command.trim() === "") {
    throw new RuntimeWireError("invalid_command", "runtime command name must be non-empty", { requestId });
  }
  const version = options.version ?? RUNTIME_WIRE_VERSION;
  const envelope = { version, request_id: requestId, command };
  const encoded = JSON.stringify(envelope);
  if (byteLength(encoded) > (options.maxFrameBytes ?? MAX_JSON_FRAME_BYTES)) {
    throw new RuntimeWireError("request_frame_too_large", "runtime request exceeds the frame limit", { requestId });
  }
  return `${encoded}\n`;
}

function decodeRuntimeResponse(
  line: string,
  options: Readonly<{ maxFrameBytes?: number }> = {},
): Readonly<{
  version: number;
  requestId: string;
  response: RuntimeResponse;
}> {
  if (typeof line !== "string") {
    throw new RuntimeWireError("invalid_response", "runtime response must be text");
  }
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (normalized.includes("\n") || byteLength(normalized) > (options.maxFrameBytes ?? MAX_JSON_FRAME_BYTES)) {
    throw new RuntimeWireError("invalid_response_frame", "runtime response frame is invalid or oversized");
  }
  let envelope;
  try {
    envelope = JSON.parse(normalized);
  } catch (error) {
    throw new RuntimeWireError("invalid_response_json", `runtime response JSON is invalid: ${error.message}`);
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new RuntimeWireError("invalid_response", "runtime response envelope must be an object");
  }
  if (envelope.version !== RUNTIME_WIRE_VERSION) {
    throw new RuntimeWireError(
      "unsupported_wire_version",
      `runtime response wire version ${String(envelope.version)} is unsupported`,
      { requestId: envelope.request_id },
    );
  }
  validateRequestId(envelope.request_id);
  const response = envelope.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new RuntimeWireError("invalid_response", "runtime response payload is missing", {
      requestId: envelope.request_id,
    });
  }
  if (response.status === "error") {
    const payload = response.payload;
    const code = payload && typeof payload.code === "string" && payload.code.trim()
      ? payload.code
      : "runtime_error";
    const message = payload && typeof payload.message === "string" && payload.message.trim()
      ? payload.message
      : "runtime command failed";
    throw new RuntimeWireError(code, message, { requestId: envelope.request_id });
  }
  if (response.status !== "ok" || !response.payload || typeof response.payload !== "object") {
    throw new RuntimeWireError("invalid_response", "runtime response status is invalid", {
      requestId: envelope.request_id,
    });
  }
  return {
    version: envelope.version,
    requestId: envelope.request_id,
    response: response.payload,
  };
}

export {
  RUNTIME_WIRE_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  MAX_REQUEST_ID_BYTES,
  MAX_JSON_FRAME_BYTES,
  RuntimeWireError,
  parseLoopbackEndpoint,
  encodeRequest,
  decodeRuntimeResponse,
};
export type { LoopbackEndpoint, RuntimeCommand, RuntimeResponse };
