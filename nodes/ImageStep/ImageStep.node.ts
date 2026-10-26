import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription
} from "n8n-workflow";
import * as api from "../../lib/api";
import type { Failure } from "../../lib/api";
import { INPUT_OPTIONAL_OPS, NEEDS_IMAGE_OPS, PROMPT_REQUIRED_OPS, STATIC_OPS, toOpOptions } from "../../lib/ops";
import { assetRef, buildOpJobBody, buildPresetJobBody, jobRef, normaliseIds, parseParameters } from "../../lib/refs";
import type { Job, JobBody } from "../../lib/refs";
import { properties } from "./description";

const MAIN = (NodeConnectionTypes && NodeConnectionTypes.Main) || "main";

/**
 * How many input items run at once (#523, #820): as many as one account gets of a prod node's synchronous lane — its 4
 * slots less the one `api.sync.reserve` keeps for accounts with nothing in flight (the service's application.yml) — the
 * CLI `image` group's default too. One more would hear 429 on every batch that fills the node; one fewer would leave a
 * slot the account has unused. Only a synchronous op actually runs three-wide: every other item — a job, an upload, a
 * preset — takes {@link serialLane} one at a time, because a job item holds one of the account's few open waits
 * (contract §5.1) for up to its Wait Seconds, and a job is already where the service does the batching.
 */
export const ITEM_CONCURRENCY = 3;

/** Thrown for an item that was still queued when another item failed the node: it never ran, so it has no row. */
const NOT_STARTED = Symbol("not started");

/** What the items of one execution share: the op catalogue, read once, and the one-at-a-time lane. */
interface Lanes {
  syncEndpoints: () => Promise<Record<string, string | null>>;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
  halted: boolean;
}

/** A node parameter of the current item, typed by its fallback. */
interface Param {
  (name: string, fallback: string): string;
  (name: string, fallback: number): number;
  (name: string, fallback: boolean): boolean;
  <T = unknown>(name: string, fallback?: T): T;
}

/**
 * ImageStep — the image step for your automations. One node: Asset (upload · get · list ·
 * publish), Operation (run one atomic op), Preset (run a saved pipeline), Job (get · wait).
 * Talks to the public REST API only (the `api-key-accessible` group), through n8n's own HTTP
 * helpers; outputs are references (`assetRef` / `jobRef`) with an optional binary download.
 */
export class ImageStep implements INodeType {
  description: INodeTypeDescription = {
    displayName: "ImageStep",
    name: "imageStep",
    icon: "file:imagestep.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
    description: "Generate, edit, remove background, upscale, resize and convert images — the image step for your automations",
    defaults: { name: "ImageStep" },
    inputs: [MAIN],
    outputs: [MAIN],
    usableAsTool: true,
    credentials: [{ name: api.CREDENTIAL, required: true }],
    properties
  };

