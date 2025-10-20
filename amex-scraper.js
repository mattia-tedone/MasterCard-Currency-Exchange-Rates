import { chromium } from 'playwright';
import { getMidMarketRate } from './frankfurter.js';

const AMEX_URL = 'https://www.americanexpress.com/en-us/foreign-exchange/fxrates/';
const AMEX_API_BASE = 'https://www.americanexpress.com/gemservices/gcdt/ecbrates/';

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

let sharedBrowser = null;
let sharedPage = null;

// ICC (International Card Center) supports all currencies
// Use individual country codes for better regional rates where available
const currencyToCountry = {
  // European currencies - use specific country codes for better rates
  'EUR': 'IT',
  'GBP': 'UK',
  'SEK': 'SE',
  'DKK': 'DK',
  'NOK': 'NO',
  'PLN': 'PL',
  'CZK': 'CZ',
  'HUF': 'HU',

  // All other currencies - use ICC (International Card Center)
  'USD': 'ICC',
  'JPY': 'ICC',
  'CHF': 'ICC',
  'CAD': 'ICC',
  'AUD': 'ICC',
  'NZD': 'ICC',
  'RON': 'ICC',
  'BGN': 'ICC',
  'HRK': 'ICC',
  'RUB': 'ICC',
  'TRY': 'ICC',
  'BRL': 'ICC',
  'CNY': 'ICC',
  'HKD': 'ICC',
  'IDR': 'ICC',
  'ILS': 'ICC',
  'INR': 'ICC',
  'KRW': 'ICC',
  'MXN': 'ICC',
  'MYR': 'ICC',
  'PHP': 'ICC',
  'SGD': 'ICC',
  'THB': 'ICC',
  'ZAR': 'ICC',
  'ISK': 'ICC'
};

function getCacheKey(date, base, quote) {
  return `${date}|${base}|${quote}`;
}

async function ensureBrowser() {
  if (!sharedBrowser || !sharedPage) {
    sharedBrowser = await chromium.launch({ headless: true });
    const context = await sharedBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 }
    });

    sharedPage = await context.newPage();
    await sharedPage.goto(AMEX_URL, { waitUntil: 'networkidle' });
    await sharedPage.waitForTimeout(2000);
  }
  return sharedPage;
}

async function getAmexRateViaPlaywright(date, base, quote, amount = 1) {
  try {
    const page = await ensureBrowser();
    const ecbRate = await getMidMarketRate(date, base, quote);
    const market = currencyToCountry[base] || 'ICC';
    const params = { date, base, quote, market, amount };

    const apiPromise = page.waitForResponse(
      response => response.url().includes('/gemservices/gcdt/ecbrates/') && response.status() === 200,
      { timeout: 15000 }
    );

    await page.evaluate(
      ({ apiBase, market }) => {
        const url = `${apiBase}?market=${market}`;
        return fetch(url, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          credentials: 'include'
        });
      },
      { apiBase: AMEX_API_BASE, market }
    );

    const response = await apiPromise;
    const data = await response.json();

    function logCircuit(name, params, url, json) {
      try {
        const payload = { circuit: name, params, request: url, response: json };
        console.log(JSON.stringify(payload, null, 2));
      } catch {}
    }

    if (data && Array.isArray(data) && data.length > 0) {
      // ICC returns 2 entries: EURO and USD settlement currencies
      // For other markets, returns 1 entry with specific settlement currency

      // Find the entry that matches our base currency
      let rateData = null;

      if (market === 'ICC') {
        // ICC returns 2 entries: EURO and USD settlement currencies
        // ICC uses "EURO" instead of "EUR" for the settlement currency
        const normalizedBase = base === 'EUR' ? 'EURO' : base;
        const normalizedQuote = quote === 'EUR' ? 'EURO' : quote;

        // CASE A: Try to find entry with base as settlementCurrency (e.g., EUR→JPY)
        rateData = data.find(entry => entry.settlementCurrency === normalizedBase);
        let needsInversion = false;

        if (!rateData) {
          // CASE B: Not found → try to find entry with quote as settlementCurrency (e.g., JPY→EUR)
          // We'll need to invert the calculation
          rateData = data.find(entry => entry.settlementCurrency === normalizedQuote);
          needsInversion = true;
        }

        // If neither base nor quote are settlementCurrency in ICC (e.g., JPY→GBP, CHF→AUD)
        // we cannot accurately calculate the rate, so return null
        if (!rateData) {
          console.log(`[Amex] Unsupported currency pair for ICC: ${base}→${quote} (neither is settlementCurrency)`);
          return null;
        }

        if (rateData && rateData.consumer) {
          let quoteData;

          if (needsInversion) {
            // For inversion (e.g., JPY→EUR), find BASE in consumer rates
            // We have entry for EURO, so we look for JPY in consumer
            quoteData = rateData.consumer.find(c => c.submissionCurrencyCode === base);
          } else {
            // Normal case: find QUOTE in consumer rates (e.g., EUR→JPY)
            quoteData = rateData.consumer.find(c => c.submissionCurrencyCode === quote);
          }

          if (quoteData && quoteData.percentageVariance) {
            const variance = parseFloat(quoteData.percentageVariance);
            const multiplier = 1 + variance / 100;

            // Apply or invert the multiplier based on the case
            const amexRate = needsInversion
              ? ecbRate / multiplier  // INVERSION: divide instead of multiply
              : ecbRate * multiplier; // NORMAL: multiply

            // Log once per circuit with request/response
            const url = `${AMEX_API_BASE}?market=${market}`;
            logCircuit('Amex', params, url, data);
            return amexRate;
          }
        }
      } else {
        // For specific country markets, use the first entry
        rateData = data[0];

        if (rateData && rateData.consumer) {
          const quoteData = rateData.consumer.find(c => c.submissionCurrencyCode === quote);

          if (quoteData && quoteData.percentageVariance) {
            const variance = parseFloat(quoteData.percentageVariance);
            const amexRate = ecbRate * (1 + variance / 100);

            // Log once per circuit with request/response
            const url = `${AMEX_API_BASE}?market=${market}`;
            logCircuit('Amex', params, url, data);
            return amexRate;
          }
        }
      }
    }

    throw new Error('Could not parse Amex API response');
  } catch (error) {
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

export async function getAmexRate(date, base, quote, amount = 1) {
  const cacheKey = getCacheKey(date, base, quote);

  if (cache.has(cacheKey)) {
    const { value, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) {
      return value;
    }
    cache.delete(cacheKey);
  }

  const apiRate = await getAmexRateViaPlaywright(date, base, quote, amount);
  if (apiRate !== null) {
    cache.set(cacheKey, { value: apiRate, timestamp: Date.now() });
    return apiRate;
  }

  // Return null for unsupported currency pairs instead of throwing error
  return null;
}

export async function getAmexSeries(startDate, endDate, base, quote) {
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
      const r = await getAmexRate(d, base, quote);
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
