/**
 * Host half of dsh-ws-recency.
 *
 * The whole feature is client-side: it reads Session and Workspace state through
 * the Client's root-standard hooks and writes a flex `order` onto the sidebar's
 * workspace groups. This row only carries the package into the plugin graph so
 * the Client registry can serve ./client.js beside it.
 */

/** Plugin name shown by the loader. */
export const name = 'ws-recency'

/** Host-plane entry point; this plugin owns no Host behavior. */
export function apply() {}
