import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ImageStep } from "../nodes/ImageStep/ImageStep.node.ts";
import { STATIC_OPS } from "../lib/ops.ts";
import { fakeContext, ok } from "./fake-context.js";

/**
 * imagestep#901 — every way Operation → Run can be set, against what the service refuses before it looks at anything else.
 *
 * Each new user who left had sent a request that could only be refused: Input None with an op that needs an image, then a
 * Chat Trigger's whole item as Asset IDs. The tests before this one asked whether the configurations we use work; none
 * asked whether a configuration someone else picks can only fail. This one does, for each Op × Input × Prompt × Store
 * Result × Dry Run: the node either stops in n8n with its own message, or what it sends passes the service's first
 * checks —
 *   - an op that needs an image gets one (`requiresAssets` → no `inputOptional` in lib/static-ops.json), as asset ids, as
 *     `imageCount` on a dry run, or as the bytes of a synchronous call;
 *   - an op that needs a prompt gets text (`requiresPrompt` → `promptRequired`);
 *   - a synchronous call goes to the endpoint the catalogue names for that op (`syncEndpoint`).
 * lib/static-ops.json is written from apps/service/openapi/ops.json, which CI's service job holds to the running service,
 * so these are the service's own rules, not a copy kept here.
 */

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const sha1 = createHash("sha1").update(png).digest("hex");
const chat = JSON.stringify({ action: "sendMessage", sessionId: "s1", chatInput: "draw a red bicycle" });

/** What the catalogue read answers: every job op, the deterministic ones with the endpoint the service gives them. */
function catalogue() {
  return STATIC_OPS.map((o) => ({
    op: o.op,
    kind: o.kind,
    syncEndpoint:
      o.kind !== "deterministic" ? null : o.op === "render_template" ? "POST /api/v1/images/render" : "POST /api/v1/images/transform"
  }));
}

const INPUTS = {
  "Binary File, no file": { params: { inputMode: "binary" }, binary: {} },
  "Binary File": { params: { inputMode: "binary" }, binary: { data: { buffer: png, fileName: "cat.png", mimeType: "image/png" } } },
  None: { params: { inputMode: "none" }, binary: {} },
  "Asset IDs, one": { params: { inputMode: "assetIds", assetIds: "ast_1" }, binary: {} },
  "Asset IDs, two": { params: { inputMode: "assetIds", assetIds: "ast_1, ast_2" }, binary: {} },
  "Asset IDs, a whole item": { params: { inputMode: "assetIds", assetIds: chat }, binary: {} }
};
const PROMPTS = { "no prompt": "", "a blank prompt": "  ", "a prompt": "a red bicycle" };
const SWITCHES = {
  defaults: {},
  "Store Result": { storeResult: true },
  "Dry Run": { dryRun: true },
  "Store Result + Dry Run": { storeResult: true, dryRun: true }
};

/** Run one configuration; the requests that reached the service after the catalogue read, and how the node ended. */
async function run(op, input, prompt, switches) {
  const sent = [];
  const routes = {
    "GET /api/v1/ops": () => ok(catalogue()),
    "POST /api/v1/jobs": (req, url) => {
      sent.push({ path: url.pathname, body: req.body, dryRun: url.searchParams.get("dryRun") === "true" });
      return url.searchParams.get("dryRun") === "true"
        ? ok({ totalItems: 1, estimatedCredits: 0, sufficientCredit: true })
        : ok({ id: "job_1", status: "PENDING", items: [] });
    },
    "POST /api/v1/images/transform": (req, url) => {
      sent.push({ path: url.pathname, qs: req.qs, body: req.body });
      return { status: 200, headers: { "content-type": "image/png" }, body: png };
    },
    "POST /api/v1/images/render": (req, url) => {
      sent.push({ path: url.pathname, qs: req.qs, body: req.body });
      return { status: 200, headers: { "content-type": "image/png" }, body: png };
    },
    "POST /api/v1/assets/stage-upload": () => ok([{ objectId: "obj1", url: "https://storage.test/bucket/obj1?sig=1", sha1Hash: sha1 }]),
    "PUT storage.test/bucket/obj1": () => ({ status: 200, body: "" }),
    "POST /api/v1/assets/finish-upload": () => ok([{ id: "ast_up", name: "cat.png", status: "DONE" }]),
    "POST /api/v1/assets/status": () => ok({ items: [{ id: "ast_up", status: "DONE" }] }),
    "GET /api/v1/assets/ast_up": () => ok({ id: "ast_up", name: "cat.png", status: "DONE", image: { width: 1, height: 1 } })
  };
  const params = {
    resource: "op",
    operation: "run",
    op,
    binaryProperty: "data",
    parameters: "{}",
    prompt,
    wait: false,
    ...input.params,
    ...switches
  };
  const ctx = fakeContext({ routes, params, binary: input.binary });
  const error = await new ImageStep().execute.call(ctx).catch((e) => e);
  return { sent, error: error instanceof Error ? error : null };
}