  methods = {
    loadOptions: {
      /** Live op catalogue (`GET /api/v1/ops`), static list when the request fails. */
      async getOps(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        try {
          const options = toOpOptions(await api.listOps(this, "load-options"));
          return options.length ? options : toOpOptions(STATIC_OPS);
        } catch {
          return toOpOptions(STATIC_OPS);
        }
      },
      /** Built-in presets first, then the account's own; value = id, label = slug. */
      async getPresets(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const presets = await api.listPresets(this);
        return presets.map((p) => ({
          name: p.slug || p.name || p.id,
          value: p.id,
          description: [p.builtIn ? "built-in" : "yours", p.description].filter(Boolean).join(" · ")
        }));
      }
    }
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const resource = this.getNodeParameter("resource", 0) as string;
    const operation = this.getNodeParameter("operation", 0) as string;
    // Per execution, not per item (#523): the op catalogue is read once — it was one `GET /api/v1/ops` per item. And
    // read first, whatever the node is set to and before any check of its own (#873): this read, marked `execute`, is
    // the trace an execution leaves on the service even when it then stops inside n8n — an item with no file stops
    // before anything else is sent (#852). It runs beside the items, never in their way: a catalogue that cannot be
    // read only sends op:run down the job path, as before.
    const catalogue = api.syncEndpoints(this, "execute");
    catalogue.catch(() => {}); // settled below; an item that never asks for it must not leave a rejection unhandled
    const lanes: Lanes = {
      syncEndpoints: () => catalogue,
      serial: serialLane(),
      // Set by the failing item itself, before its turn on the serial lane passes to the next one.
      halted: false
    };
    const results: INodeExecutionData[][] = new Array(items.length);
    let failure = null as Failure | null;
    let next = 0;

    // A pool of ITEM_CONCURRENCY workers over the items; the output keeps item order and each row's pairedItem.
    const worker = async () => {
      while (!failure && !lanes.halted && next < items.length) {
        const i = next++;
        try {
          results[i] = (await runOne(this, resource, operation, i, lanes)).map((item) => ({ ...item, pairedItem: { item: i } }));
        } catch (error) {
          if (error === NOT_STARTED) continue;
          if (this.continueOnFail()) {
            const failed = error as Failure;
            // Wait Seconds ran out (#570): the job is still running, so the row is its handle, flagged `timedOut` — the
            // field to branch on before Job → Wait — rather than an error row that reads like a failed job.
            const handle = failed.timedOut && failed.job ? { ...jobRef(failed.job), timedOut: true } : {};
            results[i] = [
              {
                json: {
                  ...handle,
                  error: failed.message,
                  // An API answer with no error envelope has no code (#766); a failure this node raised has internal_error.
                  code: failed.timedOut ? null : (failed.code ?? (failed.httpCode ? null : "internal_error")),
                  param: failed.param ?? null,
                  retryable: failed.retryable ?? false
                },
                pairedItem: { item: i }
              }
            ];
            continue;
          }
          const failed = error as Failure;
          if (failed.itemIndex === undefined) failed.itemIndex = i;
          // No new item starts after a failure; of the items already running, the first one to fail is reported. Another
          // worker may have set `failure` while this item ran, so it is read again rather than narrowed by the loop test.
          const earlier = failure as Failure | null;
          if (!earlier || failed.itemIndex < (earlier.itemIndex as number)) failure = failed;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, items.length) }, worker));
    await catalogue.catch(() => {}); // the execution ends with its read answered, a local failure included
    if (failure) throw failure;
    return [results.flat().filter(Boolean)];
  }
}

