import puppeteer from 'puppeteer';
import { join } from 'path';

const AUTH_TOKEN = process.env.TWITTER_AUTH_TOKEN;
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH || undefined;
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR
  || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : undefined);
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || 'Default';
const USE_EXISTING_CHROME_PROFILE = (process.env.USE_EXISTING_CHROME_PROFILE || 'true').toLowerCase() !== 'false';

let _browser = null;
let _page = null;
const NAV_TIMEOUT_MS = 60000;
const SELECTOR_TIMEOUT_MS = 30000;
const DM_MAX_ATTEMPTS = 3;

const COMPOSER_SELECTORS = [
  'div[data-testid="dmComposerTextInput"][role="textbox"]',
  'div[data-testid="dmComposerTextInput"][contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[aria-label="Message Text"][contenteditable="true"]',
];

const PROFILE_DM_SELECTORS = [
  'button[data-testid="sendDMFromProfile"]',
  'a[href*="/messages/compose"]',
];

function isLoginUrl(url = '') {
  return /x\.com\/i\/flow\/login|twitter\.com\/i\/flow\/login/i.test(url);
}

async function applyAuthCookie(page) {
  if (!AUTH_TOKEN) return;
  await page.setCookie(
    {
      name: 'auth_token',
      value: AUTH_TOKEN,
      domain: '.x.com',
      path: '/',
      httpOnly: true,
      secure: true,
    },
    {
      name: 'auth_token',
      value: AUTH_TOKEN,
      domain: '.twitter.com',
      path: '/',
      httpOnly: true,
      secure: true,
    },
  );
}

async function findComposerSelector(page) {
  for (const selector of COMPOSER_SELECTORS) {
    const element = await page.waitForSelector(selector, { timeout: 5000 }).catch(() => null);
    if (element) return selector;
  }
  return '';
}

async function ensureLoggedIn(page) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  if (isLoginUrl(page.url())) {
    throw new Error('Not authenticated on X. Open Chrome with your main profile logged into x.com, or verify TWITTER_AUTH_TOKEN in .env.');
  }
}

/** Get or create a reusable browser + page with auth cookie already set. */
async function getPage() {
  if (_browser && _browser.connected) {
    // browser alive — reuse
    try { await _page.evaluate(() => true); return _page; } catch { /* page crashed, recreate */ }
  }

  // Launch fresh browser
  if (_browser) try { await _browser.close(); } catch {}

  const launchOptions = {
    headless: false,
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };

  if (CHROME_EXECUTABLE_PATH) {
    launchOptions.executablePath = CHROME_EXECUTABLE_PATH;
  }

  if (USE_EXISTING_CHROME_PROFILE && CHROME_USER_DATA_DIR) {
    launchOptions.userDataDir = CHROME_USER_DATA_DIR;
    launchOptions.args.push(`--profile-directory=${CHROME_PROFILE_DIR}`);
  }

  _browser = await puppeteer.launch(launchOptions);

  _page = await _browser.newPage();

  await applyAuthCookie(_page);
  await ensureLoggedIn(_page);

  return _page;
}

export async function sendDM(username, message) {
  if (!AUTH_TOKEN) throw new Error('TWITTER_AUTH_TOKEN not set in .env');

  const page = await getPage();
  const url = `https://twitter.com/messages/compose?recipient_id=${encodeURIComponent(username)}`;

  let lastError = null;
  for (let attempt = 1; attempt <= DM_MAX_ATTEMPTS; attempt++) {
    try {
      await applyAuthCookie(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

      if (isLoginUrl(page.url())) {
        throw new Error('Redirected to login. Session not authenticated in the selected Chrome profile.');
      }

      let inputSelector = await findComposerSelector(page);

      if (!inputSelector) {
        await page.goto(`https://x.com/${encodeURIComponent(username)}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        if (isLoginUrl(page.url())) {
          throw new Error('Redirected to login while opening recipient profile. Session not authenticated.');
        }

        for (const selector of PROFILE_DM_SELECTORS) {
          const element = await page.waitForSelector(selector, { timeout: SELECTOR_TIMEOUT_MS }).catch(() => null);
          if (element) {
            await element.click();
            break;
          }
        }

        inputSelector = await findComposerSelector(page);
      }

      if (!inputSelector) {
        for (const selector of COMPOSER_SELECTORS) {
          const element = await page.waitForSelector(selector, { timeout: SELECTOR_TIMEOUT_MS }).catch(() => null);
        if (element) {
          inputSelector = selector;
          break;
        }
      }
      }
      if (!inputSelector) {
        throw new Error('DM composer textbox not found after trying multiple selectors');
      }

      await page.click(inputSelector, { clickCount: 1 });
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.type(inputSelector, message, { delay: 25 + Math.random() * 20 });

      await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 2000));

      console.log(`[Puppeteer] DM sent to @${username}`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[Puppeteer] Attempt ${attempt}/${DM_MAX_ATTEMPTS} failed for @${username}: ${err.message}`);
      if (attempt < DM_MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 2500 * attempt));
      }
    }
  }

  throw new Error(lastError?.message || `Failed to send DM to @${username}`);
}

export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
    _page = null;
  }
}
