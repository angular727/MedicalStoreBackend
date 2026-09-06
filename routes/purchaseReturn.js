const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Purchase = require("../models/purchase");
const PurchaseReturn = require("../models/PurchaseReturn");
const Product = require("../models/Product");
const Supplier = require("../models/supplier");
const SupplierLedger = require("../models/SupplierLedger");
const auth = require("../middleware/auth");
const batchStock = require("../utils/batchStock");

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
// 1. CREATE PURCHASE RETURN
// Body: { purchaseId, items:[{ productId, quantity }], reason }
// Effect: stock -qty (must be in stock), supplier payable reduced
//         (ledger debit), supplier.totalPurchase reduced. Over-return prevented.
// ==========================================
router.post("/", auth, async (req, res) => {
  try {
    const { purchaseId, items, reason } = req.body;
    if (!purchaseId) throw new Error("Original purchase is required");
    if (!Array.isArray(items) || items.length === 0) throw new Error("Select at least one item to return");

    const returnId = await withTxnRetry(async (session) => {
      const purchase = await Purchase.findOne({ _id: purchaseId, user: req.user.id }).session(session);
      if (!purchase) throw new Error("Original purchase not found");

      // How much already returned per product on this purchase
      const priorReturns = await PurchaseReturn.find({ originalPurchase: purchaseId, user: req.user.id }).session(session);
      const alreadyReturned = {};
      priorReturns.forEach(r => r.items.forEach(it => {
        alreadyReturned[it.product.toString()] = (alreadyReturned[it.product.toString()] || 0) + it.quantity;
      }));

      const returnItems = [];
      let totalAmount = 0;

      for (const reqItem of items) {
        const qty = Number(reqItem.quantity) || 0;
        if (qty <= 0) continue;

        const purItem = purchase.items.find(pi => pi.product.toString() === String(reqItem.productId));
        if (!purItem) throw new Error("A returned item does not belong to this purchase");

        // Bonus/free pieces were delivered too, so they can be sent back as well
        const paidPurchased = purItem.quantity;
        const bonusPurchased = purItem.bonusQty || 0;
        const receivedQty = paidPurchased + bonusPurchased;

        const priorQty = alreadyReturned[String(reqItem.productId)] || 0;
        if (qty + priorQty > receivedQty) {
          throw new Error(`Return quantity exceeds what was received. Received: ${receivedQty} (${paidPurchased} paid + ${bonusPurchased} free), already returned: ${priorQty}.`);
        }

        // Take it out of the very batch this bill brought in — that is the
        // stock physically going back to the distributor
        const product = await Product.findOne({ _id: reqItem.productId, user: req.user.id }).session(session);
        if (!product) throw new Error("Medicine not found for return");

        await batchStock.removeStock({
          productId: product._id,
          userId: req.user.id,
          quantity: qty,
          batchNo: purItem.batchNumber,
          expiryDate: purItem.expiryDate,
          productName: product.productName
        }, session);

        // Returns are applied to the paid pieces first, free pieces last.
        // Only paid pieces earn a credit, and at the discounted (net) rate the
        // distributor actually charged.
        const paidQty = Math.max(0, Math.min(priorQty + qty, paidPurchased) - Math.min(priorQty, paidPurchased));
        const freeQty = qty - paidQty;

        const netRate = purItem.netRate || purItem.purchasePrice;
        const lineTotal = paidQty * netRate;
        totalAmount += lineTotal;

        returnItems.push({
          product: reqItem.productId,
          productName: reqItem.productName || product.productName,
          batchNumber: purItem.batchNumber || "",
          expiryDate: purItem.expiryDate || null,
          quantity: qty,
          paidQty,
          freeQty,
          purchasePrice: purItem.purchasePrice,
          netRate,
          lineTotal
        });
      }

      if (returnItems.length === 0) throw new Error("Select at least one item with quantity to return");

      const returnNumber = "PR-" + Math.floor(1000 + Math.random() * 9000);

      // Adjust supplier payable and capture the name for the return record
      const supplier = await Supplier.findOne({ _id: purchase.supplier, user: req.user.id }).session(session);

      const purchaseReturn = new PurchaseReturn({
        originalPurchase: purchase._id,
        purchaseNumber: purchase.purchaseNumber,
        returnNumber,
        supplier: purchase.supplier,
        supplierName: supplier ? supplier.name : "",
        items: returnItems,
        totalAmount,
        reason: reason || "",
        user: req.user.id
      });
      await purchaseReturn.save({ session });

      if (supplier) {
        supplier.totalPurchase -= totalAmount; // reduces what we owe
        await supplier.save({ session });

        const ledger = new SupplierLedger({
          supplier: purchase.supplier,
          transactionType: "Return",
          description: `Purchase Return ${returnNumber} (against Invoice #${purchase.purchaseNumber})`,
          credit: 0,
          debit: totalAmount, // debit reduces the supplier's running balance (payable)
          runningBalance: supplier.balance,
          referenceId: purchaseReturn._id,
          user: req.user.id
        });
        await ledger.save({ session });
      }

      return purchaseReturn._id;
    });

    res.status(201).json({ msg: "Purchase return recorded successfully", id: returnId });
  } catch (err) {
    console.error("Purchase Return Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  }
});

// ==========================================
// 2. LIST PURCHASE RETURNS (with date filter)
// ==========================================
router.get("/", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = { user: req.user.id };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); filter.date.$lte = d; }
    }
    const returns = await PurchaseReturn.find(filter)
      .populate("supplier", "name companyName phone")
      .sort({ date: -1 });
    res.json(returns);
  } catch (err) {
    res.status(500).json({ msg: "Failed to fetch purchase returns" });
  }
});

