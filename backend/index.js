const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();
app.use(cors());

// ----------------------------
// Env
// ----------------------------
const PORT = process.env.PORT || 10000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL;
const PAYSTACK_CALLBACK_URL =
  process.env.PAYSTACK_CALLBACK_URL || `${APP_BASE_URL}/paystack/callback`;

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

if (!PAYSTACK_SECRET_KEY) throw new Error("Missing PAYSTACK_SECRET_KEY");
if (!APP_BASE_URL) throw new Error("Missing APP_BASE_URL");
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error("Missing Firebase admin environment variables");
}

// ----------------------------
// Firebase Admin
// ----------------------------
const serviceAccount = {
  projectId: FIREBASE_PROJECT_ID,
  clientEmail: FIREBASE_CLIENT_EMAIL,
  privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ----------------------------
// Plans
// ----------------------------
const PLAN_CATALOG = {
  FREE_TRIAL: {
    code: "FREE_TRIAL",
    name: "Free Trial",
    amountKsh: 0,
    cycle: "trial",
    durationDays: 7,
    features: {
      maxUsers: 1,
      canUploadImages: false,
      canUseMultiCurrency: false,
      canExportReports: false
    }
  },
  STARTER_300: {
    code: "STARTER_300",
    name: "Starter",
    amountKsh: 300,
    cycle: "monthly",
    durationMonths: 1,
    features: {
      maxUsers: 2,
      canUploadImages: false,
      canUseMultiCurrency: false,
      canExportReports: false
    }
  },
  GROWTH_700: {
    code: "GROWTH_700",
    name: "Growth",
    amountKsh: 700,
    cycle: "monthly",
    durationMonths: 1,
    features: {
      maxUsers: 5,
      canUploadImages: true,
      canUseMultiCurrency: false,
      canExportReports: true
    }
  },
  PRO_1500: {
    code: "PRO_1500",
    name: "Pro",
    amountKsh: 1500,
    cycle: "monthly",
    durationMonths: 1,
    features: {
      maxUsers: 15,
      canUploadImages: true,
      canUseMultiCurrency: true,
      canExportReports: true
    }
  }
};

function addMonths(date, count) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + count);
  return d;
}

function computeExpiry(plan) {
  const now = new Date();
  if (plan.cycle === "trial") {
    return new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
  }
  return addMonths(now, plan.durationMonths || 1);
}

function paystackAmount(plan) {
  return plan.amountKsh * 100;
}

async function verifyPaystackTransaction(reference) {
  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
      }
    }
  );
  return response.data?.data;
}

async function writeActiveSubscription({
  businessId,
  plan,
  reference,
  email,
  amountPaidSubunit,
  source
}) {
  const now = Date.now();
  const expiresAt = computeExpiry(plan).getTime();

  const businessRef = db.collection("businesses").doc(businessId);
  const paymentRef = businessRef
    .collection("payments")
    .document(reference || `trial_${now}`);

  await businessRef.set(
    {
      subscription: {
        planCode: plan.code,
        planName: plan.name,
        status: "active",
        billingCycle: plan.cycle,
        amountPaid: amountPaidSubunit / 100,
        currency: "KES",
        startedAt: now,
        expiresAt,
        paystackReference: reference || "",
        source,
        features: plan.features,
        updatedAt: now
      }
    },
    { merge: true }
  );

  await paymentRef.set(
    {
      reference: reference || "",
      planCode: plan.code,
      planName: plan.name,
      email: email || "",
      amountPaidSubunit,
      currency: "KES",
      source,
      status: "success",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function writePendingSubscription({ businessId, plan, reference, email }) {
  const businessRef = db.collection("businesses").doc(businessId);

  await businessRef.set(
    {
      subscription: {
        planCode: plan.code,
        planName: plan.name,
        status: "pending",
        billingCycle: plan.cycle,
        amountPaid: plan.amountKsh,
        currency: "KES",
        startedAt: null,
        expiresAt: null,
        paystackReference: reference,
        source: "paystack",
        features: plan.features,
        updatedAt: Date.now()
      }
    },
    { merge: true }
  );

  await businessRef.collection("payments").doc(reference).set(
    {
      reference,
      email,
      planCode: plan.code,
      planName: plan.name,
      amountPaidSubunit: paystackAmount(plan),
      currency: "KES",
      source: "paystack",
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function activateFromReference(reference) {
  const verified = await verifyPaystackTransaction(reference);

  if (!verified || verified.status !== "success") {
    throw new Error("Transaction not successful.");
  }

  const metadata = verified.metadata || {};
  const businessId = metadata.businessId;
  const planCode = metadata.planCode;
  const email = verified.customer?.email || metadata.email || "";

  if (!businessId || !planCode || !PLAN_CATALOG[planCode]) {
    throw new Error("Missing businessId or planCode in metadata.");
  }

  const plan = PLAN_CATALOG[planCode];
  const expectedAmount = paystackAmount(plan);

  if (Number(verified.amount) !== expectedAmount) {
    throw new Error("Verified amount does not match expected plan amount.");
  }

  await writeActiveSubscription({
    businessId,
    plan,
    reference,
    email,
    amountPaidSubunit: Number(verified.amount),
    source: "paystack"
  });

  return { businessId, planCode, reference };
}

// ----------------------------
// Webhook raw body
// ----------------------------
app.post("/paystack/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const expected = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (signature !== expected) {
      return res.status(401).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString("utf8"));

    if (event.event === "charge.success") {
      const reference = event.data?.reference;
      if (reference) {
        await activateFromReference(reference);
      }
    }

    return res.status(200).send("ok");
  } catch (error) {
    console.error("Webhook error:", error.message);
    return res.status(500).send("webhook error");
  }
});

app.use(express.json());

// ----------------------------
// Routes
// ----------------------------
app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "stokly-paytrans",
    routes: [
      "GET /health",
      "POST /subscriptions/trial",
      "POST /subscriptions/initialize",
      "GET /subscriptions/status/:businessId",
      "GET /paystack/callback",
      "POST /paystack/webhook"
    ]
  });
});

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "stokly-paytrans" });
});

