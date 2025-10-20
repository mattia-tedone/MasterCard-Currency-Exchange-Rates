import axios from 'axios';

const MASTERCARD_URL = 'https://www.mastercard.com/global/en/personal/get-support/currency-exchange-rate-converter.html';
const MASTERCARD_API_BASE = 'https://www.mastercard.com/marketingservices/public/mccom-services/currency-conversions';

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

function getCacheKey(date, base, quote, amount = 1) {
  return `${date}|${base}|${quote}|${amount}`;
}

function logCircuit(name, params, url, json) {
  try {
    const payload = {
      circuit: name,
      params,
      request: url,
      response: json
    };
    // Single structured log per circuit
    console.log(JSON.stringify(payload, null, 2));
  } catch {}
}

async function getMastercardRateViaAPI(date, base, quote, amount = 1) {
  try {
    const url = `${MASTERCARD_API_BASE}/conversion-rates?exchange_date=${date}&transaction_currency=${base}&cardholder_billing_currency=${quote}&bank_fee=0&transaction_amount=${amount}`;

    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': MASTERCARD_URL,
        'Origin': 'https://www.mastercard.com',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
      }
    });

    if (response.data && response.data.data) {
      // Prefer converted amount when available to reflect rounding by amount
      const data = response.data.data;
      // Log once per circuit with request/response
      logCircuit('Mastercard', { date, base, quote, amount }, url, response.data);
      if (data.crdhldBillAmt) {
        const converted = parseFloat(data.crdhldBillAmt);
        if (!Number.isNaN(converted) && amount > 0) {
          return converted / amount;
        }
      }
      if (data.conversionRate) {
        const perUnit = parseFloat(data.conversionRate);
        if (!Number.isNaN(perUnit)) return perUnit;
      }
    }

    throw new Error('Could not parse API response');
  } catch (error) {
    return null;
  }
}

export async function getMastercardRate(date, base, quote, amount = 1) {
  const cacheKey = getCacheKey(date, base, quote, amount);

  if (cache.has(cacheKey)) {
    const { value, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) {
      return value;
    }
    cache.delete(cacheKey);
  }

  const apiRate = await getMastercardRateViaAPI(date, base, quote, amount);
  if (apiRate !== null) {
    cache.set(cacheKey, { value: apiRate, timestamp: Date.now() });
    return apiRate;
  }

  throw new Error('Failed to fetch Mastercard rate from API');
}

export async function getMastercardSeries(startDate, endDate, base, quote) {
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
      const r = await getMastercardRate(d, base, quote);
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
