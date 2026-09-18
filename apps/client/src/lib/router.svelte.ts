export type Route =
  | { name: "home" }
  /** `paperId` is null on `/r/CODE` — land on the room's default paper. */
  | { name: "room"; code: string; paperId: string | null };

let path = $state(window.location.pathname);

window.addEventListener("popstate", () => {
  path = window.location.pathname;
});

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState({}, "", to);
  else history.pushState({}, "", to);
  path = to;
}

function match(p: string): Route {
  const m = p.match(/^\/r\/([A-Za-z]{4})(?:\/p\/([A-Za-z0-9-]+))?\/?$/);
  if (m) return { name: "room", code: m[1]!.toUpperCase(), paperId: m[2] ?? null };
  return { name: "home" };
}

export const route = {
  get current(): Route {
    return match(path);
  },
};
