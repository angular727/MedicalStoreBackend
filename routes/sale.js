const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const CustomerLedger = require("../models/CustomerLedger");
const auth = require("../middleware/auth");
const { isPaged, getPageParams, pagedResponse } = require("../utils/paginate");
const batchStock = require("../utils/batchStock");

// ==========================================
// Helper: run a transaction with auto-retry on transient
// MongoDB conflicts ("Write conflict ... yielding is disabled").
// Atlas shared tiers throw these intermittently — retry is the
// official recommended handling.
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
        await new Promise(r => setTimeout(r, 60 * attempt)); // small backoff
        continue;
      }
      throw err;
    }
  }
}

// ==========================================
// HELPER: validate the sale lines, take the stock out and work out the
// totals. Everything money-related is computed here on the server — the
// figures the browser sends are only a preview.
//
// A medical store sells either a whole pack, or loose pieces out of an
// opened pack (only when the medicine allows it), so the rate depends on
// which of the two the counter picked.
// ==========================================
async function buildSaleItems(items, header, userId, session) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Add at least one medicine to the bill");
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let subTotal = 0;
  let itemDiscount = 0;
  const processed = [];

  for (const item of items) {
    if (!item.productId) throw new Error("Please select a medicine for each line");

    const qty = Number(item.quantity) || 0;
    if (qty < 1) throw new Error("Quantity cannot be less than 1");

    // Scoped to this user — never touch another store's stock
    const product = await Product.findOne({ _id: item.productId, user: userId }).session(session);
    if (!product) throw new Error("Medicine not found on this bill");

    // Make sure opening stock entered on the medicine itself is represented
    // as a batch, otherwise it would be invisible to the batch picker
    await batchStock.ensureOpeningBatch(product, session);

    // Loose selling is only allowed when the medicine is set up for it
    const saleUnit = item.saleUnit === "loose" ? "loose" : "pack";
    if (saleUnit === "loose" && !(product.type === "pack" && product.looseSale)) {
      throw new Error(`"${product.productName}" cannot be sold loose.`);
    }

    const rate = saleUnit === "loose"
      ? Number(product.looseSalePrice || 0)
      : Number(product.salePrice || 0);
    if (rate <= 0) throw new Error(`"${product.productName}" has no sale rate set.`);

    const unitName = saleUnit === "loose"
      ? (product.unitLabel || "Piece")
      : (product.type === "pack" ? (product.packLabel || "Box") : (product.unitLabel || "Piece"));

    // Loose pieces still come out of whole packs, so this is what leaves stock
    const unitsPerPack = Math.max(1, Number(product.unitsPerPack) || 1);
    const stockUsed = saleUnit === "loose" ? qty / unitsPerPack : qty;

    // Take it out of the batch that expires first (FEFO). This also refuses
    // any batch that has already expired — expired goods never leave the counter.
    const allocations = await batchStock.consumeFEFO({
      productId: product._id,
      userId,
      quantity: stockUsed,
      productName: product.productName,
      today
    }, session);

    const discountPct = Number(item.discountPercent) || 0;
    if (discountPct < 0 || discountPct > 100) throw new Error("Discount % must be between 0 and 100");

    const gross = qty * rate;
    const lineDiscount = gross * (discountPct / 100);
    const netRate = rate - (rate * (discountPct / 100));
    const lineTotal = gross - lineDiscount;

    subTotal += gross;
    itemDiscount += lineDiscount;

    // Cost snapshot must be per unit SOLD. product.unitPrice is the cost of a
    // whole pack, so a loose sale has to divide it down — otherwise profit on
    // a loose line comes out wildly negative.
    const costPerUnit = saleUnit === "loose"
      ? (Number(product.unitPrice) || 0) / unitsPerPack
      : (Number(product.unitPrice) || 0);

    // The batch the goods mostly came from — what goes on the printed bill
    const mainBatch = allocations[0] || {};

    processed.push({
      product: product._id,
      productName: product.productName,
      batchNumber: mainBatch.batchNo || "",
      expiryDate: mainBatch.expiryDate || null,
      batchesUsed: allocations,
      saleUnit,
      unitName,
      quantity: qty,
      salePrice: rate,
      discountPercent: discountPct,
      discount: lineDiscount,
      netRate,
      purchasePriceAtTime: costPerUnit,
      lineTotal
    });
  }

  const billDiscount = Number(header.discount) || 0;
  const deliveryCharges = Number(header.deliveryCharges) || 0;
  const grandTotal = subTotal - itemDiscount - billDiscount + deliveryCharges;

  if (grandTotal < 0) throw new Error("Discount cannot be more than the bill total");

  return { processed, subTotal, itemDiscount, billDiscount, deliveryCharges, grandTotal };
}

