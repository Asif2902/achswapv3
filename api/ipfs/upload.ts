export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  const pinataJwt = process.env.PINATA_JWT;
  if (!pinataJwt) {
    return new Response(JSON.stringify({ error: 'Server configuration error: missing PINATA_JWT' }), { status: 500 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file uploaded' }), { status: 400 });
    }

    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: 'Payload Too Large' }), { status: 413 });
    }

    const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return new Response(JSON.stringify({ error: 'Unsupported Media Type' }), { status: 415 });
    }

    const pinataFormData = new FormData();
    pinataFormData.append('file', file);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let pinataRes;
    try {
      pinataRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pinataJwt}`,
        },
        body: pinataFormData,
        signal: controller.signal,
      });
    } catch (fetchErr: any) {
      if (fetchErr.name === 'AbortError') {
        fetchErr.status = 504;
        fetchErr.message = 'Pinata upload timeout for pinataJwt/pinataFormData';
        throw fetchErr;
      }
      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!pinataRes.ok) {
      const errorText = await pinataRes.text();
      return new Response(JSON.stringify({ error: `Pinata error: ${errorText}` }), { status: pinataRes.status });
    }

    const data = await pinataRes.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error(err);
    const status = err.status || 500;
    const msg = status === 500 ? 'Internal server error' : err.message;
    return new Response(JSON.stringify({ error: msg }), { status });
  }
}
