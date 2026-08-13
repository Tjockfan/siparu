/// <reference types="vite/client" />

// tz-lookup: lat/lon → IANA timezone (untyped CJS package, single function).
declare module "tz-lookup" {
  export default function tzlookup(lat: number, lon: number): string;
}
