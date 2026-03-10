export async function uploadToIPFS(file: File): Promise<string> {
  const PINATA_JWT = import.meta.env.VITE_JWT_KEY;

  if (!PINATA_JWT) {
    throw new Error("Missing VITE_JWT_KEY in environment variables");
  }

  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pinata upload failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  if (!data.IpfsHash) {
    throw new Error("Pinata response missing IpfsHash");
  }

  const cid = data.IpfsHash;
  // Use Pinata's public IPFS gateway
  return `https://gateway.pinata.cloud/ipfs/${cid}`;
}