// Put back the stock a sale (or an old version of it) had taken out — into the
// exact batches it came from, so batch quantities stay honest
async function restoreSaleStock(saleItems, userId, session) {
  for (const item of saleItems) {
    if (item.batchesUsed && item.batchesUsed.length) {
      await batchStock.restoreAllocations({
        productId: item.product,
        userId,
        allocations: item.batchesUsed
      }, session);
      continue;
    }

    // Bills written before batches existed carry no allocation — put the
    // quantity back as a single batch so nothing is lost
    const product = await Product.findOne({ _id: item.product, user: userId }).session(session);
    if (!product) continue;
    const unitsPerPack = Math.max(1, Number(product.unitsPerPack) || 1);
    const stockUsed = item.saleUnit === "loose" ? item.quantity / unitsPerPack : item.quantity;
    await batchStock.addStock({
      productId: item.product,
      userId,
      batchNo: item.batchNumber || "",
      expiryDate: item.expiryDate || null,
      quantity: stockUsed
    }, session);
  }
}

// ==========================================
// 1. CREATE SALE (Sale Invoice Entry)
// ==========================================
router.post("/", auth, async (req, res) => {
  try {
    const { customerId, customerName, invoiceNumber, items, amountReceived } = req.body;
    if (!invoiceNumber) throw new Error("Invoice number is required");

    const newSaleId = await withTxnRetry(async (session) => {
      const dupe = await Sale.findOne({ invoiceNumber, user: req.user.id }).session(session);
      if (dupe) throw new Error(`Invoice #${invoiceNumber} already exists`);

      const totals = await buildSaleItems(items, req.body, req.user.id, session);

      // Tolerance of a paisa, so a rounded rupee entry is not rejected
      const received = Number(amountReceived) || 0;
      if (received > totals.grandTotal + 0.01) throw new Error("Amount received cannot exceed the grand total");

      const grandTotal = totals.grandTotal;

      // Take the name off the customer record when one is picked, so the bill
      // never says "Walking Customer" for a named account
      let billName = customerName || "Walking Customer";
      if (customerId) {
        const c = await Customer.findOne({ _id: customerId, user: req.user.id }).session(session);
        if (c) billName = c.name;
      }

      // B. Create Sale Entry
      const newSale = new Sale({
        customer: customerId || null,
        customerName: billName,
        invoiceNumber,
        doctorName: req.body.doctorName || "",
        prescriptionNo: req.body.prescriptionNo || "",
        items: totals.processed,
        subTotal: totals.subTotal,
        itemDiscount: totals.itemDiscount,
        discount: totals.billDiscount,
        deliveryCharges: totals.deliveryCharges,
        grandTotal,
        amountReceived: received,
        user: req.user.id
      });
      await newSale.save({ session });

      // C. Customer ledger — only for a named customer, not a walk-in
      if (customerId) {
        const customer = await Customer.findOne({ _id: customerId, user: req.user.id }).session(session);
        if (customer) {
          customer.totalSale += grandTotal;
          customer.totalPaid += received;
          await customer.save({ session });

          const ledger = new CustomerLedger({
            customer: customerId,
            transactionType: "Sale",
            description: `Invoice #${invoiceNumber}`,
            debit: grandTotal,   // what the customer now owes
            credit: received,    // what they paid at the counter
            runningBalance: customer.balance,
            referenceId: newSale._id,
            user: req.user.id
          });
          await ledger.save({ session });
        }
      }

      return newSale._id;
    });

    res.status(201).json({ msg: "Sale saved successfully", id: newSaleId });

  } catch (err) {
    console.error("Sale Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  }
});

// ==========================================
// 2. SALES HISTORY REPORT
// ==========================================
router.get("/", auth, async (req, res) => {
  try {
    const { from, to, search } = req.query;
    let filter = { user: req.user.id };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = toDate;
      }
    }

    if (search) {
      const rx = { $regex: search, $options: "i" };
      // Resolve customer names to ids so name search works on registered customers too
      const custIds = await Customer.find({ user: req.user.id, name: rx }).distinct("_id");
      filter.$or = [
        { invoiceNumber: rx },
        { customerName: rx },
        { customer: { $in: custIds } }
      ];
    }

    if (!isPaged(req)) {
      const sales = await Sale.find(filter)
        .populate("customer", "name phone")
        .sort({ createdAt: -1 });
      return res.json(sales);
    }

    const { page, limit, skip } = getPageParams(req);
    const aggMatch = { ...filter, user: new mongoose.Types.ObjectId(req.user.id) };
    const [data, total, agg] = await Promise.all([
      Sale.find(filter).populate("customer", "name phone").sort({ createdAt: -1 }).skip(skip).limit(limit),
      Sale.countDocuments(filter),
      Sale.aggregate([
        { $match: aggMatch },
        { $group: { _id: null, totalSales: { $sum: "$grandTotal" }, totalReceived: { $sum: "$amountReceived" } } }
      ])
    ]);

    const totalSales = agg[0]?.totalSales || 0;
    const totalReceived = agg[0]?.totalReceived || 0;
    res.json(pagedResponse(data, total, page, limit, {
      totalSales, totalReceived, totalDue: totalSales - totalReceived
    }));
  } catch (err) {
    console.error("Fetch sales error:", err.message);
    res.status(500).json({ msg: "Fetch sales error" });
  }
});

