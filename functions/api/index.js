/**
 * Route: /api  (และ /api/)
 *
 * The browser sends every action to this address.
 */

import { handleApiRequest } from '../_lib/handler.js';

export const onRequestPost = handleApiRequest;
export const onRequestPut = handleApiRequest;
export const onRequestGet = handleApiRequest;
