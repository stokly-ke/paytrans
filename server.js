import express from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "node:crypto";
import dotenv from "dotenv";
import axios from "axios";
import admin from "firebase-admin";

dotenv.config();

const {
  PORT = 10000,
  APP_BASE_URL,
  PAYSTACK_SECRET_KEY,
  PAYSTACK_CALLBACK_URL,
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY
} = process.env;

if (!PAYSTACK_SECRET_KEY) {
  throw new Error("Missing PAYSTACK_SECRET_KEY");
}

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error("Missing Firebase Admin environment variables");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    })
  });
}

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const app = express();

app.use(helmet());
app.use(cors());

/**
 * IMPORTANT:
 * Webhook route must use raw body so signature verification works.
 */
app.post(
  "/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];
      const expected = crypto
        .createHmac("sha512", PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      if (signature !== expected) {
        return res.status(401).json({ success: false, message: "Invalid signature" });
      }

      const event = JSON.parse(req.body.toString("utf8"));

      if (event.event === "charge.success") {
        const reference = event.data?.reference;
        if (reference) {
          const verified = await verifyPaystackReference(reference);

          if (verified.ok) {
            await activatePlanForBusiness({
              businessId: verified.businessId,
              email: verified.email,
              planId: verified.planId,
              reference: verified.reference,
              paystackStatus: verified.status,
              paymentChannel: verified.channel,
              amountPaidKsh: verified.amountPaidKsh
            });
          }
        }
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("Webhook error:", error);
      return res.status(500).json({ success: false, message: "Webhook processing failed" });
    }
  }
);

app.use(express.json());

const PLANS = {
  FREE_TRIAL: {
    id: "FREE_TRIAL",
    name: "Free Trial",
    priceKsh: 0,
    durationDays: 7,
    maxUsers: 1,
    features: {
      allowImages: false,
      allowMultiCurrency: false,
      allowAdvancedInsights: false,
      allowExports: false
    }
  },
  STARTER_300: {
    id: "STARTER_300",
    name: "Starter",
    priceKsh: 300,
    durationDays: 30,
    maxUsers: 2,
    features: {
      allowImages: false,
      allowMultiCurrency: false,
      allowAdvancedInsights: true,
      allowExports: false
    }
  },
  GROWTH_700: {
    id: "GROWTH_700",
    name: "Growth",
    priceKsh: 700,
    durationDays: 30,
    maxUsers: 5,
    features: {
      allowImages: true,
      allowMultiCurrency: false,
      allowAdvancedInsights: true,
      allowExports: true
    }
  },
  PRO_1500: {
    id: "PRO_1500",
    name: "Pro",
    priceKsh: 1500,
    durationDays: 30,
    maxUsers: 15,
    features: {
      allowImages: true,
      allowMultiCurrency: true,
      allowAdvancedInsights: true,
      allowExports: true
    }
  }
};

