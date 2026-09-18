/**
 * Shared caps. The server enforces every one of these; the client reads the
 * same constants so the composer can warn *before* you lose a long paste to a
 * `TOO_LARGE` round-trip.
 *
 * Character counts, not bytes — the server measures `text.length` too, so the
 * two never disagree about whether a paste fits.
 */
export const MAX_BLOCK_CHARS = 100_000;
export const MAX_BLOCKS_PER_PAPER = 1000;
export const MAX_PAPERS_PER_ROOM = 24;
export const MAX_MEMBERS = 32;
/**
 * 32, not 24, because the suggested name is "<adjective> <name>" drawn from
 * `data/names.json` and those lists are the user's to edit. The longest pairing
 * in the shipped pool is 27 characters; at 24 the *suggested* name would have
 * been rejected by this very schema, which is about the most confusing failure
 * the landing page could produce. Headroom here is cheaper than a cap that
 * fights its own default.
 */
export const MAX_NAME_CHARS = 32;
export const MAX_TITLE_CHARS = 40;
/**
 * The label on a block that came from a dropped file. Same 120 as the `name`
 * kept on an upload, because both are the same thing — a filename the client
 * supplied — and one of them being roomier than the other would only ever be a
 * surprise.
 */
export const MAX_FILENAME_CHARS = 120;

/**
 * How long a room survives with nobody connected, before it and everything in
 * it is deleted. Rooms are meant to last a session, not a week.
 *
 * The server is the authority — this is the default it starts from, overridable
 * with ROOM_EMPTY_GRACE_MINUTES — and the client reads the real value from
 * `/api/host` so the UI never promises a number the server isn't keeping.
 */
export const DEFAULT_EMPTY_ROOM_GRACE_MINUTES = 5;

/**
 * Images ride an HTTP upload, not the WebSocket — base64 in a JSON frame costs
 * a third more bytes and blocks the socket every other message shares.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * The whiteboard's logical size. Every stroke is stored in this space as
 * integers, and each viewer scales it to fit — which is the only way a phone at
 * 375px and a desktop at 1280px can be looking at the same drawing.
 *
 * Integers, not normalised floats: `0.7331249` costs nine characters to say
 * what `1173` says in four, and every stroke is repaid on every reconnect.
 * Both sides read these constants, so neither can drift about what an x means.
 */
export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 1200;

/** Stroke widths, in board units. No size picker yet — these are the two. */
export const BRUSH_WIDTH = 3;
export const ERASER_WIDTH = 24;

/**
 * A separate cap from `MAX_BLOCKS_PER_PAPER`, which was written for pastes: a
 * sketch is easily several hundred strokes and would hit 1000 in one sitting.
 */
export const MAX_STROKES_PER_PAPER = 5000;

/**
 * Points in one stroke, after simplification. A bound here is what stops a
 * single slow drag from approaching `MAX_BLOCK_CHARS` — the client simplifies
 * well below this, so hitting it means something is wrong rather than someone
 * drew a long line.
 */
export const MAX_STROKE_POINTS = 1000;

/**
 * The only types accepted. Checked against the file's magic bytes on the
 * server, not against the browser-supplied content type, which is a claim
 * rather than a fact. GIF needs nothing special — the browser animates it.
 */
export const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];