app.post("/subscriptions/trial", async (req, res) => {
  try {
    const { businessId, email } = req.body;

    if (!businessId) {
      return res.status(400).json({ message: "businessId is required" });
    }

    const plan = PLAN_CATALOG.FREE_TRIAL;

    await writeActiveSubscription({
      businessId,
      plan,
      reference: "",
      email: email || "",
      amountPaidSubunit: 0,
      source: "trial"
    });

    return res.json({
      success: true,
      planCode: plan.code,
      nextRoute: "SWITCH_USER"
    });
  } catch (error) {
    console.error("Trial error:", error.message);
    return res.status(500).json({ message: error.message });
  }
});

app.post("/subscriptions/initialize", async (req, res) => {
  try {
    const { businessId, email, planCode } = req.body;

    if (!businessId || !email || !planCode) {
      return res.status(400).json({
        message: "businessId, email and planCode are required"
      });
    }

    const plan = PLAN_CATALOG[planCode];
    if (!plan || plan.amountKsh <= 0) {
      return res.status(400).json({ message: "Invalid paid plan" });
    }

    const reference = `stk_${businessId}_${Date.now()}`;

    const payload = {
      email,
      amount: paystackAmount(plan),
      currency: "KES",
      reference,
      callback_url: PAYSTACK_CALLBACK_URL,
      metadata: {
        businessId,
        planCode,
        email
      }
    };

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      payload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const authorizationUrl = response.data?.data?.authorization_url;
    const accessCode = response.data?.data?.access_code;

    await writePendingSubscription({
      businessId,
      plan,
      reference,
      email
    });

    return res.json({
      success: true,
      reference,
      accessCode,
      authorizationUrl
    });
  } catch (error) {
    console.error("Initialize error:", error.response?.data || error.message);
    return res.status(500).json({
      message: error.response?.data?.message || error.message
    });
  }
});

app.get("/paystack/callback", async (req, res) => {
  const reference = req.query.reference || "";
  const trxref = req.query.trxref || "";

  res.send(`
    <html>
      <head><title>Stokly Payment</title></head>
      <body style="font-family: Arial; padding: 24px;">
        <h2>Payment received</h2>
        <p>You can now return to the Stokly app.</p>
        <p>Reference: ${reference || trxref}</p>
      </body>
    </html>
  `);
});

app.get("/subscriptions/status/:businessId", async (req, res) => {
  try {
    const { businessId } = req.params;
    const doc = await db.collection("businesses").doc(businessId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: "Business not found" });
    }

    const data = doc.data() || {};
    const subscription = data.subscription || null;
    const now = Date.now();

    let normalized = subscription;
    if (subscription && subscription.expiresAt && subscription.expiresAt < now) {
      normalized = {
        ...subscription,
        status: "expired"
      };
    }

    return res.json({
      success: true,
      subscription: normalized
    });
  } catch (error) {
    console.error("Status error:", error.message);
    return res.status(500).json({ message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`paytrans running on port ${PORT}`);
});
