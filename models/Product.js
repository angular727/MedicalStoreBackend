const mongoose = require("mongoose");

// Product categories for a medical store (the form the medicine takes)
const CATEGORIES = [
  "Tablet",
  "Capsule",
  "Syrup",
  "Suspension",
  "Injection",
  "Drops",
  "Inhaler",
  "Cream / Ointment",
  "Gel",
  "Sachet",
  "Powder",
  "Suppository",
  "Surgical / Disposable",
  "Cosmetic",
  "Other"
];

const productSchema = new mongoose.Schema({
  productCode: { type: String, default: "" }, // Short unique code (e.g. 3722) — shown to the user

  // ── Medicine identity ───────────────────────────────────────────────
  productName: { type: String, required: true },  // Brand name — e.g. "Panadol 500mg"
  genericName: { type: String, required: true },  // Salt / formula — e.g. "Paracetamol"
  brand:       { type: String, required: true },  // Company / Manufacturer — e.g. "GSK"
  category:    { type: String, enum: CATEGORIES, required: true },
  strength:    { type: String, default: "" },     // e.g. "500mg" / "120ml"
  model:       { type: String, default: "" },     // legacy field — the reports module reads this

  // ── How it is sold: single (by the piece) or pack (whole box) ───────
  type:         { type: String, enum: ["single", "pack"], required: true },
  unitLabel:    { type: String, default: "Piece" },  // name of one single unit — Tablet / Bottle / Vial
  packLabel:    { type: String, default: "Box" },    // name of the outer pack — Box / Pack / Strip
  unitsPerPack: { type: Number, default: 1, min: 1 },// how many single units are in one pack
  looseSale:    { type: Boolean, default: false },   // can the pack be opened and sold by the unit?
  looseSalePrice: { type: Number, default: null },   // rate for one loose unit (when looseSale is on)

  // ── Rates & stock (rates always apply to the sale unit) ─────────────
  unitPrice:    { type: Number, default: null }, // Purchase / cost price (used for COGS)
  salePrice:    { type: Number, default: null }, // Sale price
  initialStock: { type: Number, default: null }, // stock in hand when the product was created
  currentStock: { type: Number, default: 0 },    // purchase/sale keep this up to date
  // Of that stock, how much can actually go over the counter. Expired batches
  // still sit on the shelf until they go back to the distributor, but they can
  // never be sold — so the two numbers are not the same.
  sellableStock: { type: Number, default: 0 },
  minStock:     { type: Number, default: null },

  // ── Batch, expiry & storage ─────────────────────────────────────────
  batchNo:    { type: String, default: "" },
  expiryDate: { type: Date, default: null },
  shelfNo:    { type: String, default: "" },  // rack / shelf location
  barcode:    { type: String, default: "" },
  notes:      { type: String, default: "" },

  user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
});

// On create, seed currentStock from initialStock
// so every new product starts from the right baseline, then purchase/sale adjust it
// Note: currentStock defaults to 0 in the schema, so a "null" check was not enough —
// !this.currentStock is required, otherwise the opening stock never gets applied.
productSchema.pre("save", function (next) {
  if (this.isNew && !this.currentStock) {
    this.currentStock = this.initialStock || 0;
  }
  next();
});

module.exports = mongoose.models.Product || mongoose.model("Product", productSchema);
module.exports.CATEGORIES = CATEGORIES;
