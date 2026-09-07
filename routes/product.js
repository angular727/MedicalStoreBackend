const express = require("express");
const router  = express.Router();
const Product = require("../models/Product");
const auth    = require("../middleware/auth");
const { isPaged, getPageParams, pagedResponse } = require("../utils/paginate");
const batchStock = require("../utils/batchStock");

// Generates a short unique 4-digit product code per user, retrying on collision
async function generateProductCode(userId) {
  for (let i = 0; i < 15; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await Product.findOne({ productCode: code, user: userId });
    if (!exists) return code;
  }
  return String(Date.now()).slice(-6); // fallback
}

// Normalizes and validates the product body (used by both POST and PUT).
// Returns an error string, or null when everything is valid.
function normalizeProductBody(body) {
  // Sale unit: single (by the piece) or pack (whole box)
  if (!body.type || !["single", "pack"].includes(body.type)) {
    return "Product type must be 'single' or 'pack'.";
  }

  if (body.unitPrice == null || body.salePrice == null) {
    return "Purchase price and sale price are both required.";
  }

  body.unitPrice    = Number(body.unitPrice);
  body.salePrice    = Number(body.salePrice);
  body.initialStock = body.initialStock != null ? Number(body.initialStock) : 0;
  body.minStock     = body.minStock != null ? Number(body.minStock) : null;

  if (isNaN(body.unitPrice) || isNaN(body.salePrice)) {
    return "Purchase price and sale price must be valid numbers.";
  }

  // ── Packing ───────────────────────────────────────────
  if (body.type === "pack") {
    body.unitsPerPack = Number(body.unitsPerPack);
    if (!body.unitsPerPack || body.unitsPerPack < 1) {
      return "Units per pack is required for a pack (e.g. 1 box = 10 tablets).";
    }

    body.looseSale = !!body.looseSale;
    if (body.looseSale) {
      if (body.looseSalePrice == null) {
        return "Loose sale price is required when loose selling is allowed.";
      }
      body.looseSalePrice = Number(body.looseSalePrice);
    } else {
      body.looseSalePrice = null;
    }
  } else {
    // Single item — the pack fields do not apply
    body.unitsPerPack   = 1;
    body.looseSale      = false;
    body.looseSalePrice = null;
  }

  // Cast the expiry date to a Date
  if (body.expiryDate) {
    const exp = new Date(body.expiryDate);
    if (isNaN(exp.getTime())) return "Expiry date is not valid.";
    body.expiryDate = exp;
  } else {
    body.expiryDate = null;
  }

  return null;
}

// ── POST /api/product ─────────────────────────────────────────────────────
router.post("/", auth, async (req, res) => {
  try {
    const body = req.body;

    const invalid = normalizeProductBody(body);
    if (invalid) return res.status(400).json({ msg: invalid });

    body.currentStock  = body.initialStock; // Seed the opening stock
    body.purchasePrice = body.unitPrice;    // Seed the opening price

    body.productCode = await generateProductCode(req.user.id);

    const product = new Product({ ...body, user: req.user.id });
    await product.save();

    // Opening stock becomes the medicine's first batch, so it is visible to
    // the batch picker, the expiry report and the stock screen
    await batchStock.ensureOpeningBatch(product);

    res.status(201).json(product);

  } catch (err) {
    console.error("POST /product error:", err.message);

    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ msg: "Validation failed", errors });
    }

    res.status(500).json({ msg: err.message || "Server Error: Save failed" });
  }
});

