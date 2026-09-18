import { PROTOCOL_VERSION, type ClientIntent, type PublicRoomState } from "@pastebin/protocol";
import type { RoomSession } from "./config";
import { Connection } from "./connection";

export interface Bound {
  conn: Connection;
  code: string;
  memberId: string;
  token: string;
  name: string;
  color: string;
  room: PublicRoomState;
}

/**
 * Binding is the same two frames however you arrive: `session.created` names
 * you, and the `room.state` the server pushes right behind it lists the
 * papers. Waiting for both here means every command starts out knowing what
 * it can post to. The socket is closed on any failure so a refused bind never
 * leaves a connection holding the room open.
 */
export async function bind(conn: Connection, intent: ClientIntent): Promise<Bound> {
  try {
    conn.send(intent);
    const created = await conn.expect("session.created");
    const state = await conn.expect("room.state");
    const { code, memberId, token, name, color } = created.payload;
    return { conn, code, memberId, token, name, color, room: state.payload };
  } catch (e) {
    conn.close();
    throw e;
  }
}

export async function joinRoom(server: string, code: string, memberName: string): Promise<Bound> {
  const conn = await Connection.open(server);
  return bind(conn, { type: "room.join", payload: { code, memberName, protocolVersion: PROTOCOL_VERSION } });
}

export async function resumeSession(server: string, code: string, session: RoomSession): Promise<Bound> {
  const conn = await Connection.open(server);
  return bind(conn, {
    type: "session.resume",
    payload: { code, memberId: session.memberId, token: session.token, protocolVersion: PROTOCOL_VERSION },
  });
}
