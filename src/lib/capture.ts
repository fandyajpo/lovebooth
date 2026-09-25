/**
 * Frame capture: <video> → <canvas> → Blob.
 *
 * The crop happens here so the photostrip composition can paste images 1:1.
 * `anchorY` keeps the subject's head inside the frame instead of centre-
 * cropping a portrait phone preview down to a landscape strip cell.
 */

export interface CaptureOptions {
  /** Target size of the exported frame. */
  width: number;
  height: number;
  /** Horizontally flip the source before saving, so the photo matches the
   *  mirrored viewfinder instead of flipping back the moment the shutter fires. */
  mirror?: boolean;
  /** 0 = take from the top of the source, 1 = from the bottom. */
  anchorY?: number;
  /** Small punch-in so the viewfinder guide matches what is saved. */
  zoom?: number;
}

export const DEFAULT_CAPTURE: CaptureOptions = {
  width: 800,
  height: 522,
  mirror: true,
  anchorY: 0.4,
  zoom: 1.04,
};

export function captureFrame(video: HTMLVideoElement, options: CaptureOptions): HTMLCanvasElement {
  const { width, height, mirror = true, anchorY = 0.4, zoom = 1.04 } = options;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const srcW = video.videoWidth || width;
  const srcH = video.videoHeight || height;

  ctx.save();
  if (mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }

  // Largest source rect with the target aspect, scaled by the zoom factor.
  const targetRatio = width / height;
  const sourceRatio = srcW / srcH;
  let cropW: number;
  let cropH: number;
  if (sourceRatio > targetRatio) {
    cropH = srcH / zoom;
    cropW = cropH * targetRatio;
  } else {
    cropW = srcW / zoom;
    cropH = cropW / targetRatio;
  }
  cropW = Math.min(cropW, srcW);
  cropH = Math.min(cropH, srcH);

  const sx = (srcW - cropW) / 2;
  const sy = Math.min(Math.max((srcH - cropH) * anchorY, 0), srcH - cropH);

  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, width, height);
  ctx.restore();
  return canvas;
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/jpeg',
  quality = 0.86,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('encode-failed'));
      },
      type,
      quality,
    );
  });
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** Freezes the current frame into a still <canvas> the UI can show. */
export function snapshotToCanvas(
  video: HTMLVideoElement,
  options: CaptureOptions,
): HTMLCanvasElement {
  return captureFrame(video, options);
}

export interface GuideRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where `captureFrame` will actually cut, expressed in element pixels so the
 * viewfinder guide on the preview matches the photo that gets saved.
 */
export function computeGuideRect(
  video: HTMLVideoElement,
  boxWidth: number,
  boxHeight: number,
  options: CaptureOptions = DEFAULT_CAPTURE,
): GuideRect | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || boxWidth <= 0 || boxHeight <= 0) return null;

  const { width: targetW, height: targetH, anchorY = 0.4, zoom = 1.04 } = options;
  const targetRatio = targetW / targetH;

  let cropW: number;
  let cropH: number;
  if (vw / vh > targetRatio) {
    cropH = vh / zoom;
    cropW = cropH * targetRatio;
  } else {
    cropW = vw / zoom;
    cropH = cropW / targetRatio;
  }
  cropW = Math.min(cropW, vw);
  cropH = Math.min(cropH, vh);

  const sx = (vw - cropW) / 2;
  const sy = Math.min(Math.max((vh - cropH) * anchorY, 0), vh - cropH);

  // `object-fit: cover` placement of the full source frame inside the box.
  const boxRatio = boxWidth / boxHeight;
  const srcRatio = vw / vh;
  let dispW: number;
  let dispH: number;
  if (srcRatio > boxRatio) {
    dispH = boxHeight;
    dispW = dispH * srcRatio;
  } else {
    dispW = boxWidth;
    dispH = dispW / srcRatio;
  }
  const offsetX = (boxWidth - dispW) / 2;
  const offsetY = (boxHeight - dispH) / 2;
  const scale = dispW / vw;

  return {
    left: offsetX + sx * scale,
    top: offsetY + sy * scale,
    width: cropW * scale,
    height: cropH * scale,
  };
}
