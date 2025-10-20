import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMidMarketRate, getMidMarketSeries } from './frankfurter.js';
import { getMastercardRate, getMastercardSeries } from './mastercard-scraper.js';
import { getVisaRate, getVisaSeries } from './visa-scraper.js';
import { getAmexRate, getAmexSeries } from './amex-scraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/api/rate/:provider', async (req, res) => {
  try {
    const { provider } = req.params;
    const { date, base, quote } = req.query;
    const amount = Math.max(0, parseFloat(req.query.amount || '1') || 1);

    if (!date || !base || !quote) {
      return res.status(400).json({
        error: 'Missing required parameters: date, base, quote'
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        error: 'Invalid date format. Expected YYYY-MM-DD'
      });
    }

    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
      return res.status(400).json({
        error: 'Invalid currency format. Expected 3-letter codes (e.g., EUR, JPY)'
      });
    }

    const yesterday = new Date(date + 'T00:00:00Z');
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let rate, yesterdayRate, source;

    switch(provider) {
      case 'mid':
        rate = await getMidMarketRate(date, base, quote, amount);
        yesterdayRate = await getMidMarketRate(yesterdayStr, base, quote, amount).catch(() => null);
        source = 'ECB via Frankfurter';
        break;
      case 'mc':
        rate = await getMastercardRate(date, base, quote, amount);
        yesterdayRate = await getMastercardRate(yesterdayStr, base, quote, amount).catch(() => null);
        source = 'Mastercard';
        break;
      case 'visa':
        rate = await getVisaRate(date, base, quote, amount);
        yesterdayRate = await getVisaRate(yesterdayStr, base, quote, amount).catch(() => null);
        source = 'Visa';
        break;
      case 'amex':
        rate = await getAmexRate(date, base, quote, amount);
        if (rate === null) {
          return res.json({
            provider,
            date,
            base,
            quote,
            unavailable: true,
            reason: 'Currency pair not supported by Amex API',
            source: 'American Express'
          });
        }
        yesterdayRate = await getAmexRate(yesterdayStr, base, quote, amount).catch(() => null);
        source = 'American Express';
        break;
      default:
        return res.status(400).json({ error: 'Invalid provider. Use: mid, mc, visa, or amex' });
    }

    const dayDeltaPct = yesterdayRate ? ((rate - yesterdayRate) / yesterdayRate) * 100 : null;
    const converted = rate * amount;

    res.json({
      provider,
      date,
      base,
      quote,
      rate,
      amount,
      converted,
      dayDeltaPct,
      source
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch rate',
      details: error.message
    });
  }
});

