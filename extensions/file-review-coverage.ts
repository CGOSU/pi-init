import type { FileSnapshot } from "../src/file-review.ts";

export type FileCoverage = {
  fingerprint: string;
  totalLines: number;
  ranges: Array<[number, number]>;
};

export function pathKey(path: string, fingerprint: string) {
  return `${path}\u0000${fingerprint}`;
}

export function hasCompleteCoverage(coverage: FileCoverage | undefined, file: FileSnapshot) {
  if (!coverage || coverage.fingerprint !== file.fingerprint || coverage.totalLines !== file.lineCount) return false;
  const ranges = [...coverage.ranges].sort((left, right) => left[0] - right[0]);
  let end = 0;
  for (const [start, nextEnd] of ranges) {
    if (start > end + 1) return false;
    end = Math.max(end, nextEnd);
  }
  return end >= file.lineCount;
}

export function mergeCoverage(store: Map<string, FileCoverage>, file: FileSnapshot, start: number, end: number) {
  if (start > end || start < 1 || end > file.lineCount) return;
  const previous = store.get(file.path);
  const coverage = previous?.fingerprint === file.fingerprint && previous.totalLines === file.lineCount
    ? previous
    : { fingerprint: file.fingerprint, totalLines: file.lineCount, ranges: [] };
  coverage.ranges.push([start, end]);
  const ranges = coverage.ranges.sort((left, right) => left[0] - right[0]);
  coverage.ranges = ranges.reduce<Array<[number, number]>>((merged, range) => {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
    return merged;
  }, []);
  store.set(file.path, coverage);
}
