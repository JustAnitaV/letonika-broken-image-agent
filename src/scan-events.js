const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { chromium } = require('playwright');

dotenv.config();

const LETONIKA_USER = process.env.LETONIKA_USER;
const LETONIKA_PASSWORD = process.env.LETONIKA_PASSWORD;

if (!LETONIKA_USER || !LETONIKA_PASSWORD) {
  console.error('Missing LETONIKA_USER or LETONIKA_PASSWORD in environment. Copy .env.example to .env and set credentials.');
  process.exit(1);
}

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');
const REPORT_CSV = path.join(REPORTS_DIR, 'report.csv');

async function ensureDirs() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function appendCsvRow(eventId, title, imageUrl) {
  const line = [eventId, title || '', imageUrl || ''].map(csvEscape).join(',') + '\n';
  fs.appendFileSync(REPORT_CSV, line, 'utf8');
}

async function selectorExists(page, selector) {
  try {
    const el = await page.$(selector);
    return !!el;
  } catch (e) {
    return false;
  }
}

async function fillFirstAvailable(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.fill(value);
        return true;
      }
    } catch (e) {
      // ignore
    }
  }
  return false;
}

async function clickFirstAvailable(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch (e) {
      // ignore
    }
  }
  return false;
}

async function getTitleFromPage(page) {
  // Try a set of heuristics to find the event title
  const titleSelectors = [
    'input[name*=Title]',
    'input[id*=Title]',
    'input[id*=title]',
    'input[name*=title]',
    'input[type=text]',
    'h1',
    'h2',
    '.title',
    '.EventTitle',
  ];
  for (const sel of titleSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const tag = await el.evaluate((e) => e.tagName);
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const val = await el.evaluate((e) => e.value || e.getAttribute('value') || '');
          if (val && val.trim().length > 0) return val.trim();
        } else {
          const text = await el.evaluate((e) => e.textContent || '');
          if (text && text.trim().length > 0) return text.trim();
        }
      }
    } catch (e) {
      // continue
    }
  }

  // As a fallback, attempt to read a meta or other elements
  try {
    const fallback = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('input, textarea, h1, h2, label, span'));
      for (const c of candidates) {
        const t = (c.value || c.textContent || '').trim();
        if (t && t.length > 0 && t.length < 200) return t;
      }
      return null;
    });
    if (fallback) return fallback;
  } catch (e) {
    // ignore
  }

  return null;
}

async function findBrokenImagesInFrame(frame) {
  try {
    const imgs = await frame.$$eval('img', (nodes) =>
      nodes.map((img) => {
        return {
          src: img.src || img.getAttribute('src') || '',
          complete: !!img.complete,
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
        };
      })
    );

    const broken = imgs
      .map((i) => ({
        src: i.src,
        broken: !i.complete || i.naturalWidth === 0 || i.naturalHeight === 0,
      }))
      .filter((i) => i.src && i.broken);

    // Normalize URLs to absolute using frame's location
    const normalized = broken.map((b) => ({ src: b.src }));
    return normalized;
  } catch (e) {
    return [];
  }
}

async function scan() {
  await ensureDirs();

  // Initialize CSV with header if not exists
  if (!fs.existsSync(REPORT_CSV)) {
    fs.writeFileSync(REPORT_CSV, 'EventID,Title,ImageURL\n', 'utf8');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating to login page...');
  await page.goto('https://letonika.lv/editor/', { timeout: 60000 });

  // Heuristics for username/password fields
  const usernameSelectors = [
    'input[name=LETONIKA_USER]',
    'input[name=username]',
    'input[name=UserName]',
    'input[id*=UserName]',
    'input[type=text]',
    'input[placeholder*=lietot]',
  ];
  const passwordSelectors = [
    'input[name=LETONIKA_PASSWORD]',
    'input[name=password]',
    'input[name=Password]',
    'input[id*=Password]',
    'input[type=password]',
    'input[placeholder*=parole]',
  ];

  // Fill username
  const filledUser = await fillFirstAvailable(page, usernameSelectors, LETONIKA_USER);
  if (!filledUser) {
    console.warn('Could not find a username field with default selectors — attempting to focus first text input and type.');
    try {
      const firstText = await page.$('input[type=text]');
      if (firstText) await firstText.fill(LETONIKA_USER);
    } catch (e) {
      // ignore
    }
  }

  // Fill password
  const filledPass = await fillFirstAvailable(page, passwordSelectors, LETONIKA_PASSWORD);
  if (!filledPass) {
    console.warn('Could not find a password field with default selectors — attempting to focus first password input and type.');
    try {
      const firstPass = await page.$('input[type=password]');
      if (firstPass) await firstPass.fill(LETONIKA_PASSWORD);
    } catch (e) {
      // ignore
    }
  }

  // Click the "Pieslēgties" button
  const loginSelectors = [
    'text=Pieslēgties',
    'button:has-text("Pieslēgties")',
    'input[type=submit]',
    'button[type=submit]'
  ];
  const clicked = await clickFirstAvailable(page, loginSelectors);
  if (!clicked) {
    console.warn('Could not find a login button by heuristics. Attempting to press Enter in password field.');
    try {
      await page.keyboard.press('Enter');
    } catch (e) {}
  }

  // Wait for navigation after login
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch (e) {
    // ignore
  }

  console.log('Opening Events editor...');
  await page.goto('https://letonika.lv/editor/FrontPageEditor.aspx?type=Events', { timeout: 60000 });

  const START_ID = 1;
  const END_ID = 6000;

  let processed = 0;
  for (let id = START_ID; id <= END_ID; id++) {
    const url = `https://letonika.lv/editor/FrontPageEditor.aspx?type=Events&id=${id}`;
    try {
      await page.goto(url, { timeout: 60000 });

      // Determine if page has meaningful content (title or editor)
      const title = await getTitleFromPage(page);
      if (!title) {
        // empty or invalid record
        processed++;
        if (processed % 100 === 0) console.log(`Processed ${processed}/${END_ID - START_ID + 1} (last id ${id}) -- no title found, skipping`);
        continue;
      }

      // Collect broken images across all frames (main document + iframes)
      const allBroken = [];
      const frames = page.frames();
      for (const frame of frames) {
        const brokenInFrame = await findBrokenImagesInFrame(frame);
        for (const b of brokenInFrame) allBroken.push(b.src);
      }

      if (allBroken.length > 0) {
        // Save screenshot
        const screenshotPath = path.join(SCREENSHOTS_DIR, `${id}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // Append all broken images to CSV
        for (const img of allBroken) {
          await appendCsvRow(id, title, img);
        }

        console.log(`ID ${id}: Found ${allBroken.length} broken image(s) — saved screenshot to ${screenshotPath}`);
      }

    } catch (err) {
      console.error(`Error processing id=${id}: ${err.message}`);
      // continue to next id
    }

    processed++;
    if (processed % 100 === 0) console.log(`Progress: ${processed}/${END_ID - START_ID + 1} (up to id ${id})`);
  }

  await browser.close();
  console.log('Scan complete. Report saved to', REPORT_CSV);
}

scan().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