function getPlan(planId) {
  const plan = PLANS[planId];
  if (!plan) {
    throw new Error("Invalid plan selected");
  }
  return plan;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function makeReference(planId, businessId) {
  return `stk_${planId}_${businessId}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, "");
}

function safeCallbackUrl() {
  if (PAYSTACK_CALLBACK_URL) return PAYSTACK_CALLBACK_URL;
  if (!APP_BASE_URL) {
    throw new Error("Missing APP_BASE_URL or PAYSTACK_CALLBACK_URL");
  }
  return `${APP_BASE_URL}/paystack/callback`;
}

async function verifyPaystackReference(reference) {
  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
      }
    }
  );

  const payload = response.data;
  const tx = payload?.data;

  if (!payload?.status || !tx) {
    throw new Error("Could not verify Paystack transaction");
  }

  const metadata = tx.metadata || {};
  const amount = Number(tx.amount || 0);
  const businessId = metadata.businessId;
  const planId = metadata.planId;
  const email = tx.customer?.email || metadata.email || "";
  const status = tx.status || "";
  const channel = tx.channel || "unknown";

  if (!businessId || !planId) {
    throw new Error("Missing businessId or planId in Paystack metadata");
  }

  return {
    ok: status === "success",
    status,
    businessId,
    planId,
    email,
    channel,
    reference: tx.reference,
    amountPaidKsh: amount / 100
  };
}

async function activatePlanForBusiness({
  businessId,
  email,
  planId,
  reference,
  paystackStatus,
  paymentChannel,
  amountPaidKsh
}) {
  const plan = getPlan(planId);
  const now = new Date();
  const expiresAt = addDays(now, plan.durationDays);
  const businessRef = db.collection("businesses").doc(businessId);

  const businessSnap = await businessRef.get();
  if (!businessSnap.exists) {
    throw new Error("Business document not found");
  }

  const existingRef = businessSnap.get("subscriptionPaymentReference");
  if (existingRef && existingRef === reference) {
    return;
  }

  const businessUpdate = {
    subscriptionPlanId: plan.id,
    subscriptionPlanName: plan.name,
    subscriptionStatus: "active",
    subscriptionStartedAt: Timestamp.fromDate(now),
    subscriptionExpiresAt: Timestamp.fromDate(expiresAt),
    subscriptionPaymentReference: reference || "",
    subscriptionPriceKsh: plan.priceKsh,
    subscriptionLastPaymentChannel: paymentChannel || "",
    subscriptionLastPaymentStatus: paystackStatus || "trial",
    maxUsers: plan.maxUsers,
    planFeatures: {
      allowImages: plan.features.allowImages,
      allowMultiCurrency: plan.features.allowMultiCurrency,
      allowAdvancedInsights: plan.features.allowAdvancedInsights,
      allowExports: plan.features.allowExports
    },
    updatedAt: FieldValue.serverTimestamp()
  };

  if (email) {
    businessUpdate.ownerEmail = email;
  }

  if (plan.id === "FREE_TRIAL") {
    businessUpdate.trialUsed = true;
  }

  await businessRef.set(businessUpdate, { merge: true });

  const historyId = reference || `trial_${Date.now()}`;

  await businessRef
    .collection("subscription_history")
    .doc(historyId)
    .set({
      planId: plan.id,
      planName: plan.name,
      priceKsh: plan.priceKsh,
      amountPaidKsh: amountPaidKsh ?? plan.priceKsh,
      status: "active",
      paymentReference: reference || "",
      paymentChannel: paymentChannel || "trial",
      startedAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromDate(expiresAt),
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });
}

app.get("/", (_req, res) => {
  res.status(200).json({
    app: "Stokly Payments Backend",
    status: "ok"
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Backend is healthy"
  });
});

app.get("/subscription/plans", (_req, res) => {
  const plans = Object.values(PLANS).map((plan) => ({
    id: plan.id,
    name: plan.name,
    priceKsh: plan.priceKsh,
    durationDays: plan.durationDays,
    maxUsers: plan.maxUsers,
    features: plan.features
  }));

  res.status(200).json({ success: true, plans });
});

app.post("/subscription/free-trial", async (req, res) => {
  try {
    const { businessId, email } = req.body;

    if (!businessId) {
      return res.status(400).json({ success: false, message: "businessId is required" });
    }

    const businessRef = db.collection("businesses").doc(businessId);
    const snap = await businessRef.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, message: "Business not found" });
    }

    const trialUsed = snap.get("trialUsed") === true;
    if (trialUsed) {
      return res.status(400).json({
        success: false,
        message: "Free trial has already been used for this business"
      });
    }

    await activatePlanForBusiness({
      businessId,
      email,
      planId: "FREE_TRIAL",
      reference: `trial_${businessId}_${Date.now()}`,
      paystackStatus: "trial",
      paymentChannel: "trial",
      amountPaidKsh: 0
    });

    return res.status(200).json({
      success: true,
      message: "Free trial activated successfully"
    });
  } catch (error) {
    console.error("Free trial error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Could not activate free trial"
    });
  }
});

app.post("/subscription/initialize", async (req, res) => {
  try {
    const { businessId, email, planId } = req.body;

    if (!businessId || !email || !planId) {
      return res.status(400).json({
        success: false,
        message: "businessId, email, and planId are required"
      });
    }

    const plan = getPlan(planId);

    if (plan.priceKsh <= 0) {
      return res.status(400).json({
        success: false,
        message: "Use the free-trial endpoint for free plans"
      });
    }

    const reference = makeReference(plan.id, businessId);

    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: String(plan.priceKsh * 100),
        currency: "KES",
        reference,
        callback_url: safeCallbackUrl(),
        metadata: {
          businessId,
          planId: plan.id,
          planName: plan.name,
          email,
          source: "stokly-android"
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const data = paystackResponse.data?.data;

    return res.status(200).json({
      success: true,
      message: "Payment initialized",
      authorizationUrl: data?.authorization_url,
      accessCode: data?.access_code,
      reference,
      plan: {
        id: plan.id,
        name: plan.name,
        priceKsh: plan.priceKsh
      }
    });
  } catch (error) {
    console.error("Initialize payment error:", error?.response?.data || error);
    return res.status(500).json({
      success: false,
      message:
        error?.response?.data?.message ||
        error.message ||
        "Could not initialize payment"
    });
  }
});

app.get("/subscription/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const verified = await verifyPaystackReference(reference);

    if (!verified.ok) {
      return res.status(400).json({
        success: false,
        message: `Payment not successful. Status: ${verified.status}`
      });
    }

    await activatePlanForBusiness({
      businessId: verified.businessId,
      email: verified.email,
      planId: verified.planId,
      reference: verified.reference,
      paystackStatus: verified.status,
      paymentChannel: verified.channel,
      amountPaidKsh: verified.amountPaidKsh
    });

    return res.status(200).json({
      success: true,
      message: "Payment verified and subscription activated",
      businessId: verified.businessId,
      planId: verified.planId,
      reference: verified.reference
    });
  } catch (error) {
    console.error("Verify payment error:", error?.response?.data || error);
    return res.status(500).json({
      success: false,
      message:
        error?.response?.data?.message ||
        error.message ||
        "Could not verify payment"
    });
  }
});

app.get("/subscription/status/:businessId", async (req, res) => {
  try {
    const { businessId } = req.params;
    const snap = await db.collection("businesses").doc(businessId).get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, message: "Business not found" });
    }

    return res.status(200).json({
      success: true,
      data: {
        subscriptionPlanId: snap.get("subscriptionPlanId") || "",
        subscriptionPlanName: snap.get("subscriptionPlanName") || "",
        subscriptionStatus: snap.get("subscriptionStatus") || "inactive",
        subscriptionExpiresAt:
          snap.get("subscriptionExpiresAt")?.toDate?.()?.toISOString?.() || null,
        maxUsers: snap.get("maxUsers") || 1,
        planFeatures: snap.get("planFeatures") || {}
      }
    });
  } catch (error) {
    console.error("Status error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Could not load subscription status"
    });
  }
});

app.get("/paystack/callback", async (req, res) => {
  try {
    const reference = req.query.reference;

    if (!reference) {
      return res.status(400).send(`
        <html><body style="font-family: sans-serif; padding: 24px;">
          <h2>Missing payment reference</h2>
          <p>Please return to the app and try again.</p>
        </body></html>
      `);
    }

    const verified = await verifyPaystackReference(reference);

    if (!verified.ok) {
      return res.status(400).send(`
        <html><body style="font-family: sans-serif; padding: 24px;">
          <h2>Payment not successful</h2>
          <p>Status: ${verified.status}</p>
          <p>You can return to the app now.</p>
        </body></html>
      `);
    }

    await activatePlanForBusiness({
      businessId: verified.businessId,
      email: verified.email,
      planId: verified.planId,
      reference: verified.reference,
      paystackStatus: verified.status,
      paymentChannel: verified.channel,
      amountPaidKsh: verified.amountPaidKsh
    });

    return res.status(200).send(`
      <html>
        <body style="font-family: sans-serif; padding: 24px;">
          <h2>Payment successful</h2>
          <p>Your Stokly subscription has been activated.</p>
          <p>You can now return to the app.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Callback error:", error);
    return res.status(500).send(`
      <html>
        <body style="font-family: sans-serif; padding: 24px;">
          <h2>Verification failed</h2>
          <p>Please return to the app and try again.</p>
        </body>
      </html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`Stokly payments backend running on port ${PORT}`);
});