/** Why the service's first checks refuse this request, or null when they let it through. */
function refusal(entry, request) {
  if (request.path === "/api/v1/jobs") {
    const body = request.body || {};
    if (!entry.inputOptional && !body.assetIds?.length && !body.imageCount) return "an op that needs an image got none";
    if (entry.promptRequired && !String(body.prompt ?? "").trim()) return "an op that needs a prompt got none";
    return null;
  }
  const named = catalogue().find((o) => o.op === entry.op)?.syncEndpoint;
  if (named !== `POST ${request.path}`) return `a synchronous call to ${request.path}, which the catalogue does not name for it`;
  return null;
}

describe("Operation → Run never sends what the service can only refuse (#901)", () => {
  it("every Op × Input × Prompt × Store Result × Dry Run stops in the node or sends a request the service takes", async () => {
    const doomed = [];
    for (const entry of STATIC_OPS) {
      for (const [inputName, input] of Object.entries(INPUTS)) {
        for (const [promptName, prompt] of Object.entries(PROMPTS)) {
          for (const [switchName, switches] of Object.entries(SWITCHES)) {
            const { sent, error } = await run(entry.op, input, prompt, switches);
            for (const request of sent) {
              const why = refusal(entry, request);
              if (why) doomed.push(`${entry.op} · ${inputName} · ${promptName} · ${switchName}: ${why}`);
            }
            if (!sent.length && !error) doomed.push(`${entry.op} · ${inputName} · ${promptName} · ${switchName}: nothing sent, no error`);
            if (error && error.constructor.name !== "NodeOperationError")
              doomed.push(`${entry.op} · ${inputName} · ${promptName} · ${switchName}: ${error.constructor.name} ${error.message}`);
          }
        }
      }
    }
    expect(doomed).toEqual([]);
  });

  it("and stops only what cannot run: every op runs given an image, and a prompt when it takes one", async () => {
    const blocked = [];
    for (const entry of STATIC_OPS) {
      for (const inputName of ["Binary File", "Asset IDs, one", "Asset IDs, two"]) {
        for (const [switchName, switches] of Object.entries(SWITCHES)) {
          const { sent, error } = await run(entry.op, INPUTS[inputName], "a red bicycle", switches);
          if (error || !sent.length) blocked.push(`${entry.op} · ${inputName} · ${switchName}: ${error?.message ?? "nothing sent"}`);
        }
      }
    }
    expect(blocked).toEqual([]);
  });

  it("an op that needs no image runs from nothing: Input None, and Binary File after a node with no file", async () => {
    const blocked = [];
    for (const entry of STATIC_OPS.filter((o) => o.inputOptional)) {
      for (const inputName of ["None", "Binary File, no file"]) {
        for (const [switchName, switches] of Object.entries(SWITCHES)) {
          const { sent, error } = await run(entry.op, INPUTS[inputName], "a red bicycle", switches);
          if (error || !sent.length) blocked.push(`${entry.op} · ${inputName} · ${switchName}: ${error?.message ?? "nothing sent"}`);
        }
      }
    }
    expect(blocked).toEqual([]);
  });
});