// ==========================================
// 3. SINGLE SALE DETAIL (Invoice Print)
// ==========================================
router.get("/:id", auth, async (req, res) => {
  try {
    const sale = await Sale.findOne({ _id: req.params.id, user: req.user.id })
      .populate("customer", "name phone address email")
      .populate("items.product", "productName genericName brand category strength type unitLabel packLabel unitsPerPack looseSale looseSalePrice salePrice unitPrice currentStock sellableStock batchNo expiryDate barcode");
    
    if (!sale) return res.status(404).json({ msg: "Invoice not found" });
    res.json(sale);
  } catch (err) {
    res.status(500).json({ msg: "Detail fetch error" });
  }
});

// ==========================================
// 4. PROFIT & LOSS REPORT
// ==========================================
router.get("/report/profit", auth, async (req, res) => {
  try {
    const sales = await Sale.find({ user: req.user.id });
    let revenue = 0;
    let cost = 0;

    sales.forEach(sale => {
      revenue += sale.grandTotal;
      sale.items.forEach(item => {
        cost += (item.purchasePriceAtTime * item.quantity);
      });
    });

    res.json({
      totalSales: revenue,
      totalCost: cost,
      netProfit: revenue - cost,
      profitMargin: revenue > 0 ? ((revenue - cost) / revenue * 100).toFixed(2) + "%" : "0%"
    });
  } catch (err) {
    res.status(500).json({ msg: "Profit report error" });
  }
});

