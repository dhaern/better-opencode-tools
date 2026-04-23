import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LOG_PREFIX = 'opencode-betterglob.';
const LOG_SUFFIX = '.log';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let logFile: string | null = null;
let initialized = false;

function getLogDir(): string {
  return (
    process.env.OPENCODE_LOG_DIR ??
    path.join(os.homedir(), '.local/share/opencode')
  );
}

function cleanupOldLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith(LOG_PREFIX) && entry.endsWith(LOG_SUFFIX)) {
        const file = path.join(dir, entry);
        try {
          const stat = fs.statSync(file);
          if (now - stat.mtimeMs > RETENTION_MS) {
            fs.unlinkSync(file);
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
  initialized = false;
}

function ensureLoggerReady(): void {
  if (!logFile || initialized) return;

  const dir = path.dirname(logFile);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Logging is best-effort.
  }
  cleanupOldLogs(dir);
  initialized = true;
}

export function log(message: string, data?: unknown): void {
  if (!logFile) return;
  ensureLoggerReady();
  try {
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] ${message}${suffix}\n`,
    );
  } catch {
    // Ignore logging errors.
  }
}
