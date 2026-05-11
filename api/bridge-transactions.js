import { serializeAndCompressAsync, deserializeAndDecompress, monitorRedisHealth } from './utils/redis.js';

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

function mapCircleMessageToTransaction(message, requestedTransactionHash = "") {
  const decoded = parseCircleMessageBody(message?.decodedMessage?.messageBody);
  return {
    hash: decoded?.hash || message?.transactionHash || message?.txHash || requestedTransactionHash || "",
    amount: decoded?.amount || (message?.amount != null ? String(message.amount) : "0"),
    timestamp: message?.blockTimestamp || message?.timestamp || message?.createdAt || null,
    token: decoded?.token || (typeof message?.token === "string" && message.token ? message.token : "USDC"),
    status: typeof message?.status === "string" && message.status ? message.status : "unknown",
    rawMessage: message,
  };
}

function parseCircleMessageBody(messageBody) {
  const normalized = typeof messageBody === "string" ? messageBody.trim().toLowerCase() : "";
  if (!/^0x[0-9a-f]+$/.test(normalized)) return null;

  try {
    const body = normalized.slice(2);
    const word = (index) => body.slice(index * 64, (index + 1) * 64);
    const addressFromWord = (value) => {
      if (!/^[0-9a-f]{64}$/.test(value)) return "";
      return `0x${value.slice(24)}`;
    };

    const token = addressFromWord(word(0));
    const amountWord = word(2);
    const amount = /^[0-9a-f]{64}$/.test(amountWord)
      ? BigInt(`0x${amountWord}`).toString()
      : "0";

    return { amount, hash: "", token };
  } catch {
    return null;
  }
}

async function fetchBridgeTransactionsAPI(sourceDomainId, transactionHash, nonce) {
  if (!transactionHash && (nonce == null || nonce === "")) {
    const error = new Error("Missing transactionHash or nonce");
    error.statusCode = 400;
    throw error;
  }

  const baseUrl = getCircleIrisBaseUrl();
  const endpoint = new URL(`/v2/messages/${encodeURIComponent(String(sourceDomainId))}`, `${baseUrl}/`);
  if (transactionHash) {
    endpoint.searchParams.set("transactionHash", transactionHash);
  } else {
    endpoint.searchParams.set("nonce", String(nonce));
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

    const transactions = data.messages.map((message) => mapCircleMessageToTransaction(message, transactionHash || ""));
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
    const sourceDomainIdText = String(rawSourceDomainId).trim();
    if (!/^\d+$/.test(sourceDomainIdText)) {
      return res.status(400).json({ error: 'Invalid sourceDomainId' });
    }
    const sourceDomainId = Number(sourceDomainIdText);
    
    if (sourceDomainId < 0) {
      return res.status(400).json({ error: 'Invalid sourceDomainId' });
    }

    let rawTransactionHash = req.query.transactionHash || req.body?.transactionHash || '';
    if (Array.isArray(rawTransactionHash)) rawTransactionHash = rawTransactionHash[0];
    const transactionHash = String(rawTransactionHash || '').trim().toLowerCase();
    let rawNonce = req.query.nonce ?? req.body?.nonce ?? '';
    if (Array.isArray(rawNonce)) rawNonce = rawNonce[0] ?? '';
    let nonce = '';

    if (transactionHash && !/^0x[a-f0-9]{64}$/.test(transactionHash)) {
      return res.status(400).json({ error: 'Invalid transactionHash' });
    }

    if (typeof rawNonce === 'number') {
      nonce = String(rawNonce);
    } else if (typeof rawNonce === 'string') {
      nonce = rawNonce.trim();
    } else if (rawNonce != null && rawNonce !== '') {
      return res.status(400).json({ error: 'Invalid nonce' });
    }

    if (!transactionHash) {
      if (!/^\d+$/.test(nonce)) {
        return res.status(400).json({ error: 'Invalid nonce' });
      }
    } else if (nonce && !/^\d+$/.test(nonce)) {
      nonce = '';
    }

    if (!transactionHash && (nonce == null || nonce === '')) {
      return res.status(400).json({ error: 'Missing transactionHash or nonce' });
    }

    monitorRedisHealth().catch((err) => {
      console.error('monitorRedisHealth failed', err);
    });

    const cacheKey = `bridge:transactions:${sourceDomainId}:${transactionHash || `nonce:${String(nonce)}`}`;
    
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
    const rawData = await fetchBridgeTransactionsAPI(sourceDomainId, transactionHash || undefined, nonce);
    const optimizedData = optimizeBridgeData(rawData);

    // 3. Set Cache
    try {
      serializeAndCompressAsync(cacheKey, optimizedData, TTL_SECONDS);
    } catch (e) {
      console.error(`[Redis] Cache Write Error:`, e.message);
    }

    return res.status(200).json({ ...optimizedData, cached: false });
  } catch (error) {
    console.error('API Error (bridge-transactions):', error);
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
