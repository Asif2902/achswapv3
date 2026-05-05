import { serializeAndCompress, deserializeAndDecompress, monitorRedisHealth } from './utils/redis.js';

const TTL_SECONDS = 600; // 10 minutes
const MAX_CACHED_TXS = 50;

function optimizeBridgeData(data) {
  const recentTxs = Array.isArray(data.transactions) 
    ? data.transactions.slice(0, MAX_CACHED_TXS) 
    : [];

  const strippedTxs = recentTxs.map(tx => ({
    hash: tx.hash,
    amount: tx.amount,
    timestamp: tx.timestamp,
    token: tx.token,
    status: tx.status
  }));

  return {
    totalVolume: data.totalVolume || 0,
    transactionCount: data.transactionCount || 0,
    transactions: strippedTxs
  };
}

function getCircleIrisBaseUrl() {
  const configuredHost = String(process.env.CIRCLE_IRIS_HOST || "").trim().replace(/\/+$/, "");
  if (!configuredHost) return "https://iris-api-sandbox.circle.com";
  if (/^https:\/\//i.test(configuredHost)) return configuredHost;
  if (/^http:\/\//i.test(configuredHost)) {
    throw new Error("Insecure CIRCLE_IRIS_HOST is disallowed");
  }
  return `https://${configuredHost}`;
}

function mapCircleMessageToTransaction(message) {
  return {
    hash: typeof message?.transactionHash === "string" ? message.transactionHash : "",
    amount: message?.amount != null ? String(message.amount) : "0",
    timestamp: message?.blockTimestamp || message?.timestamp || message?.createdAt || null,
    token: typeof message?.token === "string" && message.token ? message.token : "USDC",
    status: typeof message?.status === "string" && message.status ? message.status : "unknown",
  };
}

async function fetchBridgeTransactionsAPI(sourceDomainId, transactionHash) {
  const baseUrl = getCircleIrisBaseUrl();
  const endpoint = new URL(`/v2/messages/${encodeURIComponent(String(sourceDomainId))}`, `${baseUrl}/`);
  if (transactionHash) {
    endpoint.searchParams.set("transactionHash", transactionHash);
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Upstream Circle Iris endpoint ${endpoint.pathname} returned ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data || !Array.isArray(data.messages)) {
      throw new Error(`Invalid response shape from Circle Iris endpoint ${endpoint.pathname}: expected messages array`);
    }

    const transactions = data.messages.map(mapCircleMessageToTransaction);
    const totalVolume = transactions.reduce((sum, tx) => {
      const amount = Number(tx.amount);
      return Number.isFinite(amount) ? sum + amount : sum;
    }, 0);
    
    return {
      transactions,
      totalVolume,
      transactionCount: transactions.length,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let rawSourceDomainId = req.query.sourceDomainId ?? req.body?.sourceDomainId ?? '';
    if (Array.isArray(rawSourceDomainId)) rawSourceDomainId = rawSourceDomainId[0] ?? '';
    if (
      rawSourceDomainId == null
      || rawSourceDomainId === ''
      || (typeof rawSourceDomainId === 'string' && rawSourceDomainId.trim() === '')
    ) {
      return res.status(400).json({ error: 'Missing sourceDomainId' });
    }
    const sourceDomainId = Number(rawSourceDomainId);
    
    if (!Number.isInteger(sourceDomainId) || sourceDomainId < 0) {
      return res.status(400).json({ error: 'Invalid sourceDomainId' });
    }

    let rawTransactionHash = req.query.transactionHash || req.body?.transactionHash || '';
    if (Array.isArray(rawTransactionHash)) rawTransactionHash = rawTransactionHash[0];
    const transactionHash = String(rawTransactionHash || '').trim().toLowerCase();

    if (transactionHash && !/^0x[a-f0-9]{64}$/.test(transactionHash)) {
      return res.status(400).json({ error: 'Invalid transactionHash' });
    }

    monitorRedisHealth(); // Fire & forget monitor

    const cacheKey = `bridge:transactions:${sourceDomainId}:${transactionHash || 'all'}`;
    
    // 1. Try Cache
    try {
      const cachedObj = await deserializeAndDecompress(cacheKey);
      if (cachedObj) {
        return res.status(200).json({ ...cachedObj, cached: true });
      }
    } catch (e) {
      console.error(`[Redis] Cache Read Error:`, e.message);
    }

    // 2. Fetch Data
    const rawData = await fetchBridgeTransactionsAPI(sourceDomainId, transactionHash || undefined);
    const optimizedData = optimizeBridgeData(rawData);

    // 3. Set Cache
    try {
      await serializeAndCompress(cacheKey, optimizedData, TTL_SECONDS);
    } catch (e) {
      console.error(`[Redis] Cache Write Error:`, e.message);
    }

    return res.status(200).json({ ...optimizedData, cached: false });
  } catch (error) {
    console.error('API Error (bridge-transactions):', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
