/* eslint-disable max-len */
import * as functions from "firebase-functions";
import {defineSecret, defineInt, defineString} from "firebase-functions/params";
import Stripe from "stripe";

const flatPrice = defineInt("FLAT_PRICE");
const flatShipping = defineString("FLAT_SHIPPING");
const stripeSecret = defineSecret("STRIPE_SECRET_KEY");

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

      // create a new stripe product, if it fails, delete the product
      const stripeProduct = await stripe.products.create({
        name: product.title,
        images: [product.image],
        type: "good",
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
    }
    );

// Create a Firebase function to delete a Stripe product
//  when a product is deleted in Firestore
// TODO

// Create a Firebase function to create a gelato.com order
// via checkout.session.completed webhook
// export const createGelatoOrder = functions
//     .runWith({secrets: ["GELATO_API_KEY"]})
//     .https.onRequest(async (req, res) => {
//       // https://console.cloud.google.com/security/secret-manager/secret/GELATO_API_KEY
//       const gelatoSecret = defineSecret("GELATO_API_KEY");
//       const gelatoApiKey = gelatoSecret.value();

//       // https://stripe.com/docs/api/checkout/sessions/object
//       const session = req.body.data.object;
//       const gelatoOrder = await fetch("https://order.gelatoapis.com/v4/orders", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           "x-api-key": gelatoApiKey,
//         },
//         body: JSON.stringify({
//           "order": {
//             "orderType": "order",
//             "orderReferenceId": session.id,
//             "customerReferenceId": session.customer,
//             "currency": "USD",
//             "items": [
//               {
//                 "itemReferenceId": session.id,
//                 "productUid": "apparel_product_gca_t-shirt_gsc_crewneck_gcu_unisex_gqa_classic_gsi_s_gco_white_gpr_4-4",
//                 "files": [
//                   {
//                     "type": "default",
//                     "url": "https://s3-eu-west-1.amazonaws.com/developers.gelato.com/product-examples/test_print_job_BX_4-4_hor_none.pdf",
//                   },
//                 ],
//               },
//             ],
//             "shippingAddress": {
//             },
//             "returnAddress": {

//             },
//           },
//         }),
//       });
//     });
