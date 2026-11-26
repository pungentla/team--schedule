const maxImageBytes = 480 * 1024;
const acceptedImages = ['image/jpeg', 'image/png', 'image/webp'];

export async function encodeImage(file) {
  if (!acceptedImages.includes(file.type)) throw new Error('图片仅支持 JPG、PNG 或 WebP');
  if (file.size > 20 * 1024 * 1024) throw new Error('原图不能超过 20 MB');
  let image = file;
  if (image.size > maxImageBytes) {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      for (const limit of [1600, 1200, 900, 675]) {
        const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.fillStyle = 'white';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        image = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        if (image && image.size <= maxImageBytes) break;
      }
    } finally {
      bitmap.close();
    }
    if (!image || image.size > maxImageBytes) throw new Error('图片过大，请换一张较小的图片');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取图片，请重新选择'));
    reader.readAsDataURL(image);
  });
}