// ==========================================
// 3. GET RETURNS FOR A SPECIFIC PURCHASE
// ==========================================
router.get("/purchase/:purchaseId", auth, async (req, res) => {
  try {
    const returns = await PurchaseReturn.find({ originalPurchase: req.params.purchaseId, user: req.user.id });
    const returnedByProduct = {};
    returns.forEach(r => r.items.forEach(it => {
      returnedByProduct[it.product.toString()] = (returnedByProduct[it.product.toString()] || 0) + it.quantity;
    }));
    res.json({ returnedByProduct });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 4. DELETE A PURCHASE RETURN (undo)
// Puts the returned stock back, restores the supplier payable and removes
// the ledger entry. Needed before a bill with returns can be edited or voided.
// ==========================================
router.delete("/:id", auth, async (req, res) => {
  try {
    await withTxnRetry(async (session) => {
      const ret = await PurchaseReturn.findOne({ _id: req.params.id, user: req.user.id }).session(session);
      if (!ret) throw new Error("Purchase return not found");

      // Put the stock back into the batch it left from
      for (const item of ret.items) {
        const product = await Product.findOne({ _id: item.product, user: req.user.id }).session(session);
        if (!product) continue;
        await batchStock.addStock({
          productId: product._id,
          userId: req.user.id,
          batchNo: item.batchNumber || "",
          expiryDate: item.expiryDate || null,
          quantity: item.quantity
        }, session);
      }

      // Restore what we owe the supplier
      const supplier = await Supplier.findOne({ _id: ret.supplier, user: req.user.id }).session(session);
      if (supplier) {
        supplier.totalPurchase += ret.totalAmount;
        await supplier.save({ session });
      }

      await SupplierLedger.deleteMany({ referenceId: ret._id, user: req.user.id }).session(session);
      await ret.deleteOne({ session });
    });

    res.json({ msg: "Purchase return deleted and stock restored" });
  } catch (err) {
    console.error("Delete purchase return error:", err.message);
    res.status(500).json({ msg: err.message || "Failed to delete purchase return" });
  }
});

module.exports = router;
