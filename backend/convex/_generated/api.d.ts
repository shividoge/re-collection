/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as captures from "../captures.js";
import type * as lib_stub from "../lib_stub.js";
import type * as moments from "../moments.js";
import type * as museum from "../museum.js";
import type * as people from "../people.js";
import type * as progress from "../progress.js";
import type * as public_ from "../public.js";
import type * as sessions from "../sessions.js";
import type * as system from "../system.js";
import type * as uploads from "../uploads.js";
import type * as validators from "../validators.js";
import type * as videos from "../videos.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  captures: typeof captures;
  lib_stub: typeof lib_stub;
  moments: typeof moments;
  museum: typeof museum;
  people: typeof people;
  progress: typeof progress;
  public: typeof public_;
  sessions: typeof sessions;
  system: typeof system;
  uploads: typeof uploads;
  validators: typeof validators;
  videos: typeof videos;
  worker: typeof worker;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
