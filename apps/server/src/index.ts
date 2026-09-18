import { DEFAULT_EMPTY_ROOM_GRACE_MINUTES } from "@pastebin/protocol";
import { createApp } from "./app";
import { lanAddresses } from "./net";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "pastebin.sqlite";
const ttlDays = Number(process.env.ROOM_TTL_DAYS ?? 30);
const emptyGraceMinutes = Number(process.env.ROOM_EMPTY_GRACE_MINUTES ?? DEFAULT_EMPTY_ROOM_GRACE_MINUTES);

const app = createApp({ dbPath, ttlDays, emptyGraceMinutes });
// 0.0.0.0, not localhost: the entire point is that other devices on the LAN
// can reach this. Binding to loopback would make the app unreachable from the
// phone it exists for.
app.listen({ port, hostname: "0.0.0.0" });

console.log(
  `pastebin listening on :${port}  (db ${dbPath}, empty rooms deleted after ${emptyGraceMinutes}m)`,
);
for (const ip of lanAddresses()) console.log(`  http://${ip}:${port}`);
