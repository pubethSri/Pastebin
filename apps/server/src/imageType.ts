import { ALLOWED_IMAGE_MIMES, type ImageMime } from "@pastebin/protocol";

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/**
 * Identifies an image by its magic bytes, returning null for anything else.
 *
 * The browser's `File.type` is a *claim* — it comes from the client and is
 * trivially forged, so trusting it would let anyone store arbitrary bytes that
 * we then serve back with an attacker-chosen content type. Sniffing here means
 * the `Content-Type` we later send is one we established ourselves, which is
 * what makes serving user uploads from our own origin safe.
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < 12) return null;

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF87a / GIF89a — animation is just a property of the format, so nothing
  // extra is needed to support GIFs.
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

export const isAllowedMime = (mime: string): mime is ImageMime =>
  (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime);
