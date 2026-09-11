import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, normalize, relative, resolve } from "node:path";
import type {
  AgentRegistration,
  CollaborationDirs,
  FileReservation,
  ReservationConflict,
} from "./collaboration-types.ts";
import { ensureCollaborationDirs } from "./collaboration-paths.ts";

const LOCK_TIMEOUT_MS = 1500;
const STALE_LOCK_MS = 30_000;
const STALE_RUN_MS = 5 * 60 * 1000;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

type Owner = { pid: number; sessionId?: string };

function json<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(filePath, { recursive: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockIsStale(lockPath: string): boolean {
  const owner = json<{ pid?: number; acquiredAt?: number }>(join(lockPath, "owner.json"));
  if (owner?.pid && !isAlive(owner.pid)) return true;
  if (owner?.acquiredAt && Date.now() - owner.acquiredAt > STALE_LOCK_MS) return true;
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

function acquireLock(lockPath: string, timeoutMs = LOCK_TIMEOUT_MS): (() => void) | undefined {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      if (lockIsStale(lockPath)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(lockWait, 0, 0, 25);
    }
  }
  return undefined;
}

function atomicWrite(filePath: string, content: string): boolean {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, filePath);
    return true;
  } catch {
    fs.rmSync(temporary, { force: true });
    return false;
  }
}

function validReservation(value: unknown): value is FileReservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.pattern === "string" && typeof item.since === "string"
    && (item.reason === undefined || typeof item.reason === "string");
}

function validRegistration(value: unknown): value is AgentRegistration {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && typeof item.pid === "number"
    && typeof item.sessionId === "string" && typeof item.cwd === "string"
    && typeof item.model === "string" && typeof item.startedAt === "string"
    && typeof item.lastSeenAt === "string"
    && (item.reservations === undefined
      || (Array.isArray(item.reservations) && item.reservations.every(validReservation)));
}

function registrationPath(dirs: CollaborationDirs, name: string): string {
  return join(dirs.registry, `${name}.json`);
}

function withReservationLock<T>(dirs: CollaborationDirs, fn: () => T): T | undefined {
  const release = acquireLock(join(dirs.base, "reservations.lock"));
  if (!release) return undefined;
  try {
    return fn();
  } finally {
    release();
  }
}

function withRegistrationLock<T>(dirs: CollaborationDirs, name: string, fn: () => T): T | undefined {
  const release = acquireLock(`${registrationPath(dirs, name)}.lock`);
  if (!release) return undefined;
  try {
    return fn();
  } finally {
    release();
  }
}

function sameOwner(value: AgentRegistration, owner: Owner): boolean {
  return value.pid === owner.pid && (!owner.sessionId || value.sessionId === owner.sessionId);
}

export function registerSelf(dirs: CollaborationDirs, registration: AgentRegistration): boolean {
  ensureCollaborationDirs(dirs);
  ensureParent(join(dirs.inbox, registration.name));
  const save = () => withRegistrationLock(dirs, registration.name, () => {
    const path = registrationPath(dirs, registration.name);
    const existing = json<unknown>(path);
    if (validRegistration(existing) && !sameOwner(existing, registration) && isAlive(existing.pid)) return false;
    return atomicWrite(path, JSON.stringify(registration, null, 2));
  });
  const result = registration.reservations?.length
    ? withReservationLock(dirs, () => {
        if (getReservationPatternConflicts(dirs, registration.name, registration.reservations![0]!.pattern, registration.cwd).length > 0) return false;
        for (const reservation of registration.reservations!.slice(1)) {
          if (getReservationPatternConflicts(dirs, registration.name, reservation.pattern, registration.cwd).length > 0) return false;
        }
        return save();
      })
    : save();
  return result === true;
}

export function updateSelf(dirs: CollaborationDirs, registration: AgentRegistration): boolean {
  ensureCollaborationDirs(dirs);
  const result = withRegistrationLock(dirs, registration.name, () => {
    const path = registrationPath(dirs, registration.name);
    const existing = json<unknown>(path);
    if (validRegistration(existing) && !sameOwner(existing, registration) && isAlive(existing.pid)) return false;
    return atomicWrite(path, JSON.stringify(registration, null, 2));
  });
  return result === true;
}

export function unregisterSelf(dirs: CollaborationDirs, name: string, owner?: Owner): void {
  withRegistrationLock(dirs, name, () => {
    const path = registrationPath(dirs, name);
    const existing = json<unknown>(path);
    if (!owner || (validRegistration(existing) && sameOwner(existing, owner))) fs.rmSync(path, { force: true });
  });
}

export function readAgentRegistration(dirs: CollaborationDirs, name: string): AgentRegistration | undefined {
  const value = json<unknown>(registrationPath(dirs, name));
  return validRegistration(value) ? value : undefined;
}

export function listActiveAgents(dirs: CollaborationDirs, exclude?: string): AgentRegistration[] {
  ensureCollaborationDirs(dirs);
  const agents: AgentRegistration[] = [];
  for (const entry of fs.readdirSync(dirs.registry)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dirs.registry, entry);
    const value = json<unknown>(filePath);
    if (!validRegistration(value)) continue;
    if (!isAlive(value.pid)) {
      fs.rmSync(filePath, { force: true });
      continue;
    }
    if (value.name !== exclude) agents.push(value);
  }
  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

export function formatAgentDisplayName(name: string): string {
  const match = name.match(/-([A-Z][a-z]+[A-Z][A-Za-z]+)$/);
  return match?.[1] ?? name;
}

