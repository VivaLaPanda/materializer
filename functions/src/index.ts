/* eslint-disable max-len */
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {defineSecret, defineInt, defineString} from "firebase-functions/params";
import Stripe from "stripe";
import fetch from "node-fetch";

const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
const gelatoSecret = defineSecret("GELATO_SECRET_KEY");
const replicateSecret = defineSecret("REPLICATE_SECRET_KEY");

const webhookSecret = defineSecret("STRIPE_WEBHOOK_KEY");

const flatPrice = defineInt("FLAT_PRICE");
const flatShipping = defineString("FLAT_SHIPPING");

// comma seperated string representing the return address info
// e.g. "John Doe,123 Main St,Anytown,CA,12345,US,returns@company.co,555-555-5555"
const returnAddress = defineSecret("RETURN_ADDRESS");

// // Start writing functions
// // https://firebase.google.com/docs/functions/typescript

// Create a Firebase function to create a new Stripe product
//  when a new product is created in Firestore
export const createStripeProduct = functions
    .runWith({secrets: ["STRIPE_SECRET_KEY"]}).firestore
    .document("products/{productId}")
    .onCreate(async (snap, context) => {
      // https://console.cloud.google.com/security/secret-manager/secret/STRIPE_SECRET_KEY
      const stripe = new Stripe(stripeSecret.value(),
          {apiVersion: "2022-11-15"});
      const product = snap.data();

      // create a new stripe product
      try {
        const stripeProduct = await stripe.products.create({
          name: product.title,
          images: [product.image],
          type: "good",
          metadata: {
            firebaseId: context.params.productId,
          },
        });

        // create a new stripe price and get the id from the response
        const stripePrice = await stripe.prices.create({
          product: stripeProduct.id,
          unit_amount: flatPrice.value(),
          currency: "usd",
          tax_behavior: "exclusive",
        });

        // Create a Payment Link
        const paymentLink = await stripe.paymentLinks.create({
          line_items: [
            {
              price: stripePrice.id,
              quantity: 1,
            },
          ],
          automatic_tax: {
            enabled: true,
          },
          phone_number_collection: {
            enabled: true,
          },
          shipping_address_collection: {
            allowed_countries: ["US"],
          },
          shipping_options: [
            {
              shipping_rate: flatShipping.value(),
            },
          ],
        });

        // update the product in Firestore with the product id and payment link
        await snap.ref.update({
          stripeProductId: stripeProduct.id,
          stripePriceId: stripePrice.id,
          paymentLink: paymentLink.url,
        });
      } catch (error) {
        // If anything failed, delete the product from Firestore
        await snap.ref.delete();
        throw error;
      }
    }
    );

