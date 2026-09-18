import { ALLOWED_IMAGE_MIMES, MAX_UPLOAD_BYTES, type Media } from "@pastebin/protocol";
import type { Session } from "./socket.svelte";

export const isImageFile = (file: File): boolean =>
  (ALLOWED_IMAGE_MIMES as readonly string[]).includes(file.type);

/**
 * Reads a bitmap's dimensions before upload.
 *
 * Display-only: they let the feed reserve the right aspect ratio so it doesn't
 * jump when the picture arrives. Failure is fine — the server stores null and
 * the image simply lays itself out on load.
 */
async function dimensions(file: File): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: null, height: null };
  }
}

/**
 * Uploads over HTTP rather than the WebSocket. Base64 in a JSON frame costs a
 * third more bytes and would stall every other message behind a 10 MB payload;
 * this also lets the browser cache the result at `/media/:id` like any image.
 */
export async function uploadImage(file: File, session: Session): Promise<Media> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`images are capped at ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }
  const { width, height } = await dimensions(file);

  const params = new URLSearchParams({ code: session.code });
  if (width) params.set("w", String(width));
  if (height) params.set("h", String(height));
  if (file.name) params.set("name", file.name);

  const res = await fetch(`/api/upload?${params}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-member-id": session.memberId,
      "x-member-token": session.token,
    },
    body: file,
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `upload failed (${res.status})`);
  return body as Media;
}

/** Human-sized bytes for the caption under an image. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