/** A one-at-a-time queue: `run(fn)` starts `fn` once every earlier `fn` has settled, in call order. */
function serialLane(): Lanes["serial"] {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** One input item → zero or more output items ({ json, binary? }). A synchronous op runs as is; the rest queue. */
async function runOne(ctx: IExecuteFunctions, resource: string, operation: string, i: number, lanes: Lanes): Promise<INodeExecutionData[]> {
  if (resource === "op" && operation === "run") {
    const op = ctx.getNodeParameter("op", i) as string;
    const inputMode = ctx.getNodeParameter("inputMode", i, "binary");
    // Input None on an op that needs an image stops here, whatever Store Result and Dry Run say (#901): the job could
    // only be refused for its missing asset id, which said nothing to someone who meant to draw from a prompt.
    if (inputMode === "none" && NEEDS_IMAGE_OPS.includes(op)) {
      throw new NodeOperationError(ctx.getNode(), `Input is set to None, but '${op}' works on an image you give it`, {
        itemIndex: i,
        description:
          "To draw an image from text, set Op to generate and put the text in Prompt. To process an image, set Input to Binary File (a file the previous node outputs) or Asset IDs (images already in ImageStep)."
      });
    }
    // An empty Prompt is the same kind of request (#901): the service refuses generate and edit without one. Most often it
    // is an expression that resolved to nothing for this item, so the hint names the field a Chat Trigger puts its text in.
    if (PROMPT_REQUIRED_OPS.includes(op) && !String(ctx.getNodeParameter("prompt", i, "") ?? "").trim()) {
      throw new NodeOperationError(ctx.getNode(), `Prompt is empty, and '${op}' needs one`, {
        itemIndex: i,
        description:
          "Put the text in Prompt — what to draw, or the edit instruction. If Prompt is an expression, check that it resolves to text for this item: after a Chat Trigger, the message is {{ $json.chatInput }}."
      });
    }
    if (!ctx.getNodeParameter("storeResult", i, false) && !ctx.getNodeParameter("dryRun", i, false)) {
      // An item with no file stops here (#852): nothing it could run needs the service, so the execution's catalogue
      // read, sent before any item started (#873), is all that reaches it.
      if (inputMode === "binary" && !INPUT_OPTIONAL_OPS.includes(op)) {
        api.requireBinary(ctx, i, ctx.getNodeParameter("binaryProperty", i, "data") as string, "op");
      }
      // Store Result off (the default) means: transform the binary we were handed and give the result straight back. No
      // asset, no publish, no polling — and, crucially, nothing of the customer's is made world-readable just so the
      // workflow can read its own output, which is what the job path had to do (publish → fetch from the CDN).
      const sync = await runSyncOp(ctx, i, op, lanes);
      if (sync) return sync;
    }
  }
  return lanes.serial(async () => {
    if (lanes.halted) throw NOT_STARTED; // an earlier item failed the node while this one waited its turn
    try {
      return await runQueued(ctx, resource, operation, i);
    } catch (error) {
      if (!ctx.continueOnFail()) lanes.halted = true;
      throw api.asNodeError(ctx, error, i);
    }
  });
}

/** Everything that is not a synchronous op: uploads, jobs, presets, reads. */
async function runQueued(ctx: IExecuteFunctions, resource: string, operation: string, i: number): Promise<INodeExecutionData[]> {
  const p = paramsOf(ctx, i);

  if (resource === "asset") {
    if (operation === "upload") {
      const asset = await api.uploadBinary(ctx, i, p("binaryProperty", "data"), {
        collection: p("collection", ""),
        retentionDays: p("retentionDays", 0),
        wait: p("waitForReady", true)
      });
      return [{ json: assetRef(asset) }];
    }
    if (operation === "uploadFromUrl") {
      const urls = String(p("urls", ""))
        .split(/[\s,]+/)
        .map((u) => u.trim())
        .filter(Boolean);
      const results = await api.uploadFromUrls(ctx, urls, {
        collection: p("collection", ""),
        retentionDays: p("retentionDays", 0),
        wait: p("waitForReady", true),
        itemIndex: i
      });
      // One output item per URL, a failed one included: a workflow routes the misses instead of stopping on them. A URL
      // the service took whose ingest then FAILED is a miss too, and carries `error` the same way, beside its asset (#759).
      return results.map((r) => ({
        json: r.asset ? { url: r.url, ...assetRef(r.asset), error: r.error } : { url: r.url, error: r.error }
      }));
    }
    if (operation === "get") return [{ json: assetRef(await api.getAsset(ctx, p<string>("assetId"))) }];
    // A cursor (the nextCursor of an earlier List, #493) says where the page starts, so the Page field is not sent with it.
    const position = (): IDataObject => (p("cursor", "") ? { cursor: p("cursor", "") } : { page: p("page", 0) });
    if (operation === "list") {
      const { items, meta } = await api.listAssets(ctx, {
        collection: p("collection", ""),
        q: p("q", ""),
        mime: p("mime", ""),
        status: p("status", ""),
        createdFrom: p("createdFrom", ""),
        createdTo: p("createdTo", ""),
        ...position(),
        perPage: p("perPage", 100)
      });
      return items.map((a) => ({
        json: { ...assetRef(a), page: meta?.page, total: meta?.total, hasMore: meta?.hasMore, nextCursor: meta?.nextCursor ?? null }
      }));
    }
    if (operation === "listCollections") {
      const { items, meta } = await api.listCollections(ctx, { q: p("q", ""), ...position(), perPage: p("perPage", 100) });
      return items.map((c) => ({
        json: {
          collection: c.collection,
          count: c.count,
          lastAddedAt: c.lastCreatedAt ? new Date(c.lastCreatedAt).toISOString() : undefined,
          page: meta?.page,
          total: meta?.total,
          hasMore: meta?.hasMore,
          nextCursor: meta?.nextCursor ?? null
        }
      }));
    }
    if (operation === "publish") {
      const ids = assetIdsField(ctx, i, "publish");
      if (!ids.length) throw new NodeOperationError(ctx.getNode(), "Asset IDs is empty", { itemIndex: i });
      return (await api.publishAssets(ctx, ids, { itemIndex: i })).map((a) => ({ json: assetRef(a) }));
    }
  }

  if (resource === "op" && operation === "run") {
    const op = p<string>("op");
    const options = p<RunOptions>("options", {});
    const input = await resolveInputAssets(ctx, i, options, op);
    const body = buildOpJobBody({
      op,
      assetIds: input.assetIds,
      imageCount: input.imageCount,
      prompt: p("prompt", ""),
      count: op === "generate" ? p("count", 1) : undefined,
      model: options.model,
      parameters: parseParameters(p("parameters", "{}")),
      collection: options.collection,
      retentionDays: options.retentionDays
    });
    return runJob(ctx, i, body);
  }

  if (resource === "preset" && operation === "run") {
    const options = p<RunOptions>("options", {});
    const fromPrompt = p("inputMode", "binary") === "none";
    const { assetIds, imageCount } = await resolveInputAssets(ctx, i, options);
    if (!assetIds.length && !imageCount && !fromPrompt)
      throw new NodeOperationError(ctx.getNode(), "A preset needs at least one input asset", { itemIndex: i });
    return runJob(
      ctx,
      i,
      buildPresetJobBody({
        presetId: p<string>("preset"),
        assetIds,
        imageCount,
        version: p("presetVersion", 0),
        collection: options.collection,
        retentionDays: options.retentionDays,
        prompt: p("prompt", ""),
        count: p("count", 0),
        fromPrompt
      })
    );
  }

  if (resource === "job") {
    const id = p<string>("jobId");
    const job = operation === "wait" ? await api.waitJob(ctx, id, { timeoutMs: p("waitSeconds", 180) * 1000 }) : await api.getJob(ctx, id);
    return finish(ctx, job, { publish: p("publish", true), download: p("downloadOutput", false), itemIndex: i });
  }

  throw new NodeOperationError(ctx.getNode(), `Unsupported: ${resource}.${operation}`, { itemIndex: i });
}

/**
 * The images the current item runs on: `{ assetIds }` uploaded from the binary property, taken from the field, or none.
 *
 * A Dry Run over a Binary File uploads nothing (#572): it answers `{ assetIds: [], imageCount: 1 }`, and the service
 * prices the one image by count (imagestep#586) — the price depends on the op, model and parameters, never on the
 * pixels. Pricing it used to mean uploading it, and Dry Run, which says nothing is created, left an asset behind that
 * counted against the quota. The binary still has to be there, as it would for the run.
 */
async function resolveInputAssets(
  ctx: IExecuteFunctions,
  i: number,
  { collection, retentionDays }: RunOptions = {},
  op?: string
): Promise<{ assetIds: string[]; imageCount?: number }> {
  const mode = ctx.getNodeParameter("inputMode", i, "binary");
  if (mode === "assetIds") return { assetIds: assetIdsField(ctx, i, op ? "op" : "preset") };
  if (mode === "binary") {
    const property = ctx.getNodeParameter("binaryProperty", i, "data") as string;
    const from = op ? "op" : "preset";
    // generate (or render_template) left on Binary File after a node with no file runs as Input None would (#852).
    if (op && INPUT_OPTIONAL_OPS.includes(op)) {
      try {
        ctx.helpers.assertBinaryData(i, property);
      } catch {
        return { assetIds: [] };
      }
    }
    if (ctx.getNodeParameter("dryRun", i, false)) {
      api.requireBinary(ctx, i, property, from);
      return { assetIds: [], imageCount: 1 };
    }
    const asset = await api.uploadBinary(ctx, i, property, { collection, retentionDays, wait: true, from });
    // Taken, then ingest FAILED (#759): a job on it would be accepted and fail item by item, with another code and the
    // job's `retryable` in place of the asset's, which says whether uploading the file again can help (#734).
    if (asset.status === "FAILED") {
      const { code = "internal_error", message = "ingest failed", retryable = true } = asset.error || {};
      throw Object.assign(
        new NodeOperationError(ctx.getNode(), `ImageStep ${code} (param: ${property}): ${asset.name || asset.id}: ${message}`, {
          itemIndex: i,
          description: `retryable=${retryable}`
        }),
        { code, retryable, param: property }
      );
    }
    return { assetIds: [asset.id] };
  }
  return { assetIds: [] };
}

/**
 * The Asset IDs field, split into ids — every one of which must look like an asset id (`ast_…`), or nothing is sent
 * (#901). A Chat Trigger's whole output mapped into the field went out as twelve "ids" cut from its JSON, and the 404
 * that listed them did not say what had gone wrong: the field wants the id alone, and a prompt belongs to generate.
 */
function assetIdsField(ctx: IExecuteFunctions, i: number, use: "op" | "preset" | "publish"): string[] {
  const raw = ctx.getNodeParameter("assetIds", i, "");
  const ids = normaliseIds(raw);
  if (ids.every((id) => id.startsWith("ast_"))) return ids;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  const ways = [
    "Did the previous node's whole output get mapped into it? Map only the asset ID — after an ImageStep upload, the expression {{ $json.assetId }}.",
    ...(use === "op" ? ["To draw an image from text, set Op to generate, Input to None, and put the text in Prompt."] : []),
    ...(use === "preset" ? ["A preset whose first step is generate starts from a prompt: set Input to None."] : [])
  ];
  throw new NodeOperationError(ctx.getNode(), `Asset IDs takes ImageStep asset IDs (ast_…), but got: ${shown}`, {
    itemIndex: i,
    description: ways.join(" ")
  });
}

/**
 * Submit (or price) a job, then wait / publish / download per the node's switches.
 *
 * Publish Outputs and Download Outputs show only while Store Result is on (description.ts), and n8n answers a hidden
 * field with the fallback read here — for Publish, on. So an AI op, or a preset, left at Store Result off published
 * every output to a public URL while the field said nothing is published (#564). Off, a job still runs and is waited
 * for, and its outputs come back as asset ids that nobody else can read.
 */
async function runJob(ctx: IExecuteFunctions, i: number, body: JobBody): Promise<INodeExecutionData[]> {
  const dryRun = ctx.getNodeParameter("dryRun", i, false);
  if (dryRun) return [{ json: { dryRun: true, request: body, estimate: await api.submitJob(ctx, body, { dryRun: true, itemIndex: i }) } }];
  if (!ctx.getNodeParameter("wait", i, true)) return [{ json: jobRef(await api.submitJob(ctx, body, { itemIndex: i })) }];
  const timeoutMs = (ctx.getNodeParameter("waitSeconds", i, 180) as number) * 1000;
  const started = Date.now();
  const job = await api.submitJob(ctx, body, { waitMs: timeoutMs, itemIndex: i });
  const done = await api.waitJob(ctx, job.id, { timeoutMs: Math.max(0, timeoutMs - (Date.now() - started)), known: job });
  const store = ctx.getNodeParameter("storeResult", i, false);
  return finish(ctx, done, {
    publish: !!store && (ctx.getNodeParameter("publish", i, true) as boolean),
    download: !!store && (ctx.getNodeParameter("downloadOutput", i, false) as boolean),
    itemIndex: i
  });
}

/**
 * The synchronous path: one image in, one image out, nothing stored.
 *
 * Returns null when this item cannot go that way, so the caller falls through to the job path. Two
 * questions decide it, and neither is a list kept in this file:
 *   - **may this op run synchronously** — the API's answer (`GET /api/v1/ops` → `syncEndpoint`), so
 *     a deterministic op added to the API works here without a release; AI ops have no
 *     `syncEndpoint` and never will;
 *   - **is this item one image** — {@link syncInput}, which reads `inputMode`.
 */
async function runSyncOp(ctx: IExecuteFunctions, i: number, op: string, lanes: Lanes): Promise<INodeExecutionData[] | null> {
  const p = paramsOf(ctx, i);
  let endpoints: Record<string, string | null>;
  try {
    endpoints = await lanes.syncEndpoints();
  } catch {
    return null; // catalogue unreachable → the job path still works. Slower beats wrong.
  }
  // Only an op the catalogue answers at /images/transform, the one endpoint this path calls: render_template's is
  // /images/render, which takes a template and a row, not an image — sent here it was a 400 every time (#901).
  if (endpoints[op] !== "POST /api/v1/images/transform") return null;

  const input = await syncInput(ctx, i, p);
  if (!input) return null;

  const qs = { op, ...parseParameters(p("parameters", "{}")) };
  const answer = await api.apiRequestBinary(ctx, "/api/v1/images/transform", {
    qs,
    body: input.body,
    contentType: input.contentType
  });
  const out = answer.buffer as Buffer;
  const mimeType = answer.mimeType;

  const fileName = renameExtension(input.fileName, mimeType);
  return [
    {
      json: { op, mode: "sync", stored: false, bytes: out.length, mimeType, ...input.json },
      binary: { [input.property]: await ctx.helpers.prepareBinaryData(out, fileName, mimeType) }
    }
  ];
}

/**
 * What the synchronous call sends for this item — or null when the item is not one image, which
 * means the job path (#92). The sync face takes bytes OR a reference, so `inputMode` decides which:
 *
 *   - **Binary File** → the bytes of that property, raw body, back out on the same property.
 *   - **Asset IDs**, exactly one → the JSON form `{"assetId"}` (contract §9): the service reads its
 *     own bucket, runs the op and hands the bytes straight back. Still nothing stored, still no
 *     publish — an asset you already own does not have to become a job to be resized. Several ids
 *     are a batch and a batch is a job; none is nothing to do here.
 *   - **None** (generate) → no input bytes at all, so there is nothing this path could send.
 *
 * `binaryProperty` is read at the TOP LEVEL, where `description.ts` puts it — not off the Options
 * collection, which never carried it (#91).
 */
async function syncInput(
  ctx: IExecuteFunctions,
  i: number,
  p: Param
): Promise<{ body: Buffer | string; contentType: string; fileName: string; property: string; json?: IDataObject } | null> {
  const mode = p("inputMode", "binary");
  if (mode === "binary") {
    const property = p("binaryProperty", "data");
    const meta = api.requireBinary(ctx, i, property, "op");
    return {
      body: await ctx.helpers.getBinaryDataBuffer(i, property),
      contentType: meta.mimeType || "application/octet-stream",
      fileName: meta.fileName || "image",
      property
    };
  }
  if (mode === "assetIds") {
    const ids = assetIdsField(ctx, i, "op");
    if (ids.length !== 1) return null;
    return {
      body: JSON.stringify({ assetId: ids[0] }),
      contentType: "application/json",
      fileName: ids[0],
      property: "data",
      json: { sourceAssetId: ids[0] }
    };
  }
  return null;
}

/** `photo.jpg` + `image/webp` → `photo.webp`, so a downstream Write File node does the right thing. */
function renameExtension(fileName: string, mimeType: string): string {
  const ext = (mimeType.split("/")[1] || "").replace("jpeg", "jpg");
  if (!ext) return fileName;
  const dot = fileName.lastIndexOf(".");
  return (dot > 0 ? fileName.slice(0, dot) : fileName) + "." + ext;
}

/** jobRef with outputs — one item, or one item per output carrying the bytes when downloading. */
async function finish(
  ctx: IExecuteFunctions,
  job: Job,
  { publish, download, itemIndex }: { publish: boolean; download: boolean; itemIndex: number }
): Promise<INodeExecutionData[]> {
  // analyze writes its answer onto the input assets and creates none (imagestep#202): nothing to publish or download.
  if (job.type === "parse") return [{ json: { ...jobRef(job), analyses: analysesOf(job) } }];
  const outputs = await api.collectOutputs(ctx, job, { publish, itemIndex });
  const ref = jobRef(job, outputs);
  if (!download || !outputs.length) return [{ json: ref }];
  const out: INodeExecutionData[] = [];
  for (const asset of outputs) {
    const { buffer, mimeType, fileName } = await api.downloadOutput(ctx, asset);
    out.push({
      json: { ...ref, output: assetRef(asset) },
      binary: { data: await ctx.helpers.prepareBinaryData(buffer, fileName, mimeType) }
    });
  }
  return out;
}

/** Each analyzed input's answer: its job item's output (imagestep#338), one per item, in item order. */
function analysesOf(job: Job): IDataObject[] {
  return (job.items || []).filter((i) => i.status === "COMPLETED" && i.output).map((i) => ({ assetId: i.sourceAssetId, output: i.output }));
}

/** The Options collection of Operation → Run and Preset → Run. */
interface RunOptions {
  model?: string;
  collection?: string;
  retentionDays?: number;
}

/** `p(name, fallback)`: the current item's parameter. */
function paramsOf(ctx: IExecuteFunctions, i: number): Param {
  return ((name: string, fallback?: unknown) => ctx.getNodeParameter(name, i, fallback as never)) as Param;
}
