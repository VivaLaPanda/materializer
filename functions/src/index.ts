/* eslint-disable max-len */
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {defineSecret, defineInt, defineString} from "firebase-functions/params";
import Stripe from "stripe";

const flatPrice = defineInt("FLAT_PRICE");

const flatShipping = defineString("FLAT_SHIPPING");
const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
const webhookSecret = defineSecret("STRIPE_WEBHOOK_KEY");
const gelatoSecret = defineSecret("GELATO_SECRET_KEY");

// comma seperated string representing the return address info
// e.g. "John Doe,123 Main St,Anytown,CA,12345,US,returns@company.co,555-555-5555"
const returnAddress = defineSecret("RETURN_ADDRESS");

// // Start writing functions
// // https://firebase.google.com/docs/functions/typescript

// Create a Firebase function to create a new Stripe product
//  when a new product is created in Firestore
// "products" is the name of the collection in Firestore
// and products have an image field and a title field
// pricing is fixed across all products, so we can hardcode it here
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

// Create a Firebase function to delete a Stripe product
//  when a product is deleted in Firestore
// TODO

// Create a Firebase function to create a gelato.com order
// via checkout.session.completed webhook
export const createGelatoOrder = functions
    .runWith({secrets: ["GELATO_SECRET_KEY", "STRIPE_WEBHOOK_KEY", "RETURN_ADDRESS"]})
    .https.onRequest(async (req, res) => {
      // https://console.cloud.google.com/security/secret-manager/secret/GELATO_API_KEY
      const gelatoApiKey = gelatoSecret.value();
      const stripe = new Stripe(stripeSecret.value(),
          {apiVersion: "2022-11-15"});

      // https://stripe.com/docs/api/checkout/sessions/object
      // Check to make sure it's a valid webhook
      const payload = req.body;
      const sig = req.headers["stripe-signature"] as string;
      let event;
      try {
        event = stripe.webhooks.constructEvent(payload, sig, webhookSecret.value());
      } catch (err) {
        res.status(400).send(`Webhook Error: ${(<Error>err).message}`);
        return;
      }
      if (event.type !== "checkout.session.completed") {
        res.status(400).send(`Webhook Error: ${event.type}`);
        return;
      }

      const session = event.data.object as Stripe.Checkout.Session;

      // Get the productId from the session metadata
      const productId = session?.metadata?.firebaseId;
      if (!productId) {
        res.status(400).send("Webhook Error: No productId");
        return;
      }

      // Note: Idomatically this would be done with line-items, but for now we only
      // ever check out one item at a time and with one fixed price so this is fine

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

      // Get the customer from Stripe
      const possibleCustomer = await stripe.customers.retrieve(session.customer as string);

      // Make sure the customer isn't deleted
      if (possibleCustomer.deleted) {
        res.status(400).send("Webhook Error: Customer not valid");
        return;
      }
      const customer = possibleCustomer as Stripe.Customer;
      // Make sure the customer has a phone number and shipping address
      if (!customer.phone || !customer.shipping || !customer.shipping.address) {
        res.status(400).send("Webhook Error: Customer not valid");
        return;
      }

      const returnAddressArray = returnAddress.value().split(",");

      const gelatoOrder = await fetch("https://order.gelatoapis.com/v4/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": gelatoApiKey,
        },
        body: JSON.stringify({
          "order": {
            "orderReferenceId": session.id,
            "customerReferenceId": session.customer,
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
              },
            ],
            "shippingAddress": {
              "name": customer.name,
              "addressLine1": customer.shipping.address.line1,
              "addressLine2": customer.shipping.address.line2,
              "city": customer.shipping.address.city,
              "state": customer.shipping.address.state,
              "postalCode": customer.shipping.address.postal_code,
              "country": customer.shipping.address.country,
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
          },
        }),
      });

      if (!gelatoOrder.ok) {
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
