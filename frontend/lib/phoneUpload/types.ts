// The upload portal — what both routes (local network, cloud) hand the PC.
//
// Ported from DocVex's phone upload (the Files tab's Import window). In CFO
// AI every upload section of the web app on a PC gets the portal: a QR code
// the phone scans; the files the phone sends WAIT here until the user imports
// them into that section (its own `onFiles`) or leaves them out.

/** Which upload section opened the portal — shown on the phone page. */
export type PortalSurface =
  | "workspace"
  | "company"
  | "statements"
  | "periods"
  | "products"
  | "sources"
  | "budget"
  | "chat"
  | "upload";

export type PortalRoute = "local" | "cloud";

export interface Arrival {
  /** Unique across routes: `<route>:<id>`. */
  key: string;
  route: PortalRoute;
  /** The route's own id (cloud: the row id; local: the staged file id). */
  id: string;
  name: string;
  size: number;
  state: "taking" | "waiting" | "error";
  /** Present once `state === "waiting"`: the file, ready for onFiles. */
  file?: File;
  error?: string;
}

export interface PortalAddress {
  ok: true;
  url: string;
  expiresAt: number | null;
}

export type PortalError = { ok: false; error: string; detail?: string };

/** Starts the watch; returns a stop function. */
export type ArrivalSink = (a: Arrival) => void;