// ── GET /api/product ──────────────────────────────────────────────────────
router.get("/", auth, async (req, res) => {
  try {
    const { search, admin, type, filter } = req.query;

    // The four views a medical store opens every morning
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const in90Days = new Date(today);
    in90Days.setDate(in90Days.getDate() + 90);

    // Expiry views come from the batch ledger — a medicine counts as expired
    // when it is holding an expired batch, whatever its newest batch says
    const StockBatch = require("../models/StockBatch");
    const withExpiredBatch = async () => StockBatch.distinct("product", {
      user: req.user.id, quantity: { $gt: 0 },
      expiryDate: { $ne: null, $lt: today }
    });
    const withNearExpiryBatch = async () => StockBatch.distinct("product", {
      user: req.user.id, quantity: { $gt: 0 },
      expiryDate: { $ne: null, $gte: today, $lte: in90Days }
    });

    const [expiredIds, nearExpIds] = await Promise.all([withExpiredBatch(), withNearExpiryBatch()]);

    const VIEWS = {
      expired:  { _id: { $in: expiredIds } },
      nearexp:  { _id: { $in: nearExpIds } },
      lowstock: { $expr: { $and: [
        { $ne: ["$minStock", null] },
        { $gt: ["$currentStock", 0] },
        { $lte: ["$currentStock", "$minStock"] }
      ] } },
      outofstock: { currentStock: { $lte: 0 } }
    };

    // Admin: their own data plus every other user (role check)
    let userFilter = { user: req.user.id };
    if (admin === "true" && req.user.role === "admin") {
      userFilter = {};
    }

    // Search filter (shared by list + counts)
    const searchFilter = {};
    if (search) {
      searchFilter.$or = [
        { productName: { $regex: search, $options: "i" } },
        { genericName: { $regex: search, $options: "i" } },
        { brand:       { $regex: search, $options: "i" } },
        { category:    { $regex: search, $options: "i" } },
        { batchNo:     { $regex: search, $options: "i" } },
        { barcode:     search }
      ];
    }

    // Full query = user + search + (optional) type + (optional) view
    let query = { ...userFilter, ...searchFilter };
    if (type === "pack" || type === "single") query.type = type;
    if (VIEWS[filter]) query = { ...query, ...VIEWS[filter] };

    // Expiring stock first when looking at an expiry view, newest otherwise
    const sortBy = (filter === "expired" || filter === "nearexp")
      ? { expiryDate: 1 }
      : { createdAt: -1 };

    if (!isPaged(req)) {
      const products = await Product.find(query).sort(sortBy);
      return res.json(products);
    }

    // Paginated response with tab counts (counts ignore the active view)
    const { page, limit, skip } = getPageParams(req);
    const countBase = { ...userFilter, ...searchFilter };
    const [data, total, all, pack, single, expired, nearexp, lowstock, outofstock] = await Promise.all([
      Product.find(query).sort(sortBy).skip(skip).limit(limit),
      Product.countDocuments(query),
      Product.countDocuments(countBase),
      Product.countDocuments({ ...countBase, type: "pack" }),
      Product.countDocuments({ ...countBase, type: "single" }),
      Product.countDocuments({ ...countBase, ...VIEWS.expired }),
      Product.countDocuments({ ...countBase, ...VIEWS.nearexp }),
      Product.countDocuments({ ...countBase, ...VIEWS.lowstock }),
      Product.countDocuments({ ...countBase, ...VIEWS.outofstock })
    ]);

    res.json(pagedResponse(data, total, page, limit, {
      all, pack, single, expired, nearexp, lowstock, outofstock
    }));
  } catch (err) {
    console.error("GET /product error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error: Fetch failed" });
  }
});



