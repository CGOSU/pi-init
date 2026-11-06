import { isRecord } from "./record-guard.js";
export { isRecord } from "./record-guard.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function isStringMember<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function hasOwn(value: unknown, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
