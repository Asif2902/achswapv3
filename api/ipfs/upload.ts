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

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file uploaded' }), { status: 400 });
    }

    const pinataFormData = new FormData();
    pinataFormData.append('file', file);

    const pinataRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pinataJwt}`,
      },
      body: pinataFormData,
    });

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
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