// ==========================================
// 5. SINGLE PRODUCT PERFORMANCE REPORT
// ==========================================
router.get("/report/product/:productId", auth, async (req, res) => {
  try {
    const { productId } = req.params;

    const sales = await Sale.find({ 
      user: req.user.id, 
      "items.product": productId 
    }).populate("items.product", "productName genericName brand category strength type unitLabel packLabel unitsPerPack looseSale looseSalePrice salePrice unitPrice currentStock sellableStock batchNo expiryDate barcode");

    let totalQtySold = 0;
    let totalRevenue = 0;
    let totalCost = 0;
    let productName = "";

    sales.forEach(sale => {
      const productItems = sale.items.filter(item => item.product._id.toString() === productId);
      
      productItems.forEach(item => {
        totalQtySold += item.quantity;
        totalRevenue += item.lineTotal;
        totalCost += (item.purchasePriceAtTime * item.quantity);
        productName = item.product.productName;
      });
    });

    res.json({
      productId,
      productName,
      summary: {
        totalSold: totalQtySold,
        totalRevenue: totalRevenue,
        totalPurchaseCost: totalCost,
        netProfit: totalRevenue - totalCost,
        profitPercentage: totalCost > 0 ? ((totalRevenue - totalCost) / totalCost * 100).toFixed(2) + "%" : "0%"
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Product report error" });
  }
});
// ==========================================
// 6. UPDATE SALE (Sale Edit Logic)
// ==========================================
router.put("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { customerId, customerName, invoiceNumber, items, amountReceived } = req.body;

    // 1. Find the original bill so its stock effect can be reversed
    const oldSale = await Sale.findOne({ _id: req.params.id, user: req.user.id }).session(session);
    if (!oldSale) throw new Error("Previous record not found");

    // A bill that already has returns against it cannot be edited — the returns
    // put stock back and posted their own ledger rows, so reversing this bill
    // would count the same stock twice. Delete the returns first.
    const SaleReturn = require("../models/SaleReturn");
    const returnCount = await SaleReturn.countDocuments({
      originalSale: oldSale._id, user: req.user.id
    }).session(session);
    if (returnCount > 0) {
      throw new Error(`This bill has ${returnCount} return(s) against it. Delete the return(s) first, then edit the bill.`);
    }

    // 2. Put the old stock back
    await restoreSaleStock(oldSale.items, req.user.id, session);

    // 3. Re-price and re-check the new lines, and take the new stock out
    const totals = await buildSaleItems(items, req.body, req.user.id, session);

    const received = Number(amountReceived) || 0;
    if (received > totals.grandTotal + 0.01) throw new Error("Amount received cannot exceed the grand total");
    const grandTotal = totals.grandTotal;

    // Same here — prefer the name on the customer record
    let billName = customerName || "Walking Customer";
    if (customerId) {
      const c = await Customer.findOne({ _id: customerId, user: req.user.id }).session(session);
      if (c) billName = c.name;
    }

    // 4. Update Sale Document
    const updatedSale = await Sale.findByIdAndUpdate(
      req.params.id,
      {
        customer: customerId || null,
        customerName: billName,
        doctorName: req.body.doctorName || "",
        prescriptionNo: req.body.prescriptionNo || "",
        items: totals.processed,
        subTotal: totals.subTotal,
        itemDiscount: totals.itemDiscount,
        discount: totals.billDiscount,
        deliveryCharges: totals.deliveryCharges,
        grandTotal,
        amountReceived: received
      },
      { new: true, session }
    );

    // Reverse the OLD sale's effect on the OLD customer's running totals
    if (oldSale.customer) {
      const oldCust = await Customer.findOne({ _id: oldSale.customer, user: req.user.id }).session(session);
      if (oldCust) {
        oldCust.totalSale -= oldSale.grandTotal;
        oldCust.totalPaid -= oldSale.amountReceived;
        await oldCust.save({ session });
      }
    }

    // Remove the old ledger rows tied to this invoice
    await CustomerLedger.deleteMany({ referenceId: oldSale._id, user: req.user.id }).session(session);

    // Apply the NEW sale's effect on the (possibly changed) customer
    if (customerId) {
      const newCust = await Customer.findOne({ _id: customerId, user: req.user.id }).session(session);
      if (newCust) {
        newCust.totalSale += grandTotal;
        newCust.totalPaid += received;
        await newCust.save({ session });

        const ledger = new CustomerLedger({
          customer: newCust._id,
          transactionType: "Sale Update",
          description: `Updated Invoice #${invoiceNumber}`,
          debit: grandTotal,
          credit: received,
          runningBalance: newCust.balance,
          referenceId: updatedSale._id,
          user: req.user.id
        });
        await ledger.save({ session });
      }
    }

    await session.commitTransaction();
    res.json({ msg: "Sale updated successfully", id: updatedSale._id });

  } catch (err) {
    await session.abortTransaction();
    console.error("Update Sale Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  } finally {
    session.endSession();
  }
});

// ==========================================
// 7. RECORD PAYMENT AGAINST AN EXISTING SALE (Receive Payment)
// ==========================================
router.post("/:id/payment", auth, async (req, res) => {
  try {
    const { amount, note, date } = req.body;
    const amt = Number(amount) || 0;
    if (amt <= 0) throw new Error("Amount must be greater than 0");

    const saleId = await withTxnRetry(async (session) => {
      const sale = await Sale.findOne({ _id: req.params.id, user: req.user.id }).session(session);
      if (!sale) throw new Error("Sale invoice not found");

      const balanceDue = sale.grandTotal - sale.amountReceived;
      if (amt > balanceDue) throw new Error("Amount cannot exceed the balance due");

      // Sale ka received amount hamesha update hota hai (walking ho ya registered)
      sale.amountReceived += amt;
      await sale.save({ session });

      // Ledger sirf registered customer ke liye — walking customer ka koi khata nahi
      if (sale.customer) {
        const customer = await Customer.findOne({ _id: sale.customer, user: req.user.id }).session(session);
        if (!customer) throw new Error("Customer not found");
        customer.totalPaid += amt;
        await customer.save({ session });

        const ledger = new CustomerLedger({
          customer: sale.customer,
          transactionType: "Payment",
          description: note || `Payment received against Invoice #${sale.invoiceNumber}`,
          credit: amt,
          debit: 0,
          runningBalance: customer.balance,
          referenceId: sale._id,
          date: date ? new Date(date) : new Date(),
          user: req.user.id
        });
        await ledger.save({ session });
      }

      return sale._id;
    });

    res.json({ msg: "Payment recorded", id: saleId });
  } catch (err) {
    res.status(500).json({ msg: err.message || "Payment record karne mein masla hua" });
  }
});

// ==========================================
// 8. DELETE SALE (Stock + Ledger rollback)
// ==========================================
router.delete("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const sale = await Sale.findOne({ _id: req.params.id, user: req.user.id }).session(session);
    if (!sale) return res.status(404).json({ msg: "Sale invoice not found" });

    // Returns already put this stock back and posted their own ledger rows,
    // so voiding here would add the same stock twice. Delete the returns first.
    const SaleReturn = require("../models/SaleReturn");
    const returnCount = await SaleReturn.countDocuments({
      originalSale: sale._id, user: req.user.id
    }).session(session);
    if (returnCount > 0) {
      throw new Error(`This bill has ${returnCount} return(s) against it. Delete the return(s) first, then void the bill.`);
    }

    // 1. Add the stock back (reverse the sale)
    await restoreSaleStock(sale.items, req.user.id, session);

    // 2. Reverse the customer balance and ledger
    if (sale.customer) {
      const customer = await Customer.findOne({ _id: sale.customer, user: req.user.id }).session(session);
      if (customer) {
        customer.totalSale -= sale.grandTotal;
        customer.totalPaid -= sale.amountReceived;
        await customer.save({ session });
      }
      await CustomerLedger.deleteMany({ referenceId: sale._id, user: req.user.id }).session(session);
    }

    // 3. Sale delete karein
    await sale.deleteOne({ session });

    await session.commitTransaction();
    res.json({ msg: `Sale #${sale.invoiceNumber} deleted, stock & ledger adjusted.` });
  } catch (err) {
    await session.abortTransaction();
    console.error("Delete Sale Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  } finally {
    session.endSession();
  }
});

module.exports = router;