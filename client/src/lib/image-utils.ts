export async function compressImage(file: File, maxMB: number = 2): Promise<File> {
  const targetBytes = maxMB * 1024 * 1024;
  const earlyExitThreshold = Math.min(300 * 1024, targetBytes * 0.15);
  // If the file is already very small (e.g. < 15% of maxMB limit or 300KB), no need to compress
  if (file.size < earlyExitThreshold) return file;

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      
      let width = img.width;
      let height = img.height;
      
      // Resize if dimensions are excessively large (e.g., > 800px)
      const maxDim = 800;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(file); // fallback to original if canvas fails
        return;
      }
      
      // Draw image to canvas
      ctx.drawImage(img, 0, 0, width, height);
      
      // Compress to WebP
      const quality = maxMB < 1 ? 0.6 : 0.8;
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          
          // Only use the compressed version if it's actually smaller
          if (blob.size < file.size) {
            const newName = file.name.replace(/\.[^/.]+$/, "") + ".webp";
            const compressedFile = new File([blob], newName, {
              type: "image/webp",
              lastModified: Date.now(),
            });
            resolve(compressedFile);
          } else {
            resolve(file);
          }
        },
        "image/webp",
        quality
      );
    };
    
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file); // fallback to original on error
    };
    
    img.src = objectUrl;
  });
}