// Firebase function to use https://replicate.com/nightmareai/real-esrgan to
// upscale images when a new product is created in Firestore
export const upscaleImage = functions
    .runWith({secrets: ["REPLICATE_SECRET_KEY"], timeoutSeconds: 120}).firestore
    .document("products/{productId}")
    .onCreate(async (snap, context) => {
      const product = snap.data();
      const imageUrl = product.image;

      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        databaseURL: "https://materializer-io.firebaseio.com",
      });

      // Hit the raw Replicate endpoint since the NodeJS library is broken
      const upscaleResp = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Token ${replicateSecret.value()}`,
        },
        body: JSON.stringify({
          version: "42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b",
          input: {
            image: imageUrl,
          },
        }),
      });

      // Poll the prediction until it's done by looping until output is not null
      // predictions are fetched with GET https://api.replicate.com/v1/predictions/{prediction_id}
      // TODO: Rewrite this as a webhook
      let prediction = await upscaleResp.json() as any;
      while (prediction.output == null && (prediction.status != "failed" || prediction.status != "canceled")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const predictionResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
          headers: {
            "Authorization": `Token ${replicateSecret.value()}`,
          },
        });
        prediction = await predictionResp.json();
      }

      // Copy the output image from the upscaledUrl to a new file in
      // Firebase Storage

      // Get the blob from the image at the upscaledUrl
      const response = await fetch(prediction.output);
      const blob = await response.blob();

      // Upload the blob to Firebase Storage
      const storageRef = admin.storage().bucket();
      const file = storageRef.file(`upscaled/${context.params.productId}.png`);
      await file.save(await blob.text());

      // Get the public URL for the upscaled image
      const publicUrl = await file.getSignedUrl({
        action: "read",
        expires: "03-09-2491",
      });

      // Update the product in Firestore with the upscaled image URL
      await snap.ref.update({
        upscaledImage: publicUrl[0],
      });
    });


// Create a Firebase function to delete a Stripe product
//  when a product is deleted in Firestore
// TODO

// Create a Firebase function to create a gelato.com order
// via checkout.session.completed webhook
export const createGelatoOrder = functions
    .runWith({secrets: [
      "GELATO_SECRET_KEY",
      "STRIPE_WEBHOOK_KEY",
      "STRIPE_SECRET_KEY",
      "RETURN_ADDRESS",
    ]})
    .https.onRequest(async (req, res) => {
      // https://console.cloud.google.com/security/secret-manager/secret/GELATO_API_KEY
      const gelatoApiKey = gelatoSecret.value();
      const stripe = new Stripe(stripeSecret.value(),
          {apiVersion: "2022-11-15"});

      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        databaseURL: "https://materializer-io.firebaseio.com",
      });

      // https://stripe.com/docs/api/checkout/sessions/object
      // Check to make sure it's a valid webhook
      const sig = req.headers["stripe-signature"] as string;
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret.value());
      } catch (err) {
        res.status(400).send(`Webhook Error: ${(<Error>err).message}`);
        return;
      }
      if (event.type !== "checkout.session.completed") {
        res.status(400).send(`Webhook Error: ${event.type}`);
        return;
      }

      const session = event.data.object as Stripe.Checkout.Session;

      // Fetch the session with expand so we can get the product metadata
      const expandedSession = await stripe.checkout.sessions.retrieve(
          session.id,
          {expand: ["line_items.data.price.product"]},
      );

      // Get the productId from the session metadata
      const stripeProduct = expandedSession?.line_items?.data[0].price?.product as Stripe.Product;
      const productId = stripeProduct?.metadata?.firebaseId;
      if (!productId) {
        res.status(400).send("Webhook Error: No productId");
        return;
      }

      // Get the product from Firestore anonymously
      const product = await admin.firestore()
          .collection("products")
          .doc(productId)
          .get()
          .then((doc) => doc.data());

      if (!product) {
        res.status(400).send("Webhook Error: No product");
        return;
      }

      // Get the customer details from Stripe
      const customer = session.customer_details;
      if (!customer) {
        res.status(400).send("Webhook Error: No customer details");
        return;
      }
      if (!customer.address) {
        res.status(400).send("Webhook Error: No customer address");
        return;
      }

      const returnAddressArray = returnAddress.value().split(",");
      console.log(returnAddressArray);

      const gelatoOrder = await fetch("https://order.gelatoapis.com/v4/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": gelatoApiKey,
        },
        body: JSON.stringify({
          "orderReferenceId": session.id,
          "customerReferenceId": customer.email,
          "currency": "USD",
          "items": [
            {
              "itemReferenceId": session.id,
              "productUid": "framed_poster_mounted_130x180-mm-5x7-inch_black_wood_w12xt22-mm_plexiglass_130x180-mm-5r_170-gsm-65lb-uncoated_4-0_hor",
              "files": [
                {
                  "type": "default",
                  "url": product.image,
                },
              ],
              "quantity": 1,
            },
          ],
          "shippingAddress": {
            "name": customer.name,
            "addressLine1": customer.address.line1,
            "addressLine2": customer.address.line2,
            "city": customer.address.city,
            "state": customer.address.state,
            "postalCode": customer.address.postal_code,
            "country": customer.address.country,
            "phone": customer.phone,
            "email": customer.email,
          },
          "returnAddress": {
            "companyName": returnAddressArray[0],
            "addressLine1": returnAddressArray[1],
            "addressLine2": returnAddressArray[2],
            "city": returnAddressArray[3],
            "state": returnAddressArray[4],
            "postalCode": returnAddressArray[5],
            "country": returnAddressArray[6],
            "email": returnAddressArray[7],
          },
        }),
      });

      if (!gelatoOrder.ok) {
        console.log(await gelatoOrder.text());
        res.status(400).send("Webhook Error: Gelato Order Failed");
        return;
      }

      // Update the product in Firestore with a "last ordered" timestamp
      await admin.firestore()
          .collection("products")
          .doc(productId)
          .update({
            lastOrdered: admin.firestore.FieldValue.serverTimestamp(),
          });

      // Return a response to acknowledge receipt of the event
      res.status(200).send("Webhook Success");
      return;
    });
