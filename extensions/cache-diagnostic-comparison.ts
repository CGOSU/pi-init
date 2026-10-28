type Fingerprint = (value: unknown) => string;
type SegmentView = { state: string; kind?: "text" | "array"; count?: number; fingerprints: string[] };
type Snapshot = { identity: string; model: string | undefined; fingerprints: Record<string, string>; system: SegmentView; context: SegmentView };
const valid = (value: string | undefined): value is string => typeof value === "string" && value.startsWith("hmac:");

// At most 32 independently budgeted messages or 8K-code-unit text sections. These
// are ordered prefixes, never samples presented as an equality proof of the whole.
function segments(value: unknown, fingerprint: Fingerprint): SegmentView {
  if (value === undefined) return { state: "missing", fingerprints: [] };
  if (!Array.isArray(value) && typeof value !== "string") return { state: "unavailable-shape", fingerprints: [] };
  const count = typeof value === "string" ? Math.ceil(value.length / 8192) : value.length;
  const fingerprints: string[] = [];
  for (let i = 0; i < Math.min(count, 32); i++) {
    fingerprints.push(fingerprint(typeof value === "string" ? value.slice(i * 8192, (i + 1) * 8192) : value[i]));
  }
  return { count, kind: typeof value === "string" ? "text" : "array", fingerprints, state: count > 32 || fingerprints.some(v => !valid(v)) ? "partial" : "complete" };
}
function difference(before: SegmentView, after: SegmentView) {
  if (before.kind !== after.kind) return undefined;
  for (let i = 0; i < Math.min(before.fingerprints.length, after.fingerprints.length); i++) {
    if (!valid(before.fingerprints[i]) || !valid(after.fingerprints[i])) return undefined;
    if (before.fingerprints[i] !== after.fingerprints[i]) return i;
  }
  if (before.count !== after.count && before.state === "complete" && after.state === "complete") return Math.min(before.count!, after.count!);
  return undefined;
}
function compare(before: string | undefined, after: string) {
  if (before === undefined) return "unknown-no-baseline";
  if (before === "missing" || after === "missing") return "unknown-missing";
  if (!valid(before) || !valid(after)) return "unknown-unavailable";
  return before === after ? "same" : "changed";
}

export function createCacheDiagnosticComparison(fingerprint: Fingerprint) {
  let previous: Snapshot | undefined;
  return {
    reset() { previous = undefined; },
    observe(identity: string, model: string | undefined, values: Record<string, unknown>, overlapping: boolean) {
      const fingerprints = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, fingerprint(value)]));
      const system = segments(values.system, fingerprint), context = segments(values.context, fingerprint);
      const comparable = !overlapping && previous?.identity === identity;
      const result: Record<string, unknown> = {
        comparisonScope: "same-runtime-only", comparisonState: overlapping ? "unknown-overlap" : comparable ? "comparable" : "unknown-no-baseline",
        modelChange: !comparable ? "unknown-no-baseline" : !previous!.model || !model ? "unknown-missing" : previous!.model === model ? "same" : "changed",
      };
      for (const [key, value] of Object.entries(fingerprints)) {
        result[key + "Fingerprint"] = value;
        result[key + "Change"] = overlapping ? "unknown-overlap" : compare(comparable ? previous!.fingerprints[key] : undefined, value);
      }
      for (const [key, view] of [["system", system], ["context", context]] as const) {
        result[key + "SegmentsState"] = view.state;
        result[key + "SegmentsObserved"] = view.fingerprints.length;
        result[key + "SegmentsCount"] = view.count;
        const first = comparable ? difference(previous![key], view) : undefined;
        if (first !== undefined) { result[key + "FirstChange"] = first; result[key + "Change"] = "changed"; }
        result[key + "PrefixChange"] = !comparable ? "unknown-no-baseline" : view.kind !== previous![key].kind ? "unknown-shape" : first !== undefined ? "changed"
          : view.state === "complete" && previous![key].state === "complete" ? "same" : "unknown-partial";
      }
      // Never allow a request involved in overlap to become the next baseline.
      previous = overlapping ? undefined : { identity, model, fingerprints, system, context };
      return result;
    },
  };
}
