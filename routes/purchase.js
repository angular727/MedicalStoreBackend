const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Purchase = require("../models/purchase");
const Product = require("../models/Product");
const Supplier = require("../models/supplier");
const SupplierLedger = require("../models/SupplierLedger");
const auth = require("../middleware/auth");
const { isPaged, getPageParams, pagedResponse } = require("../utils/paginate");
const batchStock = require("../utils/batchStock");

// ==========================================
// Helper: transaction with auto-retry on transient MongoDB
// write-conflicts (Atlas shared tier throws these intermittently)
// ==========================================
async function withTxnRetry(fn, maxRetries = 4) {
  let attempt = 0;
  while (true) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(session);
      await session.commitTransaction();
      session.endSession();
      return result;
    } catch (err) {
      try { await session.abortTransaction(); } catch (e) {}
      session.endSession();
      const labels = err.errorLabels || [];
      const transient = labels.includes("TransientTransactionError") ||
                        labels.includes("UnknownTransactionCommitResult");
      const writeConflict = err.code === 112 || /write conflict/i.test(err.message || "");
      if ((transient || writeConflict) && attempt < maxRetries) {
        attempt++;
        await new Promise(r => setTimeout(r, 60 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ==========================================
// HELPER: turn the submitted items into stored items + invoice totals
// (shared by the create and update routes)
//
// Medical store line maths:
//   gross    = quantity x purchase rate
//   discount = gross x trade discount %
//   net line = gross - discount   (bonus/free goods cost nothing)
// ==========================================
function buildItemsAndTotals(items, header) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one item is required");
  }

  let subtotal = 0;
  let totalTax = 0;
  const processedItems = [];

  for (const item of items) {
    if (!item.productId) throw new Error("Please select a medicine for each item");
    if (!item.quantity || item.quantity < 1) throw new Error("Quantity cannot be less than 1");
    if (!item.batchNumber) throw new Error("Batch number is required for every medicine");

    const qty = Number(item.quantity);
    const bonusQty = Number(item.bonusQty) || 0;
    const unitCost = Number(item.unitCost) || 0;
    const sellingPrice = Number(item.unitPriceText) || 0;
    const discountPct = Number(item.discountPercent) || 0;
    const taxPct = Number(item.taxPercentage) || 0;

    if (bonusQty < 0) throw new Error("Bonus quantity cannot be negative");
    if (discountPct < 0 || discountPct > 100) throw new Error("Discount % must be between 0 and 100");

    const gross = qty * unitCost;
    const discount = gross * (discountPct / 100);
    const netRate = unitCost - (unitCost * (discountPct / 100));

    const lineSub = gross - discount;
    const lineTax = lineSub * (taxPct / 100);
    const lineTotal = lineSub + lineTax;

    subtotal += lineSub;
    totalTax += lineTax;

    let expiryDate = null;
    if (item.expiryDate) {
      const exp = new Date(item.expiryDate);
      if (isNaN(exp.getTime())) throw new Error("Expiry date is not valid");
      expiryDate = exp;
    }

    processedItems.push({
      product: item.productId,
      productType: item.type === "pack" ? "pack" : "single",
      barcode: item.barcode,
      batchNumber: String(item.batchNumber),
      expiryDate: expiryDate,
      quantity: qty,
      bonusQty: bonusQty,
      purchasePrice: unitCost,
      discountPercent: discountPct,
      discount: discount,
      netRate: netRate,
      sellingPrice: sellingPrice,
      taxPercentage: taxPct,
      lineTotal: lineTotal
    });
  }

  const deliveryCharges = Number(header.deliveryCharges) || 0;
  const grandTotal = subtotal + totalTax + deliveryCharges;
  return { subtotal, totalTax, deliveryCharges, grandTotal, processedItems };
}

// Applies one purchase line: the goods land in their own batch, and the
// medicine's sale rate and barcode are refreshed. Bonus/free goods land in
// stock too even though they were not paid for.
// batchStock keeps Product.currentStock in step with the batch rows.
async function applyItemToProduct(productDoc, item, purchaseId, session) {
  if (item.sellingPrice && Number(item.sellingPrice) > 0) {
    productDoc.salePrice = item.sellingPrice;
  }
  if (item.barcode) productDoc.barcode = item.barcode;
  await productDoc.save({ session });

  await batchStock.addStock({
    productId: productDoc._id,
    userId: productDoc.user,
    batchNo: item.batchNumber,
    expiryDate: item.expiryDate,
    quantity: item.quantity + (item.bonusQty || 0),
    purchaseRate: item.netRate || item.purchasePrice,
    salePrice: item.sellingPrice,
    purchaseId
  }, session);
}

// Takes a purchase line's goods back out — used when a bill is edited or voided
async function reverseItemFromProduct(item, userId, session) {
  const stockedQty = item.quantity + (item.bonusQty || 0);
  const product = await Product.findOne({ _id: item.product, user: userId }).session(session);
  await batchStock.removeStock({
    productId: item.product,
    userId,
    quantity: stockedQty,
    batchNo: item.batchNumber,
    expiryDate: item.expiryDate,
    productName: product ? product.productName : ""
  }, session);
}

// ==========================================
// 1. CREATE PURCHASE (Purchase Order / Bill Entry)
// ==========================================

router.post("/", auth, async (req, res) => {
  try {
    const { header, items, amountPaid } = req.body;

    if (!header || !header.supplierId) throw new Error("Please select a supplier");
    if (!header.invoiceNumber) throw new Error("Invoice number is required");

    const newPurchaseId = await withTxnRetry(async (session) => {
      const supplierDoc = await Supplier.findOne({ _id: header.supplierId, user: req.user.id }).session(session);
      if (!supplierDoc) throw new Error("Supplier not found");

      // Prevent the same invoice number from being reused (per user)
      const dupe = await Purchase.findOne({ purchaseNumber: header.invoiceNumber, user: req.user.id }).session(session);
      if (dupe) throw new Error(`Invoice #${header.invoiceNumber} already exists`);

      // Totals are calculated here on the server — the frontend value is only a reference, not trusted
      const { subtotal, totalTax, deliveryCharges, grandTotal, processedItems } = buildItemsAndTotals(items, header);

      const paid = Number(amountPaid) || 0;
      if (paid > grandTotal) throw new Error("Amount Paid cannot exceed Grand Total");

      // Every medicine on the bill must exist before anything is written
      for (const item of processedItems) {
        const exists = await Product.findOne({ _id: item.product, user: req.user.id }).session(session);
        if (!exists) throw new Error(`Medicine not found (ID: ${item.product})`);
      }

      const newPurchase = new Purchase({
        supplier: header.supplierId,
        purchaseNumber: header.invoiceNumber,
        date: header.invoiceDate,
        items: processedItems,
        subTotal: subtotal,
        totalTax: totalTax,
        deliveryCharges: deliveryCharges,
        grandTotal: grandTotal,
        amountPaid: paid,
        user: req.user.id
      });

      await newPurchase.save({ session });

      // Goods in — each line lands in its own batch, tagged with this bill
      for (const item of processedItems) {
        const productDoc = await Product.findOne({ _id: item.product, user: req.user.id }).session(session);
        await applyItemToProduct(productDoc, item, newPurchase._id, session);
      }

      // --- Supplier & Ledger ---
      supplierDoc.totalPurchase += grandTotal;
      supplierDoc.totalPaid += paid;
      await supplierDoc.save({ session });

      const ledger = new SupplierLedger({
        supplier: header.supplierId,
        transactionType: "Purchase",
        description: `Invoice #${header.invoiceNumber}`,
        credit: grandTotal,
        debit: paid,
        runningBalance: supplierDoc.balance,
        referenceId: newPurchase._id,
        user: req.user.id
      });
      await ledger.save({ session });

      return newPurchase._id;
    });

    res.status(201).json({ msg: "Purchase saved with Batch & Barcode", id: newPurchaseId });

  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});


// ==========================================
// 2. FETCH PURCHASES (List & Detail)
// ==========================================

// @route   GET /api/purchase
// @desc    Saray purchase transactions dekhna (with populates)
router.get("/", auth, async (req, res) => {
  try {
    const userFilter = (req.query.admin === "true" && req.user.role === "admin") ? {} : { user: req.user.id };
    const { from, to, search } = req.query;
    if (from || to) {
      userFilter.date = {};
      if (from) userFilter.date.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        userFilter.date.$lte = toDate;
      }
    }

    if (search) {
      const rx = { $regex: search, $options: "i" };
      const supIds = await Supplier.find({ user: req.user.id, $or: [{ name: rx }, { companyName: rx }] }).distinct("_id");
      userFilter.$or = [
        { purchaseNumber: rx },
        { supplier: { $in: supIds } }
      ];
    }

    if (!isPaged(req)) {
      const purchases = await Purchase.find(userFilter)
        .populate("supplier", "name companyName phone")
        .populate("items.product", "productName genericName brand category strength type unitLabel packLabel unitsPerPack unitPrice salePrice barcode")
        .sort({ date: -1 });
      return res.json(purchases);
    }

    const { page, limit, skip } = getPageParams(req);
    const aggMatch = { ...userFilter, user: new mongoose.Types.ObjectId(req.user.id) };
    const [data, total, agg] = await Promise.all([
      Purchase.find(userFilter)
        .populate("supplier", "name companyName phone")
        .populate("items.product", "productName genericName brand category strength type unitLabel packLabel unitsPerPack unitPrice salePrice barcode")
        .sort({ date: -1 }).skip(skip).limit(limit),
      Purchase.countDocuments(userFilter),
      Purchase.aggregate([
        { $match: aggMatch },
        { $group: { _id: null, totalPurchases: { $sum: "$grandTotal" }, totalPaid: { $sum: "$amountPaid" } } }
      ])
    ]);

    const totalPurchases = agg[0]?.totalPurchases || 0;
    const totalPaid = agg[0]?.totalPaid || 0;
    res.json(pagedResponse(data, total, page, limit, {
      totalPurchases, totalPaid, totalDue: totalPurchases - totalPaid
    }));
  } catch (err) {
    console.error("Fetch purchases error:", err.message);
    res.status(500).json({ msg: "Server Error: Fetching purchases failed" });
  }
});

// @route   GET /api/purchase/supplier/:supplierId
// @desc    Ek supplier ki saari purchases (ledger / reports ke liye zaroori)
router.get("/supplier/:supplierId", auth, async (req, res) => {
  try {
    const purchases = await Purchase.find({ supplier: req.params.supplierId, user: req.user.id })
      .populate("items.product", "productName genericName brand category strength type unitLabel packLabel unitsPerPack unitPrice salePrice barcode")
      .sort({ date: -1 });
    res.json(purchases);
  } catch (err) {
    console.error("Fetch supplier purchases error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  }
});

// @route   GET /api/purchase/:id
// @desc    Single purchase detail
router.get("/:id", auth, async (req, res) => {
  try {
    const purchase = await Purchase.findOne({ _id: req.params.id, user: req.user.id })
      .populate("supplier", "name companyName phone address email")
      .populate("items.product", "productName genericName brand category strength type unitLabel packLabel unitsPerPack unitPrice salePrice barcode");

    if (!purchase) {
      return res.status(404).json({ msg: "Purchase invoice not found" });
    }
    res.json(purchase);
  } catch (err) {
    console.error("Fetch single purchase error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  }
});


// ==========================================
// 3. UPDATE PURCHASE (Edit Bill)
//    Logic: purana stock/supplier/ledger effect reverse karo,
//    phir naye data ke sath dobara apply karo — sab ek hi transaction mein
// ==========================================

// @route   PUT /api/purchase/:id
router.put("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { header, items, amountPaid } = req.body;

    if (!header || !header.supplierId) throw new Error("Please select a supplier");
    if (!header.invoiceNumber) throw new Error("Invoice number is required");

    const oldPurchase = await Purchase.findOne({ _id: req.params.id, user: req.user.id }).session(session);
    if (!oldPurchase) throw new Error("Purchase record not found");

    // A bill that already has returns against it cannot be edited — the returns
    // are separate documents with their own stock and ledger effects, and
    // reversing this bill would double-count them. Delete the returns first.
    const PurchaseReturn = require("../models/PurchaseReturn");
    const returnCount = await PurchaseReturn.countDocuments({
      originalPurchase: oldPurchase._id, user: req.user.id
    }).session(session);
    if (returnCount > 0) {
      throw new Error(`This bill has ${returnCount} return(s) against it. Delete the return(s) first, then edit the bill.`);
    }

    const oldSupplierDoc = await Supplier.findOne({ _id: oldPurchase.supplier, user: req.user.id }).session(session);
    if (!oldSupplierDoc) throw new Error("Previous supplier record not found");

    // Ensure the invoice number is not duplicated in any other record (excluding this one)
    const dupe = await Purchase.findOne({
      purchaseNumber: header.invoiceNumber,
      user: req.user.id,
      _id: { $ne: oldPurchase._id }
    }).session(session);
    if (dupe) throw new Error(`Invoice #${header.invoiceNumber} already exists`);

    // ---------- STEP 1: REVERSE THE OLD STOCK EFFECT ----------
    for (const oldItem of oldPurchase.items) {
      await reverseItemFromProduct(oldItem, req.user.id, session);
    }

    // ---------- STEP 2: PURANA SUPPLIER & LEDGER EFFECT REVERSE KARO ----------
    oldSupplierDoc.totalPurchase -= oldPurchase.grandTotal;
    oldSupplierDoc.totalPaid -= oldPurchase.amountPaid;
    await oldSupplierDoc.save({ session });
    await SupplierLedger.deleteMany({ referenceId: oldPurchase._id, user: req.user.id }).session(session);

    // ---------- STEP 3: NAYI SUPPLIER CONFIRM KARO (agar form mein supplier change hui ho) ----------
    const supplierChanged = header.supplierId.toString() !== oldPurchase.supplier.toString();
    const newSupplierDoc = supplierChanged
      ? await Supplier.findOne({ _id: header.supplierId, user: req.user.id }).session(session)
      : oldSupplierDoc;
    if (!newSupplierDoc) throw new Error("New supplier not found");

    // ---------- STEP 4: NAYE TOTALS CALCULATE KARO (server-side, trusted) ----------
    const { subtotal, totalTax, deliveryCharges, grandTotal, processedItems } = buildItemsAndTotals(items, header);

    const paid = Number(amountPaid) || 0;
    if (paid > grandTotal) throw new Error("Amount Paid cannot exceed Grand Total");

    // ---------- STEP 5: APPLY THE NEW STOCK EFFECT ----------
    for (const item of processedItems) {
      const productDoc = await Product.findOne({ _id: item.product, user: req.user.id }).session(session);
      if (!productDoc) throw new Error(`Medicine not found (ID: ${item.product})`);

      await applyItemToProduct(productDoc, item, oldPurchase._id, session);
    }

    // ---------- STEP 6: PURCHASE DOCUMENT UPDATE KARO ----------
    oldPurchase.supplier = header.supplierId;
    oldPurchase.purchaseNumber = header.invoiceNumber;
    oldPurchase.date = header.invoiceDate;
    oldPurchase.items = processedItems;
    oldPurchase.subTotal = subtotal;
    oldPurchase.totalTax = totalTax;
    oldPurchase.deliveryCharges = deliveryCharges;
    oldPurchase.grandTotal = grandTotal;
    oldPurchase.amountPaid = paid;
    await oldPurchase.save({ session });

    // ---------- STEP 7: NAYI SUPPLIER & LEDGER APPLY KARO ----------
    newSupplierDoc.totalPurchase += grandTotal;
    newSupplierDoc.totalPaid += paid;
    await newSupplierDoc.save({ session });

    const ledger = new SupplierLedger({
      supplier: header.supplierId,
      transactionType: "Purchase",
      description: `Invoice #${header.invoiceNumber} (Edited)`,
      credit: grandTotal,
      debit: paid,
      runningBalance: newSupplierDoc.balance,
      referenceId: oldPurchase._id,
      user: req.user.id
    });
    await ledger.save({ session });

    await session.commitTransaction();
    res.json({ msg: "Purchase updated successfully", id: oldPurchase._id });

  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ msg: err.message });
  } finally {
    session.endSession();
  }
});


// ==========================================
// 4. REVERSE/DELETE PURCHASE (Audit rollback)
// ==========================================

// @route   DELETE /api/purchase/:id
router.delete("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const purchase = await Purchase.findOne({ _id: req.params.id, user: req.user.id }).session(session);
    if (!purchase) {
      return res.status(404).json({ msg: "Purchase record not found" });
    }

    const supplierDoc = await Supplier.findOne({ _id: purchase.supplier, user: req.user.id }).session(session);
    if (!supplierDoc) {
      throw new Error("Supplier linked to this purchase was not found");
    }

    // A bill with returns against it cannot be voided — those returns already
    // took stock out and posted their own ledger entries, so voiding here would
    // remove the same stock twice. Delete the returns first.
    const PurchaseReturn = require("../models/PurchaseReturn");
    const returnCount = await PurchaseReturn.countDocuments({
      originalPurchase: purchase._id, user: req.user.id
    }).session(session);
    if (returnCount > 0) {
      throw new Error(`This bill has ${returnCount} return(s) against it. Delete the return(s) first, then void the bill.`);
    }

    // 1. Stock rollback — throws if the goods have since been sold
    for (const item of purchase.items) {
      await reverseItemFromProduct(item, req.user.id, session);
    }

    // 2. Rollback supplier values
    supplierDoc.totalPurchase -= purchase.grandTotal;
    supplierDoc.totalPaid -= purchase.amountPaid;
    await supplierDoc.save({ session });

    // 3. Delete old Ledger entries
    await SupplierLedger.deleteMany({ referenceId: purchase._id, user: req.user.id }).session(session);

    // 4. Audit Trail (Optional but professional)
    const auditLedger = new SupplierLedger({
      supplier: purchase.supplier,
      transactionType: "Return",
      description: `VOID / CANCELED: Purchase Bill #${purchase.purchaseNumber}`,
      debit: purchase.grandTotal,
      credit: purchase.amountPaid,
      runningBalance: supplierDoc.balance,
      user: req.user.id
    });
    await auditLedger.save({ session });

    // 5. Delete purchase record
    await purchase.deleteOne({ session });

    await session.commitTransaction();
    res.json({ msg: `Purchase bill #${purchase.purchaseNumber} deleted and stock adjusted.` });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ msg: err.message || "Failed to cancel purchase" });
  } finally {
    session.endSession();
  }
});

module.exports = router;