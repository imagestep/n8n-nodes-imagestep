import { describe, expect, it } from "vitest";
import { ImageStepTrigger } from "../nodes/ImageStepTrigger/ImageStepTrigger.node.ts";
import { fakeContext, fail, ok, signBody } from "./fake-context.js";

const secret = "whsec_test";
const event = {
  id: "evt_1",
  type: "job.completed",
  apiVersion: "v1",
  createdAt: "2026-09-08T07:11:00Z",
  data: { jobId: "job_1", status: "COMPLETED" }
};

/** A delivery context: raw body on the request, headers as n8n lowercases them, a recording response. */
function delivery({ rawBody, header, staticData = { webhookId: "wh_1", webhookSecret: secret }, body }) {
  const ctx = fakeContext({ staticData, params: { tolerance: 300 } });
  ctx.response = { statusCode: null, payload: null };
  ctx.getRequestObject = () => ({ rawBody });
  ctx.getResponseObject = () => ({
    status(code) {
      ctx.response.statusCode = code;
      return this;
    },
    json(payload) {
      ctx.response.payload = payload;
    }
  });
  ctx.getHeaderData = () => ({
    "imagestep-signature": header,
    "imagestep-event-id": "evt_1",
    "imagestep-event-type": "job.completed",
    "imagestep-attempt": "2"
  });
  ctx.getBodyData = () => body ?? JSON.parse(rawBody.toString());
  return ctx;
}

describe("ImageStep Trigger — delivery", () => {
  const trigger = new ImageStepTrigger();
  const raw = Buffer.from(JSON.stringify(event));

  it("verifies the signature over the raw body and emits id / type / apiVersion / createdAt / attempt / data", async () => {
    const ctx = delivery({ rawBody: raw, header: signBody(raw, secret) });
    const out = await trigger.webhook.call(ctx);
    expect(ctx.response.statusCode).toBeNull();
    expect(out.workflowData[0][0].json).toStrictEqual({
      id: "evt_1",
      type: "job.completed",
      apiVersion: "v1",
      createdAt: event.createdAt,
      attempt: 2,
      data: event.data
    });
  });

  it("answers 401 without running the workflow on a bad signature, a tampered body, or no stored secret", async () => {
    const bad = delivery({ rawBody: raw, header: signBody(raw, "other") });
    expect(await trigger.webhook.call(bad)).toEqual({ noWebhookResponse: true });
    expect(bad.response).toEqual({ statusCode: 401, payload: { error: "invalid signature" } });

    const tampered = delivery({
      rawBody: Buffer.from(JSON.stringify({ ...event, data: { jobId: "job_2" } })),
      header: signBody(raw, secret)
    });
    expect((await trigger.webhook.call(tampered)).noWebhookResponse).toBe(true);

    const noSecret = delivery({ rawBody: raw, header: signBody(raw, secret), staticData: {} });
    expect((await trigger.webhook.call(noSecret)).noWebhookResponse).toBe(true);
  });

  // #945: inside the tolerance (up to an hour) the signature alone lets a captured delivery through again.
  it("runs the workflow once per event id: a second delivery inside the window is answered 200 and runs nothing", async () => {
    const staticData = { webhookId: "wh_1", webhookSecret: secret };
    const first = delivery({ rawBody: raw, header: signBody(raw, secret), staticData });
    expect((await trigger.webhook.call(first)).workflowData).toHaveLength(1);

    const again = delivery({ rawBody: raw, header: signBody(raw, secret), staticData });
    expect(await trigger.webhook.call(again)).toEqual({ noWebhookResponse: true });
    expect(again.response).toEqual({ statusCode: 200, payload: { received: true, duplicate: true } });

    const other = Buffer.from(JSON.stringify({ ...event, id: "evt_2" }));
    expect(
      (await trigger.webhook.call(delivery({ rawBody: other, header: signBody(other, secret), staticData }))).workflowData
    ).toHaveLength(1);
  });

  it("remembers an id only as long as a signature for it can verify, keeps at most 1000, and never one it refused", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = { webhookId: "wh_1", webhookSecret: secret, seenEvents: { evt_1: now - 1 } };
    expect(
      (await trigger.webhook.call(delivery({ rawBody: raw, header: signBody(raw, secret), staticData: expired }))).workflowData
    ).toHaveLength(1);
    expect(expired.seenEvents).toEqual({ evt_1: expect.any(Number) });
    expect(expired.seenEvents.evt_1).toBeGreaterThanOrEqual(now + 300);

    const full = { webhookId: "wh_1", webhookSecret: secret, seenEvents: {} };
    for (let i = 0; i < 1000; i++) full.seenEvents[`evt_old_${i}`] = now + 100;
    await trigger.webhook.call(delivery({ rawBody: raw, header: signBody(raw, secret), staticData: full }));
    expect(Object.keys(full.seenEvents)).toHaveLength(1000);
    expect(full.seenEvents).not.toHaveProperty("evt_old_0");
    expect(full.seenEvents).toHaveProperty("evt_1");

    // A forged delivery leaves no id behind, so it cannot shut the real one out.
    const staticData = { webhookId: "wh_1", webhookSecret: secret };
    await trigger.webhook.call(delivery({ rawBody: raw, header: signBody(raw, "other"), staticData }));
    expect(staticData).not.toHaveProperty("seenEvents");
    expect((await trigger.webhook.call(delivery({ rawBody: raw, header: signBody(raw, secret), staticData }))).workflowData).toHaveLength(
      1
    );
  });

  it("falls back to re-serialising the parsed body when rawBody is unavailable", async () => {
    const serialised = JSON.stringify(event);
    const ctx = delivery({ rawBody: undefined, header: signBody(serialised, secret), body: event });
    const out = await trigger.webhook.call(ctx);
    expect(out.workflowData[0][0].json.data).toEqual(event.data);
  });
});

