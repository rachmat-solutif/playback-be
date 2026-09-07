import { randomBytes } from 'node:crypto';

export interface ImportJobError {
  index: number;
  message: string;
}

export interface ImportJob {
  id: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  total: number;
  imported: number;
  errors: ImportJobError[];
  created_at: string;
  completed_at: string | null;
}

// In-memory store. For production at scale, move to a persistent store (Redis/Mongo).
const jobs = new Map<string, ImportJob>();

export function createJob(total: number): ImportJob {
  const id = randomBytes(12).toString('hex');
  const job: ImportJob = {
    id,
    status: 'queued',
    total,
    imported: 0,
    errors: [],
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): ImportJob | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, update: Partial<ImportJob>): void {
  const job = jobs.get(id);
  if (job) {
    Object.assign(job, update);
  }
}
