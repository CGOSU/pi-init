import {
  MAX_JSON_FRAME_BYTES,
  RuntimeWireError,
  parseLoopbackEndpoint,
} from "./runtime-wire.ts";
import type { LoopbackEndpoint } from "./runtime-wire.ts";

type RuntimeClientConfigInput = Readonly<{
  endpoint?: string | LoopbackEndpoint;
  timeoutMs?: number;
  retries?: number;
  maxFrameBytes?: number;
}>;
type RuntimeClientConfig = Readonly<{
  endpoint: LoopbackEndpoint;
  timeoutMs: number;
  retries: number;
  maxFrameBytes: number;
}>;

const DEFAULT_RUNTIME_TIMEOUT_MS = 5000;
const DEFAULT_RUNTIME_RETRIES = 2;
const MAX_RUNTIME_TIMEOUT_MS = 60_000;
const MAX_RUNTIME_RETRIES = 8;

class RuntimeClientConfigError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeClientConfigError";
    this.code = code;
  }
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RuntimeClientConfigError(
      `invalid_${field}`,
      `${field} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RuntimeClientConfigError(
      `invalid_${field}`,
      `${field} must be an integer from 0 through ${maximum}`,
    );
  }
  return value;
}

function explicitEndpoint(endpoint: RuntimeClientConfigInput["endpoint"]): LoopbackEndpoint {
  try {
    if (typeof endpoint === "string") return parseLoopbackEndpoint(endpoint);
    if (endpoint && typeof endpoint === "object") {
      const host = endpoint.host;
      const port = endpoint.port;
      if (typeof host === "string" && Number.isInteger(port)) {
        return parseLoopbackEndpoint(host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);
      }
    }
  } catch (error) {
    throw new RuntimeClientConfigError(error.code ?? "invalid_endpoint", error.message);
  }
  throw new RuntimeClientConfigError(
    "missing_endpoint",
    "runtime endpoint must be supplied explicitly as a loopback host and port",
  );
}

function createRuntimeClientConfig(
  options: RuntimeClientConfigInput = {},
): RuntimeClientConfig {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new RuntimeClientConfigError("invalid_config", "runtime client config must be an object");
  }
  const endpoint = explicitEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RUNTIME_RETRIES;
  const maxFrameBytes = options.maxFrameBytes ?? MAX_JSON_FRAME_BYTES;
  positiveInteger(timeoutMs, "timeout_ms", MAX_RUNTIME_TIMEOUT_MS);
  nonNegativeInteger(retries, "retries", MAX_RUNTIME_RETRIES);
  positiveInteger(maxFrameBytes, "max_frame_bytes", MAX_JSON_FRAME_BYTES);
  return Object.freeze({ endpoint, timeoutMs, retries, maxFrameBytes });
}

function loadRuntimeClientConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeClientConfig {
  const endpoint = environment?.PI_INIT_RUNTIME_ENDPOINT;
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new RuntimeClientConfigError(
      "missing_endpoint",
      "PI_INIT_RUNTIME_ENDPOINT must be set explicitly; no runtime endpoint is implicit",
    );
  }
  const timeoutMs = parseEnvironmentInteger(environment.PI_INIT_RUNTIME_TIMEOUT_MS, "timeout_ms");
  const retries = parseEnvironmentInteger(environment.PI_INIT_RUNTIME_RETRIES, "retries");
  try {
    return createRuntimeClientConfig({ endpoint, timeoutMs, retries });
  } catch (error) {
    if (error instanceof RuntimeClientConfigError) throw error;
    if (error instanceof RuntimeWireError) {
      throw new RuntimeClientConfigError(error.code, error.message);
    }
    throw error;
  }
}

function parseEnvironmentInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new RuntimeClientConfigError(`invalid_${field}`, `${field} environment value must be an integer`);
  }
  return Number(value);
}

export {
  DEFAULT_RUNTIME_TIMEOUT_MS,
  DEFAULT_RUNTIME_RETRIES,
  MAX_RUNTIME_TIMEOUT_MS,
  MAX_RUNTIME_RETRIES,
  RuntimeClientConfigError,
  createRuntimeClientConfig,
  loadRuntimeClientConfig,
};
export type { RuntimeClientConfig, RuntimeClientConfigInput };
