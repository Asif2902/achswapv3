import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const COMPRESSION_THRESHOLD_BYTES = 10240; // Compress if > 10KB

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const HAS_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);
const UPSTASH_TIMEOUT_MS = 5000;

async function upstashRequest(command, ...args) {
  if (!HAS_REDIS) return null;
  const url = `${UPSTASH_URL}/${command}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTASH_TIMEOUT_MS);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Upstash error: ${response.statusText}`);
    }
    const json = await response.json();
    if (json.error) {
      throw new Error(`Upstash command error: ${json.error}`);
    }
    return json.result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Upstash request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function serializeAndCompress(cacheKey, dataObj, ttlSeconds) {
  if (!HAS_REDIS) return;
  const jsonStr = JSON.stringify(dataObj);
  const buffer = Buffer.from(jsonStr, 'utf-8');

  try {
    if (buffer.length > COMPRESSION_THRESHOLD_BYTES) {
      const compressed = await gzip(buffer);
      // Prefix 'gz:' so we know it requires decompression on read, store as base64
      const base64Str = compressed.toString('base64');
      await upstashRequest('SETEX', cacheKey, ttlSeconds, `gz:${base64Str}`);
    } else {
      await upstashRequest('SETEX', cacheKey, ttlSeconds, jsonStr);
    }
  } catch (err) {
    const redactedKey = cacheKey.replace(/:[^:]+$/, ':<redacted>');
    console.error(`[Redis] Cache Write Error for ${redactedKey}:`, err.message);
  }
}

export async function deserializeAndDecompress(cacheKey) {
  if (!HAS_REDIS) return null;
  try {
    const data = await upstashRequest('GET', cacheKey);
    if (!data) return null;

    if (typeof data === 'string' && data.startsWith('gz:')) {
      const base64Str = data.substring(3);
      const compressedPayload = Buffer.from(base64Str, 'base64');
      const decompressed = await gunzip(compressedPayload);
      return JSON.parse(decompressed.toString('utf-8'));
    }
    
    // If it's a string that doesn't start with gz: and not parsed yet, or object
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {
    const redactedKey = cacheKey.replace(/:[^:]+$/, ':<redacted>');
    console.error(`[Redis] Cache Read Error for ${redactedKey}:`, err.message);
    return null;
  }
}

export async function monitorRedisHealth() {
  if (!HAS_REDIS || Math.random() > 0.01) return; 
  try {
    const memoryInfo = await upstashRequest('INFO', 'memory');
    const keyCount = await upstashRequest('DBSIZE');
    
    let usedMemory = 'unknown';
    let maxMemory = 'unknown';
    
    if (typeof memoryInfo === 'string') {
      const usedMemoryMatch = memoryInfo.match(/used_memory_human:(.*)/);
      const maxMemoryMatch = memoryInfo.match(/maxmemory_human:(.*)/);
      if (usedMemoryMatch) usedMemory = usedMemoryMatch[1].trim();
      if (maxMemoryMatch) maxMemory = maxMemoryMatch[1].trim();
    }
    
    console.log(`[Redis Monitor] Keys: ${keyCount} | Used Mem: ${usedMemory} | Max Mem: ${maxMemory}`);
  } catch (err) {
    console.error('[Redis Monitor] Failed to fetch stats', err.message);
  }
}
