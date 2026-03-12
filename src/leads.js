import { createReadStream } from 'fs';
import { readdir } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Column alias map — maps any known variant to our canonical field name
const ALIAS = {
  username:    'username',
  usernames:   'username',
  handle:      'username',
  twitter:     'username',
  name:        'name',
  first_name:  'first_name',
  firstname:   'first_name',
  last_name:   'last_name',
  lastname:    'last_name',
  bio:         'bio',
  biography:   'bio',
  description: 'bio',
  location:    'location',
  website:     'website',
  websites:    'websites',
  profile_url: 'profile_url',
};

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        const clean = {};
        for (const [rawKey, rawVal] of Object.entries(row)) {
          const key = rawKey.trim().toLowerCase().replace(/\s+/g, '_');
          const canonical = ALIAS[key];
          if (canonical) {
            clean[canonical] = (rawVal || '').trim();
          }
        }
        // Strip leading @ from username if present
        if (clean.username) {
          clean.username = clean.username.replace(/^@/, '');
        }
        // Build a display name if 'name' is missing but first/last exist
        if (!clean.name && (clean.first_name || clean.last_name)) {
          clean.name = `${clean.first_name || ''} ${clean.last_name || ''}`.trim();
        }
        if (clean.username) rows.push(clean);
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

/**
 * Reads ALL .csv files in data/ and returns a deduplicated lead array.
 */
export async function readLeads() {
  const files = await readdir(DATA_DIR);
  const csvFiles = files.filter(f => extname(f).toLowerCase() === '.csv');

  const allRows = [];
  for (const file of csvFiles) {
    try {
      const rows = await parseCSV(join(DATA_DIR, file));
      console.log(`[Leads] Loaded ${rows.length} leads from ${file}`);
      allRows.push(...rows);
    } catch (err) {
      console.error(`[Leads] Failed to parse ${file}: ${err.message}`);
    }
  }

  // Deduplicate by username (keep first occurrence)
  const seen = new Set();
  const unique = [];
  for (const row of allRows) {
    const key = row.username.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  }
  console.log(`[Leads] Total unique leads across ${csvFiles.length} files: ${unique.length}`);
  return unique;
}

/**
 * Lists all CSV files in the data directory.
 */
export async function listDataFiles() {
  const files = await readdir(DATA_DIR);
  return files.filter(f => extname(f).toLowerCase() === '.csv');
}

export { DATA_DIR };