app.get('/api/rates', async (req, res) => {
  try {
    const { date, base, quote } = req.query;
    const amount = Math.max(0, parseFloat(req.query.amount || '1') || 1);

    if (!date || !base || !quote) {
      return res.status(400).json({
        error: 'Missing required parameters: date, base, quote'
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        error: 'Invalid date format. Expected YYYY-MM-DD'
      });
    }

    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
      return res.status(400).json({
        error: 'Invalid currency format. Expected 3-letter codes (e.g., EUR, JPY)'
      });
    }

    const yesterday = new Date(date + 'T00:00:00Z');
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const [mid, mc, visa, amex, midYesterday, mcYesterday, visaYesterday, amexYesterday] = await Promise.all([
      getMidMarketRate(date, base, quote, amount),
      getMastercardRate(date, base, quote, amount),
      getVisaRate(date, base, quote, amount),
      getAmexRate(date, base, quote, amount),
      getMidMarketRate(yesterdayStr, base, quote, amount).catch(() => null),
      getMastercardRate(yesterdayStr, base, quote, amount).catch(() => null),
      getVisaRate(yesterdayStr, base, quote, amount).catch(() => null),
      getAmexRate(yesterdayStr, base, quote, amount).catch(() => null)
    ]);

    // Check if Amex rate is unavailable (null means unsupported currency pair)
    const amexUnavailable = amex === null;

    const mcDeltaPct = ((mc - mid) / mid) * 100;
    const visaDeltaPct = ((visa - mid) / mid) * 100;
    const amexDeltaPct = amexUnavailable ? null : ((amex - mid) / mid) * 100;

    const converted = {
      mid: mid * amount,
      mc: mc * amount,
      visa: visa * amount,
      amex: amexUnavailable ? null : amex * amount
    };

    const midDeltaPct = midYesterday ? ((mid - midYesterday) / midYesterday) * 100 : null;
    const mcDayDeltaPct = mcYesterday ? ((mc - mcYesterday) / mcYesterday) * 100 : null;
    const visaDayDeltaPct = visaYesterday ? ((visa - visaYesterday) / visaYesterday) * 100 : null;
    const amexDayDeltaPct = (amexUnavailable || !amexYesterday) ? null : ((amex - amexYesterday) / amexYesterday) * 100;

    res.json({
      date,
      base,
      quote,
      amount,
      mid,
      mc,
      visa,
      amex: amexUnavailable ? null : amex,
      amexUnavailable,
      converted,
      mcDeltaPct,
      visaDeltaPct,
      amexDeltaPct,
      midDeltaPct,
      mcDayDeltaPct,
      visaDayDeltaPct,
      amexDayDeltaPct,
      sources: {
        mid: 'ECB via Frankfurter',
        mc: 'Mastercard',
        visa: 'Visa',
        amex: 'American Express'
      }
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch rates',
      details: error.message
    });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const { date, base, quote, days } = req.query;

    if (!date || !base || !quote) {
      return res.status(400).json({
        error: 'Missing required parameters: date, base, quote'
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Expected YYYY-MM-DD' });
    }

    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
      return res.status(400).json({
        error: 'Invalid currency format. Expected 3-letter codes (e.g., EUR, JPY)'
      });
    }

    const numDays = Math.max(2, Math.min(60, parseInt(days || '30', 10) || 30));

    const end = new Date(date + 'T00:00:00Z');
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (numDays - 1));

    function fmt(d) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    const startStr = fmt(start);
    const endStr = fmt(end);

    const labels = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      labels.push(fmt(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const [midMap, mcSeriesRaw, visaSeriesRaw, amexSeriesRaw] = await Promise.all([
      getMidMarketSeries(startStr, endStr, base, quote),
      getMastercardSeries(startStr, endStr, base, quote),
      getVisaSeries(startStr, endStr, base, quote),
      getAmexSeries(startStr, endStr, base, quote)
    ]);

    const midSeries = [];
    let firstKnown = null;
    for (let i = 0; i < labels.length; i++) {
      const d = labels[i];
      if (midMap.has(d)) {
        firstKnown = midMap.get(d);
        break;
      }
    }
    let last = firstKnown;
    for (let i = 0; i < labels.length; i++) {
      const d = labels[i];
      if (midMap.has(d)) {
        last = midMap.get(d);
      }
      midSeries.push(last);
    }

    const mcSeries = mcSeriesRaw;
    const visaSeries = visaSeriesRaw;
    const amexSeries = amexSeriesRaw;

    const midAvg = midSeries.filter(v => v !== null).reduce((a, b) => a + b, 0) / midSeries.filter(v => v !== null).length;
    const mcAvg = mcSeries.filter(v => v !== null).reduce((a, b) => a + b, 0) / mcSeries.filter(v => v !== null).length;
    const visaAvg = visaSeries.filter(v => v !== null).reduce((a, b) => a + b, 0) / visaSeries.filter(v => v !== null).length;
    const amexAvg = amexSeries.filter(v => v !== null).reduce((a, b) => a + b, 0) / amexSeries.filter(v => v !== null).length;
    const mcAvgDeltaPct = ((mcAvg - midAvg) / midAvg) * 100;
    const visaAvgDeltaPct = ((visaAvg - midAvg) / midAvg) * 100;
    const amexAvgDeltaPct = ((amexAvg - midAvg) / midAvg) * 100;

    res.json({
      base,
      quote,
      start: startStr,
      end: endStr,
      labels,
      series: {
        mid: midSeries,
        mc: mcSeries,
        visa: visaSeries,
        amex: amexSeries
      },
      mcAvgDeltaPct,
      visaAvgDeltaPct,
      amexAvgDeltaPct,
      sources: {
        mid: 'ECB via Frankfurter (timeseries)',
        mc: 'Mastercard',
        visa: 'Visa',
        amex: 'American Express'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history', details: error.message });
  }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
export default app;
