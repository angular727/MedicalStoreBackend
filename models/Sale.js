const mongoose = require("mongoose");

const saleItemSchema = new mongoose.Schema({
  product:     { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, default: "" },  // snapshot, so an old bill still reads correctly

  // Batch details as they were at the time of sale. batchNumber/expiryDate
  // name the batch the goods mainly came from; batchesUsed is the exact
  // breakdown, so an edit, return or void can put the stock back where it
  // came from rather than guessing.
  batchNumber: { type: String, default: "" },
  expiryDate:  { type: Date, default: null },
  batchesUsed: [{
    batch:      { type: mongoose.Schema.Types.ObjectId, ref: "StockBatch" },
    batchNo:    { type: String, default: "" },
    expiryDate: { type: Date, default: null },
    quantity:   { type: Number, default: 0 },
    _id: false
  }],

  // How it was sold: a whole pack, or loose pieces out of an opened pack
  saleUnit: { type: String, enum: ["pack", "loose"], default: "pack" },
  unitName: { type: String, default: "" },     // Box / Tablet / Bottle — what one unit is called

  quantity:  { type: Number, required: true, min: 1 },
  salePrice: { type: Number, required: true },  // rate per sale unit, before discount

  discountPercent: { type: Number, default: 0 },
  discount:        { type: Number, default: 0 },  // discount amount on this line
  netRate:         { type: Number, default: 0 },  // rate after the line discount

  purchasePriceAtTime: { type: Number, required: true }, // cost snapshot, for profit
  lineTotal: { type: Number, required: true }
});

const saleSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" }, // empty for a walk-in
  customerName: { type: String },
  invoiceNumber: { type: String, required: true },
  date: { type: Date, default: Date.now },

  // Prescription details — a medical store keeps these for prescription-only medicines
  doctorName:  { type: String, default: "" },
  prescriptionNo: { type: String, default: "" },

  items: [saleItemSchema],
  subTotal: { type: Number, required: true },
  itemDiscount: { type: Number, default: 0 },   // sum of the per-line discounts
  discount: { type: Number, default: 0 },       // extra discount on the whole bill
  deliveryCharges: { type: Number, default: 0 },
  grandTotal: { type: Number, required: true },
  amountReceived: { type: Number, default: 0 },
  paymentMethod: { type: String, default: "Cash" },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

module.exports = mongoose.models.Sale || mongoose.model("Sale", saleSchema);
