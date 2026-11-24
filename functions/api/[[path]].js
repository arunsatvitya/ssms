/**
 * Route: /api/<อะไรก็ได้>
 *
 * The catch-all below /api. The health check lives at /api/health.
 */

import { handleApiRequest, handleHealthRequest } from '../_lib/handler.js';

export const onRequestPost = handleApiRequest;
export const onRequestPut = handleApiRequest;

export async function onRequestGet(context) {
  const path = new URL(context.request.url).pathname;
  if (path.endsWith('/health')) {
    return handleHealthRequest(context);
  }
  return handleApiRequest(context);
}
