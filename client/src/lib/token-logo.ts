export const TOKEN_LOGO_FALLBACK_URL = "/img/logos/unknown-token.png";

const KNOWN_IPFS_GATEWAY_HOSTS = new Set([
  "gateway.pinata.cloud",
  "ipfs.io",
  "cloudflare-ipfs.com",
  "dweb.link",
  "w3s.link",
  "nftstorage.link",
]);
const CIDV0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CIDV1_BASE32_RE = /^b[a-z2-7]{20,}$/i;

function isLocalLogoUrl(source: string): boolean {
  return source.startsWith("/") || source.startsWith("data:") || source.startsWith("blob:");
}

function isRawCidPath(source: string): boolean {
  const candidate = source.replace(/^\/+/, "").split("/")[0] || "";
  return CIDV0_RE.test(candidate) || CIDV1_BASE32_RE.test(candidate);
}

function normalizeIpfsPath(path: string): string | null {
  const trimmed = path.trim().replace(/^\/+/, "");
  return trimmed ? `ipfs://${trimmed}` : null;
}

function extractIpfsSourceFromGatewayUrl(source: string): string | null {
  try {
    const parsed = new URL(source);
    if (!KNOWN_IPFS_GATEWAY_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }

    const marker = "/ipfs/";
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }

    const suffix = decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length));
    return normalizeIpfsPath(suffix);
  } catch {
    return null;
  }
}

export function normalizeTokenLogoSource(source?: string | null): string | null {
  if (!source) return null;

  const trimmed = source.trim();
  if (!trimmed) return null;
  if (isLocalLogoUrl(trimmed)) return trimmed;
  if (trimmed.startsWith("ipfs://")) {
    return normalizeIpfsPath(trimmed.slice("ipfs://".length));
  }
  if (isRawCidPath(trimmed)) {
    return normalizeIpfsPath(trimmed);
  }

  const gatewaySource = extractIpfsSourceFromGatewayUrl(trimmed);
  if (gatewaySource) {
    return gatewaySource;
  }

  return trimmed;
}

export function getTokenLogoUrl(source?: string | null): string {
  const normalized = normalizeTokenLogoSource(source);
  if (!normalized) return TOKEN_LOGO_FALLBACK_URL;
  if (isLocalLogoUrl(normalized)) return normalized;
  if (normalized.startsWith("ipfs://")) {
    return `/api/token-logo?src=${encodeURIComponent(normalized)}`;
  }
  return normalized;
}
