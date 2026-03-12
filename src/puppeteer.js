import puppeteer from 'puppeteer';

const AUTH_TOKEN = process.env.TWITTER_AUTH_TOKEN;

let _browser = null;
let _page = null;

/** Get or create a reusable browser + page with auth cookie already set. */
async function getPage() {
  if (_browser && _browser.connected) {
    // browser alive — reuse
    try { await _page.evaluate(() => true); return _page; } catch { /* page crashed, recreate */ }
  }

  // Launch fresh browser
  if (_browser) try { await _browser.close(); } catch {}

  _browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  _page = await _browser.newPage();

  await _page.setCookie({
    name: 'auth_token',
    value: AUTH_TOKEN,
    domain: '.twitter.com',
    path: '/',
    httpOnly: true,
    secure: true,
  });

  return _page;
}

export async function sendDM(username, message) {
  if (!AUTH_TOKEN) throw new Error('TWITTER_AUTH_TOKEN not set in .env');

  const page = await getPage();

  const url = `https://twitter.com/messages/compose?recipient_id=${encodeURIComponent(username)}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

  const inputSelector = 'div[data-testid="dmComposerTextInput"][role="textbox"]';
  await page.waitForSelector(inputSelector, { timeout: 15000 });

  await page.click(inputSelector);
  await page.type(inputSelector, message, { delay: 25 + Math.random() * 20 });

  await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 2000));

  console.log(`[Puppeteer] DM sent to @${username}`);
}

export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
    _page = null;
  }
}
