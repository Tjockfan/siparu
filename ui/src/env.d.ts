// tz-lookup: lat/lon to IANA timezone (untyped CJS package, single function).
declare module "tz-lookup" {
  export default function tzlookup(lat: number, lon: number): string;
}

// Vite: a worker entry bundled on its own, imported as the URL it is served from.
declare module "*?worker&url" {
  const url: string;
  export default url;
}
