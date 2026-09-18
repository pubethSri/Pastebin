import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  server: {
    // Dev is reachable from the LAN too (`vite --host`), so the clipboard
    // fallback can be tested from a phone without building first.
    host: true,
    proxy: {
      // 127.0.0.1, not localhost: Windows resolves localhost to ::1 while Bun
      // listens on IPv4, and the proxy then fails to connect.
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
      "/healthz": "http://127.0.0.1:3000",
      "/api": "http://127.0.0.1:3000",
    },
  },
});
