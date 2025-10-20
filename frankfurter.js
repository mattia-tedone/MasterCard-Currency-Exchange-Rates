import axios from 'axios';

const FRANKFURTER_API = 'https://api.frankfurter.app';

/**
 * Get mid-market rate from ECB via Frankfurter API
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {string} base - Base currency (e.g., 'EUR')
 * @param {string} quote - Quote currency (e.g., 'JPY')
 * @returns {Promise<number>} - Exchange rate (quote per 1 base)
 */
export async function getMidMarketRate(date, base, quote) {
  try {
    // If both currencies are the same, rate is 1
    if (base === quote) {
      return 1.0;
    }

    // Frankfurter uses EUR as base, so we need to handle different scenarios
    if (base === 'EUR') {
      // Direct: EUR -> quote
      const url = `${FRANKFURTER_API}/${date}`;
      const response = await axios.get(url, {
        params: {
          from: 'EUR',
          to: quote
        }
      });
      // Log once per circuit
      try { console.log(JSON.stringify({ circuit: 'Mid', params: { date, base, quote }, request: `${url}?from=EUR&to=${quote}`, response: response.data }, null, 2)); } catch {}
      return response.data.rates[quote];
    } else if (quote === 'EUR') {
      // Reverse: base -> EUR (get EUR -> base and invert)
      const url = `${FRANKFURTER_API}/${date}`;
      const response = await axios.get(url, {
        params: {
          from: 'EUR',
          to: base
        }
      });
      try { console.log(JSON.stringify({ circuit: 'Mid', params: { date, base, quote }, request: `${url}?from=EUR&to=${base}`, response: response.data }, null, 2)); } catch {}
      return 1 / response.data.rates[base];
    } else {
      // Cross-rate: base -> quote (via EUR)
      // Get both EUR -> base and EUR -> quote, then calculate cross-rate
      const url = `${FRANKFURTER_API}/${date}`;
      const response = await axios.get(url, {
        params: {
          from: 'EUR',
          to: `${base},${quote}`
        }
      });

      const eurToBase = response.data.rates[base];
      const eurToQuote = response.data.rates[quote];
      try { console.log(JSON.stringify({ circuit: 'Mid', params: { date, base, quote }, request: `${url}?from=EUR&to=${base},${quote}`, response: response.data }, null, 2)); } catch {}

      // Cross-rate: (EUR -> quote) / (EUR -> base) = base -> quote
      return eurToQuote / eurToBase;
    }
  } catch (error) {
    if (error.response?.status === 404) {
      // Date not available (weekend/holiday), try to get the latest available rate before this date
      const url = `${FRANKFURTER_API}/latest`;
      const latestResponse = await axios.get(url, {
        params: {
          from: base === 'EUR' ? 'EUR' : 'EUR',
          to: base === 'EUR' ? quote : `${base},${quote}`
        }
      });

      try { console.log(JSON.stringify({ circuit: 'Mid', params: { date, base, quote }, request: `${url}?from=EUR&to=${base === 'EUR' ? quote : `${base},${quote}`}`, response: latestResponse.data }, null, 2)); } catch {}
      if (base === 'EUR') {
        return latestResponse.data.rates[quote];
      } else if (quote === 'EUR') {
        return 1 / latestResponse.data.rates[base];
      } else {
        const eurToBase = latestResponse.data.rates[base];
        const eurToQuote = latestResponse.data.rates[quote];
        return eurToQuote / eurToBase;
      }
    }
    throw new Error(`Failed to fetch mid-market rate: ${error.message}`);
  }
}

/**
 * Get mid-market timeseries between two dates (inclusive)
 * Returns a Map of YYYY-MM-DD -> rate (quote per 1 base)
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @param {string} base
 * @param {string} quote
 * @returns {Promise<Map<string, number>>}
 */
export async function getMidMarketSeries(startDate, endDate, base, quote) {
  // Shortcut: identical currencies
  if (base === quote) {
    // Build a synthetic map with 1.0 for each business day
    const url = `${FRANKFURTER_API}/${startDate}..${endDate}`;
    const resp = await axios.get(url, { params: { from: 'EUR', to: 'EUR' } });
    const map = new Map();
    Object.keys(resp.data.rates).forEach((d) => map.set(d, 1.0));
    return map;
  }

  // Frankfurter uses EUR base; compute cross-rates when needed
  const params = { from: 'EUR', to: base === 'EUR' || quote === 'EUR' ? (base === 'EUR' ? quote : base) : `${base},${quote}` };

  const url = `${FRANKFURTER_API}/${startDate}..${endDate}`;
  const response = await axios.get(url, { params });
  const ratesByDate = response.data.rates || {};

  const map = new Map();
  for (const [d, entries] of Object.entries(ratesByDate)) {
    let rate;
    if (base === 'EUR') {
      rate = entries[quote];
    } else if (quote === 'EUR') {
      rate = 1 / entries[base];
    } else {
      // entries holds EUR->base and EUR->quote
      const eurToBase = entries[base];
      const eurToQuote = entries[quote];
      rate = eurToQuote / eurToBase;
    }
    if (typeof rate === 'number' && !Number.isNaN(rate)) {
      map.set(d, rate);
    }
  }
  return map;
}
