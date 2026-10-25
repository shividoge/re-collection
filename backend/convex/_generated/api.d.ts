/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as captures from "../captures.js";
import type * as crons from "../crons.js";
import type * as factsJob from "../factsJob.js";
import type * as jobsCron from "../jobsCron.js";
import type * as lib_claude from "../lib/claude.js";
import type * as lib_data from "../lib/data.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_facts from "../lib/facts.js";
import type * as lib_grounding from "../lib/grounding.js";
import type * as lib_jobs from "../lib/jobs.js";
import type * as lib_museum from "../lib/museum.js";
import type * as lib_prompts from "../lib/prompts.js";
import type * as lib_r2 from "../lib/r2.js";
import type * as lib_session from "../lib/session.js";
import type * as lib_stages from "../lib/stages.js";
import type * as lib_validate from "../lib/validate.js";
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
  admin: typeof admin;
  captures: typeof captures;
  crons: typeof crons;
  factsJob: typeof factsJob;
  jobsCron: typeof jobsCron;
  "lib/claude": typeof lib_claude;
  "lib/data": typeof lib_data;
  "lib/errors": typeof lib_errors;
  "lib/facts": typeof lib_facts;
  "lib/grounding": typeof lib_grounding;
  "lib/jobs": typeof lib_jobs;
  "lib/museum": typeof lib_museum;
  "lib/prompts": typeof lib_prompts;
  "lib/r2": typeof lib_r2;
  "lib/session": typeof lib_session;
  "lib/stages": typeof lib_stages;
  "lib/validate": typeof lib_validate;
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
