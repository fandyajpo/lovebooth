/**
 * Local camera only. Video in, video out — no microphone, ever.
 */

export type CameraErrorKind = 'unsupported' | 'denied' | 'unavailable' | 'busy' | 'unknown';

export class CameraError extends Error {
  readonly kind: CameraErrorKind;
  constructor(kind: CameraErrorKind) {
    super(kind);
    this.name = 'CameraError';
    this.kind = kind;
  }
}

export function isCameraSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof window !== 'undefined'
  );
}

export function isSecureContextOk(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext !== false;
}

export interface CameraOptions {
  width?: number;
  height?: number;
}

export async function getCameraStream(options: CameraOptions = {}): Promise<MediaStream> {
  if (!isCameraSupported()) throw new CameraError('unsupported');

  const constraints: MediaStreamConstraints = {
    video: {
      facingMode: 'user',
      width: { ideal: options.width ?? 1280 },
      height: { ideal: options.height ?? 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  };

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied');
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'TypeError') {
      throw new CameraError('unavailable');
    }
    if (name === 'NotReadableError' || name === 'AbortError') throw new CameraError('busy');
    throw new CameraError('unknown');
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
}

export function watchStreamEnd(stream: MediaStream, onEnded: () => void): () => void {
  const tracks = stream.getTracks();
  const handler = () => onEnded();
  for (const track of tracks) track.addEventListener('ended', handler);
  return () => {
    for (const track of tracks) track.removeEventListener('ended', handler);
  };
}
