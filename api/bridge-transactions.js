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

async function fetchBridgeTransactionsAPI(address) {
  // Replace with actual external CCTP V2 API fetch
  return { transactions: [], totalVolume: 0, transactionCount: 0 };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const address = (req.query.address || req.body?.address || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    monitorRedisHealth(); // Fire & forget monitor

    const cacheKey = `bridge:transactions:${address}`;
    
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
    const rawData = await fetchBridgeTransactionsAPI(address);
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
