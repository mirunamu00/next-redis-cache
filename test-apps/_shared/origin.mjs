// Client for the origin server (scripts/origin-server.mjs) used by data-fetching pages.
import { originUrl } from "./config.mjs";

/** URL of a versioned origin datum. */
export const dataUrl = (key) => `${originUrl()}/data/${encodeURIComponent(key)}`;