export function resolveAgentName(
  dirs: CollaborationDirs,
  name: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const wanted = name.trim().replace(/\s+\((?:subagent|orchestrator)\)$/i, "");
  const agents = listActiveAgents(dirs);
  const exact = agents.find((agent) => agent.name === wanted);
  if (exact) return { ok: true, name: exact.name };
  const aliases = agents.filter((agent) => formatAgentDisplayName(agent.name) === wanted);
  if (aliases.length === 1) return { ok: true, name: aliases[0]!.name };
  if (aliases.length > 1) return { ok: false, error: `Agent alias '${wanted}' is ambiguous` };
  return { ok: false, error: `Agent '${wanted}' is not active` };
}

function canonical(value: string, cwd: string): string {
  const path = resolve(cwd, value);
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function directoryPattern(pattern: string): boolean {
  const raw = pattern.trim();
  return raw === "." || raw === ".." || /[\\/]$/.test(raw);
}

function reservationBase(pattern: string, cwd: string): string {
  return canonical(pattern.trim().replace(/[\\/]$/, "") || ".", cwd);
}

export function pathMatchesReservation(filePath: string, pattern: string, cwd: string, patternCwd = cwd): boolean {
  const target = canonical(filePath, cwd);
  const base = reservationBase(pattern, patternCwd);
  if (target === base) return true;
  if (!directoryPattern(pattern)) return false;
  const rest = relative(base, target);
  return rest !== "" && !rest.startsWith("..") && !isAbsoluteLike(rest);
}

export function reservationsOverlap(left: string, leftCwd: string, right: string, rightCwd: string): boolean {
  const leftBase = reservationBase(left, leftCwd);
  const rightBase = reservationBase(right, rightCwd);
  if (leftBase === rightBase) return true;
  if (directoryPattern(left)) return pathMatchesReservation(rightBase, left, leftCwd);
  return directoryPattern(right) && pathMatchesReservation(leftBase, right, rightCwd);
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function getReservationConflicts(
  dirs: CollaborationDirs,
  selfName: string,
  filePath: string,
  cwd: string,
): ReservationConflict[] {
  const conflicts: ReservationConflict[] = [];
  for (const agent of listActiveAgents(dirs, selfName)) {
    for (const reservation of agent.reservations ?? []) {
      if (pathMatchesReservation(filePath, reservation.pattern, cwd, agent.cwd)) {
        conflicts.push({ path: filePath, agent: agent.name, pattern: reservation.pattern, reason: reservation.reason, registration: agent });
      }
    }
  }
  return conflicts;
}

export function getReservationPatternConflicts(
  dirs: CollaborationDirs,
  selfName: string,
  pattern: string,
  cwd: string,
): ReservationConflict[] {
  const conflicts: ReservationConflict[] = [];
  for (const agent of listActiveAgents(dirs, selfName)) {
    for (const reservation of agent.reservations ?? []) {
      if (reservationsOverlap(pattern, cwd, reservation.pattern, agent.cwd)) {
        conflicts.push({ path: pattern, agent: agent.name, pattern: reservation.pattern, reason: reservation.reason, registration: agent });
      }
    }
  }
  return conflicts;
}

export function updateReservations(
  dirs: CollaborationDirs,
  registration: AgentRegistration,
  reservations: FileReservation[],
): boolean {
  return updateSelf(dirs, { ...registration, reservations: reservations.length > 0 ? reservations : undefined, lastSeenAt: new Date().toISOString() });
}

export function claimReservations(
  dirs: CollaborationDirs,
  selfName: string,
  cwd: string,
  patterns: string[],
  reason?: string,
): { ok: true; reservations: FileReservation[] } | { ok: false; conflicts?: ReservationConflict[]; error: string } {
  const result = withReservationLock(dirs, () => {
    const conflicts = patterns.flatMap((pattern) => getReservationPatternConflicts(dirs, selfName, pattern, cwd));
    if (conflicts.length > 0) return { ok: false as const, conflicts, error: "reservation conflict" };
    const current = readAgentRegistration(dirs, selfName);
    if (!current) return { ok: false as const, error: "Agent registration unavailable" };
    const existing = current.reservations ?? [];
    const next = [
      ...existing.filter((item) => !patterns.includes(item.pattern)),
      ...patterns.map((pattern) => ({ pattern, reason: reason?.trim() || undefined, since: new Date().toISOString() })),
    ];
    return updateSelf(dirs, { ...current, reservations: next, lastSeenAt: new Date().toISOString() })
      ? { ok: true as const, reservations: next }
      : { ok: false as const, error: "unable to persist reservation" };
  });
  return result ?? { ok: false, error: "reservation lock unavailable" };
}

export function releaseReservations(
  dirs: CollaborationDirs,
  selfName: string,
  patterns?: string[],
): { ok: true; reservations: FileReservation[] } | { ok: false; error: string } {
  const result = withReservationLock(dirs, () => {
    const current = readAgentRegistration(dirs, selfName);
    if (!current) return { ok: false as const, error: "Agent registration unavailable" };
    const next = patterns?.length ? (current.reservations ?? []).filter((item) => !patterns.includes(item.pattern)) : [];
    return updateSelf(dirs, { ...current, reservations: next, lastSeenAt: new Date().toISOString() })
      ? { ok: true as const, reservations: next }
      : { ok: false as const, error: "unable to persist reservation release" };
  });
  return result ?? { ok: false, error: "reservation lock unavailable" };
}

export function isStaleRun(lastSeenAt: string, status: string, now = Date.now()): boolean {
  return ["launching", "running"].includes(status) && Number.isFinite(Date.parse(lastSeenAt))
    && now - Date.parse(lastSeenAt) > STALE_RUN_MS;
}
