import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { writeFile, appendFile, access } from 'fs/promises';
import { readLeads, listDataFiles, DATA_DIR } from './src/leads.js';
import { getSentLog, appendSentLog } from './src/logger.js';
import { generateMessage, buildCampaignContext } from './src/groq.js';
import { sendDM, closeBrowser } from './src/puppeteer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const METRICS_PATH = join(__dirname, 'logs', 'dm_metrics.csv');
const MIN_DELAY_SEC = 72;
const MAX_DELAY_SEC = 90;

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------- state ----------
let campaignRunning = false;
let campaignAbort = false;
let campaignStats = {
  total: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  current: '',
  config: {
    model: '',
    ctaLink: '',
    dailyLimit: 0,
    notesLength: 0,
    startedAt: '',
  },
};

// ---------- API routes ----------

// Get sent-log history
app.get('/api/logs', async (_req, res) => {
  try {
    const logs = await getSentLog();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get live campaign stats
app.get('/api/status', (_req, res) => {
  res.json({ running: campaignRunning, ...campaignStats });
});

// Stop a running campaign
app.post('/api/stop', (_req, res) => {
  if (!campaignRunning) return res.json({ message: 'No campaign running.' });
  campaignAbort = true;
  res.json({ message: 'Stop signal sent. Will halt after current DM.' });
});

// List CSV files in data/
app.get('/api/files', async (_req, res) => {
  try {
    const files = await listDataFiles();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload CSV to data/
app.post('/api/upload', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const filename = req.headers['x-filename'];
  if (!filename) return res.status(400).json({ error: 'Missing X-Filename header.' });

  // Sanitize: only allow .csv, no path traversal
  const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  if (extname(safeName).toLowerCase() !== '.csv') {
    return res.status(400).json({ error: 'Only .csv files are allowed.' });
  }

  try {
    await writeFile(join(DATA_DIR, safeName), req.body);
    console.log(`[Upload] Saved ${safeName} to data/`);
    res.json({ message: `Uploaded ${safeName}`, filename: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview leads from all data files
app.get('/api/leads', async (_req, res) => {
  try {
    const leads = await readLeads();
    res.json({ total: leads.length, leads: leads.slice(0, 200) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test Groq message generation (no DM sent)
app.post('/api/test-message', async (req, res) => {
  const { name, bio, campaignContext, ctaLink, model } = req.body;
  if (!ctaLink) {
    return res.status(400).json({ error: 'ctaLink is required.' });
  }
  try {
    const finalContext = buildCampaignContext(campaignContext);
    const message = await generateMessage({
      name: name || 'Test User',
      bio: bio || '',
      campaignContext: finalContext,
      ctaLink,
      model: (model || '').trim() || undefined,
    });
    res.json({ message, campaignContextUsed: finalContext });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a campaign
app.post('/api/start', async (req, res) => {
  if (campaignRunning) {
    return res.status(409).json({ error: 'A campaign is already running.' });
  }

  const { campaignContext, ctaLink, dailyLimit, model } = req.body;
  if (!ctaLink || !dailyLimit) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const limit = Math.min(Math.max(parseInt(dailyLimit, 10) || 1, 1), 100);
  const selectedModel = (model || '').trim() || undefined;
  const finalCampaignContext = buildCampaignContext(campaignContext);

  // respond immediately — campaign runs in background
  res.json({ message: `Campaign started. Target: ${limit} DMs.` });

  // --- background campaign loop ---
  campaignRunning = true;
  campaignAbort = false;
  campaignStats = {
    total: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    current: '',
    config: {
      model: selectedModel || 'openai/gpt-oss-120b',
      ctaLink,
      dailyLimit: limit,
      notesLength: (campaignContext || '').trim().length,
      startedAt: new Date().toISOString(),
    },
  };

  try {
    const leads = await readLeads();
    const sentLog = await getSentLog();
    const sentUsernames = new Set(
      sentLog.filter(e => e.status === 'Sent').map(e => e.username)
    );

    const pending = leads.filter(l => !sentUsernames.has(l.username));
    campaignStats.total = Math.min(pending.length, limit);

    let sentCount = 0;

    for (const lead of pending) {
      if (campaignAbort || sentCount >= limit) break;

      campaignStats.current = lead.username;
      console.log(`\n[Campaign] Processing @${lead.username}...`);
      let generatedMessage = '';

      try {
        // 1. Generate personalised message
        generatedMessage = await generateMessage({
          name: lead.name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
          bio: lead.bio || '',
          campaignContext: finalCampaignContext,
          ctaLink,
          model: selectedModel,
        });
        console.log(`[Groq] Message for @${lead.username}: ${generatedMessage}`);

        // 2. Send DM via Puppeteer
        await sendDM(lead.username, generatedMessage);

        // 3. Log success
        await appendSentLog({
          username: lead.username,
          timestamp: new Date().toISOString(),
          message: generatedMessage,
          status: 'Sent',
          error: '',
        });
        await appendMetrics({ username: lead.username, status: 'Sent', error: '', message: generatedMessage });
        sentCount++;
        campaignStats.sent++;
        console.log(`[Campaign] ✓ Sent to @${lead.username} (${sentCount}/${limit})`);
      } catch (err) {
        campaignStats.failed++;
        await appendSentLog({
          username: lead.username,
          timestamp: new Date().toISOString(),
          message: generatedMessage,
          status: 'Failed',
          error: err.message,
        });
        await appendMetrics({ username: lead.username, status: 'Failed', error: err.message, message: generatedMessage });
        console.error(`[Campaign] ✗ Failed for @${lead.username}: ${err.message}`);
      }

      // 4. Rate-limit pause (~72-90 sec → ~40-50 DMs/hour) — skip on last message
      if (!campaignAbort && sentCount < limit) {
        const delaySec = Math.floor(Math.random() * (MAX_DELAY_SEC - MIN_DELAY_SEC + 1)) + MIN_DELAY_SEC;
        console.log(`[Campaign] Sleeping ${delaySec}s before next DM...`);
        await sleep(delaySec * 1000, () => campaignAbort);
      }
    }
  } catch (err) {
    console.error('[Campaign] Fatal error:', err);
  } finally {
    await closeBrowser();
    campaignRunning = false;
    campaignAbort = false;
    campaignStats.current = '';
    console.log('\n[Campaign] Finished.', campaignStats);
  }
});

// ---------- helpers ----------

/** Append a row to logs/dm_metrics.csv */
async function appendMetrics({ username, status, error, message }) {
  try {
    await access(METRICS_PATH);
  } catch {
    await appendFile(METRICS_PATH, 'Timestamp,Username,Status,Error_Reason,Generated_Message\n');
  }
  const ts = new Date().toISOString();
  const escape = s => `"${(s || '').replace(/"/g, '""')}"`;
  const row = `${ts},${escape(username)},${escape(status)},${escape(error)},${escape(message)}\n`;
  await appendFile(METRICS_PATH, row);
}

function sleep(ms, shouldAbort) {
  return new Promise(resolve => {
    const interval = setInterval(() => {
      if (shouldAbort()) { clearInterval(interval); resolve(); }
    }, 2000);
    setTimeout(() => { clearInterval(interval); resolve(); }, ms);
  });
}

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  Twitter DM Dashboard running at http://localhost:${PORT}\n`);
});
