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

async function appendCsvRow(eventId, eventDate, title, imageUrl, reason) {
  const line = [
    eventId,
    eventDate || '',
    title || '',
    imageUrl || '',
    reason || ''
  ].map(csvEscape).join(',') + '\n';
 
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

async function collectImageUrlsInFrame(frame, page) {
  try {
    const srcs = await frame.$$eval('img', (nodes) =>
      nodes.map((img) => img.getAttribute('src') || img.src || '')
    );
 
    const urls = [];
 
    for (const raw of srcs) {
      if (!raw) continue;
 
      const trimmed = raw.trim();
      if (!trimmed) continue;
 
      if (
        trimmed.startsWith('data:') ||
        trimmed.startsWith('blob:') ||
        trimmed.startsWith('javascript:') ||
        trimmed.startsWith('about:')
      ) {
        continue;
      }
 
      try {
        const base = frame.url() || page.url();
        const absoluteUrl = new URL(trimmed, base).href;
        // Skip TinyMCE editor icons
        if (absoluteUrl.includes('/editor/tinymce/')) {
          continue;
        }
        urls.push(absoluteUrl);
      } catch (e) {
        // skip invalid URLs
      }
    }
 
    return urls;
  } catch (e) {
    return [];
  }
}
 
function reasonFromStatus(status) {
  if (status === 403) return 'HTTP_403';
  if (status === 404) return 'HTTP_404';
  if (status >= 500 && status < 600) return 'HTTP_500';
  return `HTTP_${status}`;
}
 
async function checkImageUrl(context, imageUrl) {
  try {
    const response = await context.request.get(imageUrl);
    console.log(`Checking image: ${imageUrl}`);
 
    if (!response) {
      return {
        broken: true,
        reason: 'REQUEST_ERROR',
      };
    }
 
    const status = response.status();
 
    if (status >= 400) {
      return {
        broken: true,
        reason: reasonFromStatus(status),
      };
    }
 
    return {
      broken: false,
      reason: '',
    };
  } catch (e) {
    return {
      broken: true,
      reason: 'REQUEST_ERROR',
    };
  }
}



async function extractEventDate(page) {
  try {
    // Run DOM logic inside the page to reliably locate the "Notikuma datums" container
    const dateStr = await page.evaluate(() => {
      function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return true;
      }

      function tryNormalizeParts(parts) {
        if (!parts || parts.length < 3) return null;
        const y = String(parts[0]).trim();
        const mo = String(parts[1]).trim();
        const d = String(parts[2]).trim();
        if (!/^\d{4}$/.test(y)) return null;
        if (!/^\d{1,2}$/.test(mo)) return null;
        if (!/^\d{1,2}$/.test(d)) return null;
        const mi = parseInt(mo, 10);
        const di = parseInt(d, 10);
        if (mi < 1 || mi > 12) return null;
        if (di < 1 || di > 31) return null;
        const moP = String(mi).padStart(2, '0');
        const dP = String(di).padStart(2, '0');
        return `${y}-${moP}-${dP}`;
      }

      // 1) Prefer fieldset/containers whose legend or visible heading contains "Notikuma datums"
      const textMatcher = /Notikuma\s+datums/i;

      // Check fieldsets first
      const fieldsets = Array.from(document.querySelectorAll('fieldset'));
      for (const fs of fieldsets) {
        const legend = fs.querySelector('legend');
        if (legend && textMatcher.test(legend.textContent || '')) {
          const inputs = Array.from(fs.querySelectorAll('input')).filter(i => !i.disabled && i.type !== 'hidden');
          if (inputs.length >= 3) {
            const vals = [inputs[0].value, inputs[1].value, inputs[2].value];
            const iso = tryNormalizeParts(vals);
            if (iso) return iso;
          }
        }
      }

      // Search common heading labels near inputs
      const headingSelectors = ['legend', 'label', 'h1', 'h2', 'h3', 'h4', 'strong', 'b'];
      for (const sel of headingSelectors) {
        const nodes = Array.from(document.querySelectorAll(sel));
        for (const node of nodes) {
          if (textMatcher.test(node.textContent || '')) {
            // look for inputs inside the closest container (fieldset, .form-group, .editor, div)
            const container = node.closest('fieldset, .form-group, .editor, .editor-section, .container, .row, div') || node.parentElement;
            if (container) {
              const inputs = Array.from(container.querySelectorAll('input')).filter(i => !i.disabled && i.type !== 'hidden');
              if (inputs.length >= 3) {
                const vals = [inputs[0].value, inputs[1].value, inputs[2].value];
                const iso = tryNormalizeParts(vals);
                if (iso) return iso;
              }
              // also try to look in siblings
              const siblingInputs = Array.from(container.parentElement ? container.parentElement.querySelectorAll('input') : []).filter(i => !i.disabled && i.type !== 'hidden');
              if (siblingInputs.length >= 3) {
                const vals2 = [siblingInputs[0].value, siblingInputs[1].value, siblingInputs[2].value];
                const iso2 = tryNormalizeParts(vals2);
                if (iso2) return iso2;
              }
            }
          }
        }
      }

      // 2) Fallback: first three small text inputs on the page, but only if they look like year/month/day
      const allInputs = Array.from(document.querySelectorAll('input')).filter(i => !i.disabled && i.type !== 'hidden' && isVisible(i));
      if (allInputs.length >= 3) {
        // prefer inputs with small maxlength or class names that indicate date parts
        const candidates = allInputs.slice(0, 10); // limit search
        for (let i = 0; i <= Math.max(0, candidates.length - 3); i++) {
          const a = candidates[i];
          const b = candidates[i + 1];
          const c = candidates[i + 2];
          if (!a || !b || !c) continue;
          const vals = [a.value, b.value, c.value].map(v => (v || '').trim());
          const iso = tryNormalizeParts(vals);
          if (iso) return iso;
        }
      }

      return null;
    });

    if (!dateStr) return null;

    // dateStr should already be YYYY-MM-DD
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return dateStr;
  } catch (e) {
    return null;
  }
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



async function scan() {
  await ensureDirs();

  // Initialize CSV with header if not exists
  if (!fs.existsSync(REPORT_CSV)) {
    fs.writeFileSync(REPORT_CSV, 'EventID,EventDate,Title,ImageURL,Reason\n', 'utf8');
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
  const END_ID = 6500;

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
      const eventDate = await extractEventDate(page);

      // Collect image URLs across all frames
      const allBroken = [];
      const frames = page.frames();
 
      for (const frame of frames) {
        const imageUrls = await collectImageUrlsInFrame(frame, page);
 
        for (const imageUrl of imageUrls) {
          const result = await checkImageUrl(context, imageUrl);
 
          if (result.broken) {
            allBroken.push({
              src: imageUrl,
              reason: result.reason
            });
          }
        }
      }

      if (allBroken.length > 0) {
        // Save screenshot
        const screenshotPath = path.join(SCREENSHOTS_DIR, `${id}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // Append all broken images to CSV
    
        for (const img of allBroken) {
          await appendCsvRow(
            id,
            eventDate,
            title,
            img.src,
            img.reason
          );
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
