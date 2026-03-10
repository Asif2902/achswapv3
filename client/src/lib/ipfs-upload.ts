export async function uploadToIPFS(file: File): Promise<string> {
  const NFT_STORAGE_API_KEY = "64ad164f.478ca4142fa94e188c8b410423994fdc";

  const response = await fetch("https://api.nft.storage/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NFT_STORAGE_API_KEY}`,
    },
    body: file,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NFT.Storage upload failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error?.message || "Failed to upload to IPFS");
  }

  // The CID is data.value.cid
  // NFT.Storage returns a cid and we use their dweb.link gateway.
  const cid = data.value.cid;
  const fileName = encodeURIComponent(file.name);
  
  // Return the public gateway URL
  return `https://${cid}.ipfs.dweb.link/${fileName}`;
}
