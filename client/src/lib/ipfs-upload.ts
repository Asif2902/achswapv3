export async function uploadToIPFS(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch("/api/ipfs/upload", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    if (!data.IpfsHash) {
      throw new Error("Response missing IpfsHash");
    }

    const cid = data.IpfsHash;
    return `ipfs://${cid}`;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      err.status = 504;
      err.message = 'Pinata upload timeout for pinataJwt/pinataFormData';
      throw err;
    }
    throw err;
  }
}
