import type { INodePropertyOptions } from "n8n-workflow";
import STATIC_OPS_JSON from "./static-ops.json";

/** One row of the op catalogue (`GET /api/v1/ops`), as far as the dropdown reads it. */
export interface OpEntry {
  op: string;
  kind: string;
  description?: string;
  typicalSeconds?: number;
  syncEndpoint?: string | null;
  /** The op's parameters include a `prompt` (the static list only). */
  takesPrompt?: boolean;
  /** The op runs with no input image — the catalogue's `requiresAssets: false` (the static list only). */
  inputOptional?: boolean;
  /** The op is refused without a prompt — the catalogue's `requiresPrompt` (the static list only). */
  promptRequired?: boolean;
}

/**
 * The atomic-op vocabulary (docs/api-contract.md §8). The live list comes from `GET /api/v1/ops`
 * at design time; this is the fallback the dropdown shows when that request fails (no credential
 * yet, network down), so the node stays usable and a workflow imported from a template still
 * resolves its `op` value.
 *
 * Generated, not typed (#571): `static-ops.json` is the committed catalogue (`apps/service/openapi/ops.json`) cut to
 * the job ops and their op / kind / description, written by `scripts/static-ops.mjs`. A hand-kept copy drifted twice —
 * `render_template` missing (#94), descriptions that were not the catalogue's — and the repo root's
 * `test/ops-catalogue.test.js` is red when the file no longer matches `ops.json`.
 */
export const STATIC_OPS: OpEntry[] = STATIC_OPS_JSON;

/** Ops that take a prompt — decides when the Prompt field is shown. From the catalogue, like the list itself (#767). */
export const PROMPT_OPS = STATIC_OPS.filter((o) => o.takesPrompt).map((o) => o.op);

/**
 * Ops that run with no input image (generate, render_template): Input Binary File on an item with no file runs them as
 * Input None (#852) — the first thing a new workflow does is put this node after Manual Trigger, which outputs no file,
 * and pick generate without touching Input. render_template was left out until #901's matrix found it told to bring an
 * image it never reads. An op that needs an image (edit, analyze) still stops, saying where to get one.
 */
export const INPUT_OPTIONAL_OPS = STATIC_OPS.filter((o) => o.inputOptional).map((o) => o.op);

/**
 * Ops that work on an image they are given — every op the catalogue says needs `assetIds`. Input None stops on them
 * before anything is submitted (#901): the service could only refuse the job for its missing asset id, and a person who
 * set None to draw from a prompt with Op still on remove_bg needs to hear about generate. An op this release does not
 * know (added to the API since) is left for the service to answer.
 */
export const NEEDS_IMAGE_OPS = STATIC_OPS.filter((o) => !o.inputOptional).map((o) => o.op);

/**
 * Ops the catalogue refuses without a prompt (generate, edit). An empty Prompt stops in the node (#901): it is most often
 * an expression that resolved to nothing — a field name the previous node does not have — and the job could only be
 * refused for it.
 */
export const PROMPT_REQUIRED_OPS = STATIC_OPS.filter((o) => o.promptRequired).map((o) => o.op);

/** One step of a preset, as `GET /api/v1/presets` lists it: an op, or a processing-registry `operation`. */
export interface PresetStep {
  op?: string;
  operation?: string;
}

/**
 * Where a request-level prompt lands on a preset (#1031): on its one AI step (`one`), or nowhere — a preset with no AI
 * step (`none`) or one that runs as several segments (`several`), which the service refuses with 400 (imagestep#362).
 * The service's rule, read the way it reads it (`PresetSteps.segments`, `JobService`): adjacent deterministic steps are
 * one segment, each AI step is one, and only a single AI segment takes the override. Undefined when it cannot be told —
 * no steps listed, or an op this release does not know (added to the API since): that preset is left to the service.
 */
export function presetPromptSlot(steps: PresetStep[] | null | undefined): "one" | "none" | "several" | undefined {
  if (!Array.isArray(steps) || !steps.length) return undefined;
  let segments = 0;
  let ai = 0;
  let inProcess = false;
  for (const step of steps) {
    const kind = step?.op ? STATIC_OPS.find((o) => o.op === step.op)?.kind : step?.operation ? "deterministic" : undefined;
    if (!kind) return undefined;
    if (kind === "ai") {
      ai++;
      segments++;
      inProcess = false;
    } else if (!inProcess) {
      segments++;
      inProcess = true;
    }
  }
  if (!ai) return "none";
  return segments === 1 ? "one" : "several";
}

/** Kinds the dropdown lists; `sync` ops (read_metadata) are answered by Asset → Get, not by a job. */
const JOB_KINDS = new Set(["ai", "deterministic"]);

/** Map the live catalogue (or the static fallback) to n8n dropdown options. */
export function toOpOptions(ops: Array<OpEntry | null | undefined>): INodePropertyOptions[] {
  // `typicalSeconds` (#357) rides on the description: it is what a person choosing Wait Seconds wants to see, and it
  // comes from the catalogue — the fallback list carries none, so offline the dropdown simply says nothing about time.
  return ops
    .filter((o): o is OpEntry => !!o && !!o.op && JOB_KINDS.has(o.kind))
    .map((o) => ({
      name: o.op,
      value: o.op,
      description: `${o.description || ""}${o.typicalSeconds ? ` Typically ~${o.typicalSeconds} s for one item.` : ""}`.trim()
    }));
}