// ── PUT /api/product/:id ──────────────────────────────────────────────────
router.put("/:id", auth, async (req, res) => {
  try {
    const body = req.body;

    const invalid = normalizeProductBody(body);
    if (invalid) return res.status(400).json({ msg: invalid });

    // Never overwrite currentStock on edit — purchase/sale own that value
    delete body.currentStock;

    const updated = await Product.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: body },
      { new: true, runValidators: true }
    );

    if (!updated) return res.status(404).json({ msg: "Product not found." });

    // Keep the batch ledger in step with the master record.
    //
    // Editing a medicine used to change only the Product document, so its
    // batch number and expiry drifted away from the batch actually holding the
    // stock — the expiry views read the ledger and called a medicine expired
    // while the list showed the newer date typed on the form.
    //
    // Only opening stock is touched. A batch that came in on a purchase
    // carries the batch number printed on the pack, and editing the medicine
    // master must never rewrite that history.
    const StockBatch = require("../models/StockBatch");
    const batches = await StockBatch.find({ product: updated._id, user: req.user.id });
    const opening = batches.filter(b => !b.purchase);

    if (batches.length === opening.length && opening.length === 1) {
      const b = opening[0];
      const newBatchNo = updated.batchNo || "";
      const newExpiry  = updated.expiryDate || null;
      const changed =
        b.batchNo !== newBatchNo ||
        String(b.expiryDate || "") !== String(newExpiry || "");

      if (changed) {
        b.batchNo = newBatchNo;
        b.expiryDate = newExpiry;
        await b.save();
      }
    }

    // Recompute totals and re-point the master record at its live batch, so
    // currentStock, sellableStock and the shown expiry always agree
    const synced = (await batchStock.syncProduct(updated._id, req.user.id)) || updated;

    res.json(synced);
  } catch (err) {
    console.error("PUT /product error:", err.message);
    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ msg: "Validation failed", errors });
    }
    res.status(500).json({ msg: err.message || "Update failed" });
  }
});


