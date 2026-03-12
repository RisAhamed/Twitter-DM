import { readFile, appendFile, access, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, '..', 'logs', 'sent_log.json');

async function ensureFile() {
  try {
    await access(LOG_PATH);
  } catch {
    await writeFile(LOG_PATH, '[]', 'utf-8');
  }
}

export async function getSentLog() {
  await ensureFile();
  const raw = await readFile(LOG_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function appendSentLog(entry) {
  const log = await getSentLog();
  log.push(entry);
  await writeFile(LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}
