export async function compressImage(file: File, maxMB: number = 2): Promise<File> {
  // If the file is already very small (e.g. < 300KB), no need to compress
  if (file.size < 300 * 1024) return file;

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
        0.8 // 80% quality
      );
    };
    
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file); // fallback to original on error
    };
    
    img.src = objectUrl;
  });
}
