async function launchBrowser() {
  const isProduction = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (isProduction) {
    // Production: Use @sparticuz/chromium (for Vercel/Lambda)
    const chromiumBinary = await import('@sparticuz/chromium');
    const chromium = chromiumBinary.default || chromiumBinary;
    const { chromium: playwright } = await import('playwright-core');

    const executablePath = await chromium.executablePath();

    return await playwright.launch({
      args: chromium.args,
      executablePath: executablePath,
      headless: chromium.headless,
    });
  } else {
    // Development: Use local Playwright
    const { chromium } = await import('playwright');
    return await chromium.launch({
      headless: true,
    });
  }
}

const VISA_URL = 'https://www.visa.co.uk/support/consumer/travel-support/exchange-rate-calculator.html';
const VISA_API_BASE = 'https://www.visa.co.uk/cmsapi/fx/rates';

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

let sharedBrowser = null;
let sharedPage = null;

function getCacheKey(date, base, quote, amount = 1) {
  return `${date}|${base}|${quote}|${amount}`;
}

function formatDateForVisa(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${month}%2F${day}%2F${year}`;
}

async function ensureBrowser() {
  if (!sharedBrowser || !sharedPage) {
    sharedBrowser = await launchBrowser();
    const context = await sharedBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 }
    });
    sharedPage = await context.newPage();
    await sharedPage.goto(VISA_URL, { waitUntil: 'networkidle' });
    await sharedPage.waitForTimeout(2000);
  }
  return sharedPage;
}

async function getVisaRateViaPlaywright(date, base, quote, amount = 1) {
  try {
    const page = await ensureBrowser();
    const formattedDate = formatDateForVisa(date);

    const params = { date, base, quote, amount };
    const expectedUrl = `${VISA_API_BASE}?amount=${amount}&fee=0&utcConvertedDate=${formattedDate}&exchangedate=${formattedDate}&fromCurr=${quote}&toCurr=${base}`;

    const apiPromise = page.waitForResponse(
      response => {
        const ok = response.url().includes('/cmsapi/fx/rates') && response.status() === 200;
        return ok;
      },
      { timeout: 25000 }
    );

    await page.evaluate(
      ({ url }) => {
        return fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          },
          credentials: 'include'
        });
      },
      { url: expectedUrl }
    );

    const response = await apiPromise;
    const data = await response.json();
    try { console.log(JSON.stringify({ circuit: 'Visa', event: 'api_hit', url: response.url(), status: response.status() })); } catch {}

    function logCircuit(name, params, url, json) {
      try {
        const payload = { circuit: name, params, request: url, response: json };
        console.log(JSON.stringify(payload, null, 2));
      } catch {}
    }

    if (data && data.originalValues && data.originalValues.toAmountWithAdditionalFee) {
      const converted = parseFloat(data.originalValues.toAmountWithAdditionalFee);
      if (!isNaN(converted)) {
        // Log once per circuit with request/response
        logCircuit('Visa', params, expectedUrl, data);
        const perUnit = amount > 0 ? converted / amount : converted;
        return perUnit;
      }
    }

    throw new Error('Could not parse Visa API response');
  } catch (error) {
    try { console.error(JSON.stringify({ circuit: 'Visa', error: error.message, stack: error.stack })); } catch {}
    return null;
  }
}

export async function closeBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
    sharedPage = null;
  }
}

export async function getVisaRate(date, base, quote, amount = 1) {
  const cacheKey = getCacheKey(date, base, quote, amount);

  if (cache.has(cacheKey)) {
    const { value, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) {
      return value;
    }
    cache.delete(cacheKey);
  }

  const apiRate = await getVisaRateViaPlaywright(date, base, quote, amount);
  if (apiRate !== null) {
    cache.set(cacheKey, { value: apiRate, timestamp: Date.now() });
    return apiRate;
  }

  throw new Error('Failed to fetch Visa rate from Playwright');
}

export async function getVisaSeries(startDate, endDate, base, quote) {
  function toDate(s) {
    return new Date(s + 'T00:00:00Z');
  }
  function fmt(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  const start = toDate(startDate);
  const end = toDate(endDate);
  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(fmt(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const series = [];
  let lastGood = null;
  for (const d of dates) {
    try {
      const r = await getVisaRate(d, base, quote);
      if (typeof r === 'number' && !Number.isNaN(r)) {
        lastGood = r;
        series.push(r);
      } else {
        series.push(lastGood);
      }
    } catch (e) {
      series.push(lastGood);
    }
  }
  return series;
}
