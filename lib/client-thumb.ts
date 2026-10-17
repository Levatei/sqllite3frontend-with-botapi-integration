/**
 * Клиентская генерация превью (браузер). Результат уходит на сервер вторым
 * файлом, чтобы галерея грузила маленькие картинки, а не оригиналы.
 */

function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.8): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

export async function makeImageThumb(file: File, max = 480, quality = 0.8): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return await canvasToJpeg(canvas, quality);
  } catch {
    return null;
  }
}

export async function makeVideoThumb(file: File, max = 480): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 10000);
      video.onloadeddata = () => {
        clearTimeout(t);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(t);
        reject(new Error('error'));
      };
    });
    try {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000);
      video.onseeked = () => {
        clearTimeout(t);
        resolve();
      };
      if (video.readyState >= 2) resolve();
    });
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const scale = Math.min(1, max / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return await canvasToJpeg(canvas, 0.8);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function makeThumb(file: File): Promise<Blob | null> {
  if (file.type.startsWith('image/')) return makeImageThumb(file);
  if (file.type.startsWith('video/')) return makeVideoThumb(file);
  return null;
}
