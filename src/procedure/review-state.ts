import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

export interface ProcedureReviewRecord {
  token: string;
  procedureId: string;
  repo: string;
  argsHash: string;
  expiresAt: number;
}

export interface ProcedureReviewState {
  issue(record: Omit<ProcedureReviewRecord, 'token'>): ProcedureReviewRecord;
  consume(token: string, expected: Pick<ProcedureReviewRecord, 'procedureId' | 'repo' | 'argsHash'>):
    | { ok: true; record: ProcedureReviewRecord }
    | { ok: false; code: 'REVIEW_REQUIRED' | 'REVIEW_MISMATCH' };
}

const REVIEW_TTL_MS = 10 * 60 * 1000;

export function hashProcedureArgs(args: Record<string, Record<string, unknown>> = {}): string {
  return createHash('sha256').update(JSON.stringify(args, Object.keys(args).sort())).digest('hex');
}

export class FileProcedureReviewState implements ProcedureReviewState {
  private readonly path: string;

  constructor(path = join(os.homedir(), '.cadet-brainstem', 'procedure-reviews.json')) {
    this.path = path;
  }

  issue(record: Omit<ProcedureReviewRecord, 'token'>): ProcedureReviewRecord {
    const issued = { ...record, token: randomUUID() };
    const records = this.read().filter((item) => item.expiresAt > Date.now());
    records.push(issued);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(records), 'utf8');
    return issued;
  }

  consume(
    token: string,
    expected: Pick<ProcedureReviewRecord, 'procedureId' | 'repo' | 'argsHash'>,
  ): { ok: true; record: ProcedureReviewRecord } | { ok: false; code: 'REVIEW_REQUIRED' | 'REVIEW_MISMATCH' } {
    const records = this.read();
    const index = records.findIndex((item) => item.token === token);
    if (index < 0) return { ok: false, code: 'REVIEW_REQUIRED' };
    const record = records[index]!;
    records.splice(index, 1);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(records.filter((item) => item.expiresAt > Date.now())), 'utf8');
    if (record.expiresAt <= Date.now()) return { ok: false, code: 'REVIEW_REQUIRED' };
    if (
      record.procedureId !== expected.procedureId ||
      record.repo !== expected.repo ||
      record.argsHash !== expected.argsHash
    ) {
      return { ok: false, code: 'REVIEW_MISMATCH' };
    }
    return { ok: true, record };
  }

  private read(): ProcedureReviewRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed as ProcedureReviewRecord[] : [];
    } catch {
      return [];
    }
  }
}

export class MemoryProcedureReviewState implements ProcedureReviewState {
  private readonly records = new Map<string, ProcedureReviewRecord>();

  issue(record: Omit<ProcedureReviewRecord, 'token'>): ProcedureReviewRecord {
    const issued = { ...record, token: randomUUID() };
    this.records.set(issued.token, issued);
    return issued;
  }

  consume(
    token: string,
    expected: Pick<ProcedureReviewRecord, 'procedureId' | 'repo' | 'argsHash'>,
  ): { ok: true; record: ProcedureReviewRecord } | { ok: false; code: 'REVIEW_REQUIRED' | 'REVIEW_MISMATCH' } {
    const record = this.records.get(token);
    this.records.delete(token);
    if (record === undefined || record.expiresAt <= Date.now()) {
      return { ok: false, code: 'REVIEW_REQUIRED' };
    }
    if (
      record.procedureId !== expected.procedureId ||
      record.repo !== expected.repo ||
      record.argsHash !== expected.argsHash
    ) {
      return { ok: false, code: 'REVIEW_MISMATCH' };
    }
    return { ok: true, record };
  }
}

export function reviewExpiry(): number {
  return Date.now() + REVIEW_TTL_MS;
}