describe("ImageStep Trigger — endpoint lifecycle", () => {
  const trigger = new ImageStepTrigger();

  it("create registers the n8n webhook URL with the selected events and stores id + secret once", async () => {
    const seen = {};
    const ctx = fakeContext({
      routes: {
        "POST /api/v1/webhook-endpoints": (req) => {
          seen.body = req.body;
          return ok({ id: "wh_1", url: req.body.url, events: req.body.events, secret: "whsec_new" });
        }
      },
      params: { events: ["job.completed"] }
    });
    expect(await trigger.webhookMethods.default.create.call(ctx)).toBe(true);
    expect(seen.body).toEqual({
      url: "https://n8n.example.com/webhook/abc",
      events: ["job.completed"],
      description: "n8n: Test workflow / ImageStep"
    });
    expect(ctx.staticData).toEqual({ webhookId: "wh_1", webhookSecret: "whsec_new" });
    expect(ctx.calls[0].headers["Idempotency-Key"]).toBeDefined();
  });

  it("checkExists is true only while the stored endpoint exists and still points at this URL", async () => {
    const live = fakeContext({
      routes: {
        "GET /api/v1/webhook-endpoints/wh_1": () => ok({ id: "wh_1", url: "https://n8n.example.com/webhook/abc", secretHint: "whse…" })
      },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.checkExists.call(live)).toBe(true);

    const moved = fakeContext({
      routes: { "GET /api/v1/webhook-endpoints/wh_1": () => ok({ id: "wh_1", url: "https://elsewhere.example.com/hook" }) },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.checkExists.call(moved)).toBe(false);
    expect(moved.staticData).toEqual({});

    const gone = fakeContext({
      routes: { "GET /api/v1/webhook-endpoints/wh_1": () => fail(404, { code: "not_found", message: "gone", retryable: false }) },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.checkExists.call(gone)).toBe(false);
    expect(await trigger.webhookMethods.default.checkExists.call(fakeContext({ staticData: {} }))).toBe(false);
  });

  it("delete removes the endpoint and forgets the secret; an already-deleted endpoint is fine", async () => {
    const ctx = fakeContext({
      routes: { "DELETE /api/v1/webhook-endpoints/wh_1": () => ({ status: 204, body: "" }) },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.delete.call(ctx)).toBe(true);
    expect(ctx.staticData).toEqual({});
    const gone = fakeContext({
      routes: { "DELETE /api/v1/webhook-endpoints/wh_1": () => fail(404, { code: "not_found", message: "gone", retryable: false }) },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.delete.call(gone)).toBe(true);
  });
});
