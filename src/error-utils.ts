export function textOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function throwCodedError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
