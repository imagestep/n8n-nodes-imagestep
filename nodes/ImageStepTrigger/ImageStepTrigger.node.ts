import { NodeConnectionTypes } from "n8n-workflow";
import type {
  IDataObject,
  IHookFunctions,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData
} from "n8n-workflow";
import * as api from "../../lib/api";
import type { Failure } from "../../lib/api";
import { verifySignature } from "../../lib/signature";

const MAIN = (NodeConnectionTypes && NodeConnectionTypes.Main) || "main";

const EVENTS: INodePropertyOptions[] = [
  { name: "Job Completed", value: "job.completed", description: "Every item settled, none failed" },
  { name: "Job Failed", value: "job.failed", description: "Every item settled, at least one failed (or the job was cancelled)" },
  { name: "Job Item Completed", value: "job.item.completed", description: "One item finished — opt in; a 500-item job sends 500 of these" },
  { name: "Job Item Failed", value: "job.item.failed", description: "One item failed — opt in" }
];

/** How many event ids the replay guard keeps: a 500-item job's per-item events, twice over, in one window. */
const SEEN_LIMIT = 1000;

/**
 * Whether this event id was already delivered while a signature for it can still verify (#945): a captured delivery
 * sent again inside the tolerance — the signature alone lets that through for up to an hour — or a retry of a delivery
 * whose 200 was lost on the way back. The id is kept in the node's static data until `tolerance` seconds from now, which
 * outlasts every signature that can still verify for it; expired ids are forgotten, then the oldest past SEEN_LIMIT.
 */
function seenBefore(staticData: IDataObject, id: string, tolerance: number, now: number): boolean {
  const seen = { ...((staticData.seenEvents as Record<string, number> | undefined) || {}) };
  for (const [key, until] of Object.entries(seen)) if (!(until > now)) delete seen[key];
  const repeat = id in seen;
  const until = Math.max(seen[id] || 0, now + tolerance);
  // Re-inserted, so the keys stay in the order they expire and the oldest are the first ones dropped.
  delete seen[id];
  seen[id] = until;
  const keys = Object.keys(seen);
  for (const old of keys.slice(0, Math.max(0, keys.length - SEEN_LIMIT))) delete seen[old];
  staticData.seenEvents = seen;
  return repeat;
}

/**
 * ImageStep Trigger — a webhook endpoint registered on activation (`POST /api/v1/webhook-endpoints`),
 * verified per delivery (HMAC-SHA256 over `"<t>.<raw body>"`, docs/api-contract.md §6) and
 * removed on deactivation. Emits one item per event: `{ id, type, apiVersion, createdAt, attempt, data }` — the
 * event's envelope plus the delivery's attempt number. A second delivery of one event id inside the signature
 * tolerance is answered 200 and runs nothing (`seenBefore`).
 */
export class ImageStepTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "ImageStep Trigger",
    name: "imageStepTrigger",
    // The ImageStep node's icon, not a copy of it: one mark, one file (the brand geometry has five copies already).
    icon: "file:../ImageStep/imagestep.svg",
    group: ["trigger"],
    version: 1,
    subtitle: '={{ $parameter["events"].join(", ") }}',
    description: "Starts the workflow when an ImageStep job finishes (signed webhook — stop polling)",
    defaults: { name: "ImageStep Trigger" },
    inputs: [],
    outputs: [MAIN],
    credentials: [{ name: api.CREDENTIAL, required: true }],
    webhooks: [{ name: "default", httpMethod: "POST", responseMode: "onReceived", path: "webhook" }],
    properties: [
      {
        displayName: "Events",
        name: "events",
        type: "multiOptions",
        options: EVENTS,
        default: ["job.completed", "job.failed"],
        required: true,
        description: "Which events to subscribe to. Per-item events are opt-in for a reason: they arrive once per item."
      },
      {
        displayName: "Signature Tolerance (Seconds)",
        name: "tolerance",
        type: "number",
        default: 300,
        typeOptions: { minValue: 30, maxValue: 3600 },
        description: "Reject deliveries whose signed timestamp is older than this — the replay guard"
      }
    ]
  };

  webhookMethods = {
    default: {
      /** The stored endpoint still exists on the account and points at this URL. */
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData("node");
        if (!staticData.webhookId) return false;
        try {
          const endpoint = await api.getWebhookEndpoint(this, staticData.webhookId as string);
          if (endpoint && endpoint.url === this.getNodeWebhookUrl("default")) return true;
        } catch (error) {
          if (String((error as Failure).httpCode) !== "404") throw api.asNodeError(this, error);
        }
        delete staticData.webhookId;
        delete staticData.webhookSecret;
        return false;
      },
      /** Register; the secret is returned once, so it is stored right here. */
      async create(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData("node");
        const endpoint = await api.createWebhookEndpoint(this, {
          url: this.getNodeWebhookUrl("default") as string,
          events: this.getNodeParameter("events") as string[],
          description: `n8n: ${this.getWorkflow().name || "workflow"} / ${this.getNode().name}`
        });
        staticData.webhookId = endpoint.id;
        staticData.webhookSecret = endpoint.secret;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData("node");
        if (staticData.webhookId) {
          try {
            await api.deleteWebhookEndpoint(this, staticData.webhookId as string);
          } catch (error) {
            if (String((error as Failure).httpCode) !== "404") return false;
          }
        }
        delete staticData.webhookId;
        delete staticData.webhookSecret;
        return true;
      }
    }
  };

  /** One delivery. Verify first, answer fast, then hand the event to the workflow. */
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject() as { rawBody?: Buffer };
    const res = this.getResponseObject();
    const headers = (this.getHeaderData() || {}) as Record<string, string | undefined>;
    const staticData = this.getWorkflowStaticData("node");
    const secret = staticData.webhookSecret as string | undefined;
    const tolerance = this.getNodeParameter("tolerance", 300) as number;

    // The contract signs the raw bytes. n8n keeps them on req.rawBody; when a proxy or an older
    // n8n drops that, the parsed body is re-serialised — that is best effort and the README says so.
    const rawBody = req && req.rawBody ? req.rawBody : JSON.stringify(this.getBodyData());
    const signature = headers["imagestep-signature"];
    if (!secret || !verifySignature(rawBody, signature, secret, { toleranceSeconds: tolerance })) {
      res.status(401).json({ error: "invalid signature" });
      return { noWebhookResponse: true };
    }

    const event = (this.getBodyData() || {}) as IDataObject;
    // The body's id, which the signature covers — never the ImageStep-Event-Id header, which it does not. A 200, so
    // a retry whose first answer was lost stops there, and nothing reaches the workflow a second time.
    if (typeof event.id === "string" && seenBefore(staticData, event.id, tolerance, Math.floor(Date.now() / 1000))) {
      res.status(200).json({ received: true, duplicate: true });
      return { noWebhookResponse: true };
    }
    return {
      workflowData: [
        this.helpers.returnJsonArray([
          {
            id: event.id || headers["imagestep-event-id"],
            type: event.type || headers["imagestep-event-type"],
            apiVersion: event.apiVersion,
            createdAt: event.createdAt,
            attempt: Number(headers["imagestep-attempt"] || 1),
            data: event.data || {}
          }
        ])
      ]
    };
  }
}
