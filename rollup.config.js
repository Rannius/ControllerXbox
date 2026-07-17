import deckyPlugin from "@decky/rollup";

// Decky's frontend is evaluated in Steam's browser context, not in Node.js.
// The official Decky Rollup preset emits the loader-compatible bundle format.
export default deckyPlugin();
