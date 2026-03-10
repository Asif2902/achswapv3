export async function uploadToIPFS(file: File): Promise<string> {
  const PINATA_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI3NThiNzgzNS0zM2U5LTRjM2MtYjA0MC0xYWU1YThhOGE0NTAiLCJlbWFpbCI6ImZyZWVmaXJlYmFuZ2xhZGVzaG9mZmljaWFsMDFAZ21haWwuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsInBpbl9wb2xpY3kiOnsicmVnaW9ucyI6W3siZGVzaXJlZFJlcGxpY2F0aW9uQ291bnQiOjEsImlkIjoiRlJBMSJ9LHsiZGVzaXJlZFJlcGxpY2F0aW9uQ291bnQiOjEsImlkIjoiTllDMSJ9XSwidmVyc2lvbiI6MX0sIm1mYV9lbmFibGVkIjpmYWxzZSwic3RhdHVzIjoiQUNUSVZFIn0sImF1dGhlbnRpY2F0aW9uVHlwZSI6InNjb3BlZEtleSIsInNjb3BlZEtleUtleSI6ImQzMzJmNDk3ZDc4ZDVkYWVmZTQ2Iiwic2NvcGVkS2V5U2VjcmV0IjoiNWU3M2I1YWYyZWQwN2FjNzlmOTE1MWI2YjQxOTJhZTY3Mzg5YzZkNGI1MTlkYWExODNkY2NlMjlhN2Q4ZmI5YyIsImV4cCI6MTgwNDY4MTIzNH0.ZvSIB9lmAvWRr-j8-A6N6TqHvwtC5t3NmqNAKCGQkXQ";

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