// ── GET /api/product/:id/batches — purchase batch history ──────────────────
router.get("/:id/batches", auth, async (req, res) => {
  try {
    const Purchase = require("../models/purchase");
    const batches = await Purchase.find(
      { "items.product": req.params.id, user: req.user.id },
      { purchaseNumber: 1, date: 1, supplier: 1, items: 1 }
    )
    .populate("supplier", "name companyName")
    .sort({ date: -1 });

    // What each delivery brought in
    const history = batches.map(p => {
      const item = p.items.find(i => i.product?.toString() === req.params.id);
      return {
        batchNumber: item?.batchNumber || "—",   // the real batch printed on the pack
        expiryDate: item?.expiryDate || null,
        invoiceNumber: p.purchaseNumber,
        date: p.date,
        supplier: p.supplier?.name || "—",
        quantity: (item?.quantity || 0) + (item?.bonusQty || 0),
        bonusQty: item?.bonusQty || 0,
        purchasePrice: item?.purchasePrice || 0,
        netRate: item?.netRate || item?.purchasePrice || 0
      };
    });

    // What is actually left of each batch, nearest expiry first — this is the
    // question a medical store really asks
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const day = 1000 * 60 * 60 * 24;

    const live = (await batchStock.listBatches(req.params.id, req.user.id)).map(b => {
      const daysLeft = b.expiryDate
        ? Math.ceil((new Date(b.expiryDate).getTime() - today.getTime()) / day)
        : null;
      return {
        _id: b._id,
        batchNo: b.batchNo || "—",
        expiryDate: b.expiryDate,
        daysLeft,
        status: daysLeft === null ? "No expiry"
          : (daysLeft < 0 ? "Expired" : (daysLeft <= 90 ? "Near expiry" : "Good")),
        quantity: b.quantity,
        purchaseRate: b.purchaseRate,
        value: b.quantity * (b.purchaseRate || 0)
      };
    });

    res.json({ live, history });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ── POST /api/product/:id/adjust-stock — manual stock / min-stock adjustment ─
// Body: { currentStock?, minStock?, reason? }
// Records an audit entry in StockLog for every change.
router.post("/:id/adjust-stock", auth, async (req, res) => {
  try {
    const StockLog = require("../models/StockLog");
    const { currentStock, minStock, reason } = req.body;

    const product = await Product.findOne({ _id: req.params.id, user: req.user.id });
    if (!product) return res.status(404).json({ msg: "Product not found" });

    const logs = [];
    const prevStock = product.currentStock || 0;
    const prevMin = product.minStock;

    // Current stock adjustment
    if (currentStock !== undefined && currentStock !== null && currentStock !== "") {
      const newStock = Number(currentStock);
      if (isNaN(newStock) || newStock < 0) {
        return res.status(400).json({ msg: "Stock quantity must be a valid number (0 or more)." });
      }
      if (newStock !== prevStock) {
        // Push the difference through the batch ledger so batches and the
        // total never disagree. A count-up lands in the current batch; a
        // count-down comes off nearest-expiry first.
        await batchStock.ensureOpeningBatch(product);
        const diff = newStock - prevStock;
        if (diff > 0) {
          await batchStock.addStock({
            productId: product._id,
            userId: req.user.id,
            batchNo: product.batchNo || "ADJUSTED",
            expiryDate: product.expiryDate || null,
            quantity: diff,
            purchaseRate: product.unitPrice,
            salePrice: product.salePrice
          });
        } else {
          await batchStock.removeStock({
            productId: product._id,
            userId: req.user.id,
            quantity: -diff,
            productName: product.productName
          });
        }
        product.currentStock = newStock;
        logs.push({
          product: product._id,
          type: "Stock Adjustment",
          previousStock: prevStock,
          newStock: newStock,
          change: newStock - prevStock,
          previousMinStock: prevMin,
          newMinStock: prevMin,
          reason: reason || "Manual stock adjustment",
          user: req.user.id
        });
      }
    }

    // Min-stock update
    if (minStock !== undefined && minStock !== null && minStock !== "") {
      const newMin = Number(minStock);
      if (isNaN(newMin) || newMin < 0) {
        return res.status(400).json({ msg: "Minimum stock must be a valid number (0 or more)." });
      }
      if (newMin !== prevMin) {
        product.minStock = newMin;
        logs.push({
          product: product._id,
          type: "Min Stock Update",
          previousStock: product.currentStock || 0,
          newStock: product.currentStock || 0,
          change: 0,
          previousMinStock: prevMin,
          newMinStock: newMin,
          reason: reason || "Minimum stock level updated",
          user: req.user.id
        });
      }
    }

    if (logs.length === 0) {
      return res.status(400).json({ msg: "No changes detected. Enter a new stock or minimum stock value." });
    }

    await product.save();
    await StockLog.insertMany(logs);

    res.json({ msg: "Stock updated successfully", product });
  } catch (err) {
    console.error("POST /product/:id/adjust-stock error:", err.message);
    res.status(500).json({ msg: err.message || "Stock adjustment failed" });
  }
});

// ── GET /api/product/:id/stock-logs — manual adjustment history ─────────────
router.get("/:id/stock-logs", auth, async (req, res) => {
  try {
    const StockLog = require("../models/StockLog");
    const logs = await StockLog.find({ product: req.params.id, user: req.user.id }).sort({ date: -1 }).limit(50);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ── GET /api/product/:id (Naya Route) ──────────────────────────────────────
router.get("/:id", auth, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, user: req.user.id });
    
    if (!product) {
      return res.status(404).json({ msg: "Product not found" });
    }
    
    res.json(product);
  } catch (err) {
    console.error("GET /product/:id error:", err.message);
    if (err.kind === 'ObjectId') {
        return res.status(400).json({ msg: "Invalid ID format" });
    }
    res.status(500).json({ msg: "Server Error" });
  }
});

// ── DELETE /api/product/:id (only if not used in sale/purchase) ────────────
router.delete("/:id", auth, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, user: req.user.id });
    if (!product) return res.status(404).json({ msg: "Product not found" });

    const Sale = require("../models/Sale");
    const Purchase = require("../models/purchase");
    const saleUse = await Sale.countDocuments({ "items.product": req.params.id, user: req.user.id });
    const purchaseUse = await Purchase.countDocuments({ "items.product": req.params.id, user: req.user.id });

    if (saleUse > 0 || purchaseUse > 0) {
      return res.status(400).json({
        msg: "This product is already used in a sale/purchase and cannot be deleted."
      });
    }

    await product.deleteOne();
    res.json({ msg: "Product deleted successfully" });
  } catch (err) {
    console.error("DELETE /product error:", err.message);
    res.status(500).json({ msg: err.message || "Delete failed" });
  }
});

module.exports = router;