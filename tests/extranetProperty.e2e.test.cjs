// tests/extranetProperty.e2e.test.cjs
const request = require("supertest");

// Use live API base; override via API_BASE if needed
const BASE_URL = process.env.API_BASE || "https://lolaelo-api.onrender.com";
const TOKEN = process.env.PARTNER_TOKEN;
if (!TOKEN) throw new Error("Set PARTNER_TOKEN env var before running tests.");

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("extranet/property (live API)", () => {
  const api = () => request(BASE_URL);

  const fullPayload = (overrides = {}) => ({
    name: "Test Hotel",
    contactEmail: "ops@test.example",
    phone: "+1-555-555-0100",
    addressLine: "1 Test Way",
    city: "New York",
    country: "US",
    description: "E2E test",
    ...overrides,
  });

  test("GET -> 200 and cache disabled", async () => {
    const r = await api().get("/extranet/property").set(auth);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body).toBeDefined();
  });

  test("PUT full replace -> 200 persists all fields", async () => {
    const payload = fullPayload({ name: "E2E PUT Baseline" });
    const put = await api().put("/extranet/property").set(auth).send(payload);
    expect(put.status).toBe(200);
    expect(put.body.name).toBe("E2E PUT Baseline");

    const get = await api().get("/extranet/property").set(auth);
    expect(get.body.name).toBe("E2E PUT Baseline");
    expect(get.body.addressLine).toBe("1 Test Way");
  });

  test("PATCH merge -> 200 and does not wipe other fields", async () => {
    await api().put("/extranet/property").set(auth).send(fullPayload({ name: "E2E PATCH Baseline" }));

    const patch = await api()
      .patch("/extranet/property")
      .set(auth)
      .send({ contactEmail: "ops+patch@test.example" });

    expect(patch.status).toBe(200);
    expect(patch.body.contactEmail).toBe("ops+patch@test.example");

    const get = await api().get("/extranet/property").set(auth);
    expect(get.body.name).toBe("E2E PATCH Baseline");
    expect(get.body.addressLine).toBe("1 Test Way");
  });

  test("PUT partial body -> 400 (strict contract)", async () => {
    const r = await api().put("/extranet/property").set(auth).send({ name: "Should 400" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/PUT requires full object/);
  });

  test("Empty strings normalize to null", async () => {
    await api().put("/extranet/property").set(auth).send(fullPayload({ name: "Normalize Check" }));
    const patch = await api().patch("/extranet/property").set(auth).send({ phone: "", description: "" });
    expect(patch.status).toBe(200);
    expect(patch.body.phone).toBeNull();
    expect(patch.body.description).toBeNull();
  });
});
