import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const LOG_PREFIX = 'opencode-betterglob.';
const LOG_SUFFIX = '.log';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let logFile: string | null = null;
let initialization: Promise<void> | null = null;

function getLogDir(): string {
  return (
    process.env.OPENCODE_LOG_DIR ??
    path.join(os.homedir(), '.local/share/opencode')
  );
}

async function cleanupOldLogs(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith(LOG_PREFIX) && entry.endsWith(LOG_SUFFIX)) {
        const file = path.join(dir, entry);
        try {
          const stat = await fs.stat(file);
          if (now - stat.mtimeMs > RETENTION_MS) {
            await fs.unlink(file);
          }
        } catch {
          // Skip individual file errors.
        }
      }
    }
  } catch {
    // Directory may not exist yet.
  }
}

export function initLogger(sessionId: string): void {
  const dir = getLogDir();
  logFile = path.join(dir, `${LOG_PREFIX}${sessionId}${LOG_SUFFIX}`);
  initialization = null;
}

async function ensureLoggerReady(file: string): Promise<void> {
  const dir = path.dirname(file);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Logging is best-effort.
  }
  await cleanupOldLogs(dir);
}

export function log(message: string, data?: unknown): void {
  void logAsync(message, data).catch(() => undefined);
}

export async function logAsync(
  message: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const file = logFile;
  if (!file || signal?.aborted) return;
  try {
    initialization ??= ensureLoggerReady(file);
    await initialization;
    if (signal?.aborted) return;
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    await fs.writeFile(
      file,
      `[${new Date().toISOString()}] ${message}${suffix}\n`,
      { flag: 'a', signal },
    );
  } catch {
    // Ignore logging errors.
  }
}
