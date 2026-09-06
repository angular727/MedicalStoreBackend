const mongoose = require("mongoose");

const supplierSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Supplier name is required"],
    trim: true
  },
  companyName: {
    type: String,
    required: [true, "Company name is required"],
    trim: true
  },
  phone: {
    type: String,
    required: [true, "Phone number is required"],
    trim: true
  },
  // Second number — usually the order-booker's mobile or a WhatsApp number
  altPhone: {
    type: String,
    trim: true
  },
  address: {
    type: String,
    trim: true
  },
  city: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, "Please enter a valid email address"]
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active"
  },

  // ── Who you are buying from ───────────────────────────────────────
  supplierType: {
    type: String,
    enum: ["Distributor", "Manufacturer", "Wholesaler", "Sub-Distributor", "Other"],
    default: "Distributor"
  },

  // ── Licence & tax details a medical store has to keep on record ───
  drugLicenseNo: { type: String, trim: true },  // Drug Sale Licence number
  ntn:           { type: String, trim: true },  // National Tax Number
  strn:          { type: String, trim: true },  // Sales Tax Registration Number

  // Agreed credit period in days (0 = cash only)
  creditDays: { type: Number, default: 0, min: 0 },

  notes: { type: String, trim: true },


  // Ledger accounting fields
  openingBalance: {
    type: Number,
    default: 0
  },
  totalPurchase: {
    type: Number,
    default: 0
  },
  totalPaid: {
    type: Number,
    default: 0
  },
  
  // Backward and frontend compatibility fields
  totalAmount: {
    type: Number,
    default: 0
  },
  paidAmount: {
    type: Number,
    default: 0
  },
  
  // Net balance due to this supplier (openingBalance + totalPurchase - totalPaid)
  balance: {
    type: Number,
    default: 0
  },
  
  // Multi-user tenant control
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: [true, "User reference is required"]
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Pre-save hook to automatically synchronize compatibility fields and compute net balance
supplierSchema.pre("save", function (next) {
  // Sync totalPurchase with legacy totalAmount
  if (this.isModified("totalPurchase")) {
    this.totalAmount = this.totalPurchase;
  } else if (this.isModified("totalAmount")) {
    this.totalPurchase = this.totalAmount;
  }

  // Sync totalPaid with legacy paidAmount
  if (this.isModified("totalPaid")) {
    this.paidAmount = this.totalPaid;
  } else if (this.isModified("paidAmount")) {
    this.totalPaid = this.paidAmount;
  }

  // Calculate dynamic running net balance (Opening Balance + Total Purchase - Total Paid)
  this.balance = this.openingBalance + this.totalPurchase - this.totalPaid;
  next();
});

// Indexing for high-performance searching (Text Search and Multi-Tenant filtering)
supplierSchema.index({ name: "text", companyName: "text", phone: "text" });
supplierSchema.index({ user: 1, status: 1 });

// module.exports = mongoose.model("Supplier", supplierSchema);
module.exports = mongoose.models.Supplier || mongoose.model("Supplier", supplierSchema);