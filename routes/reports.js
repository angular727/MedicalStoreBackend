const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Sale = require("../models/Sale");
const Purchase = require("../models/purchase");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const Supplier = require("../models/supplier");

// Helper: date range filter
function dateFilter(from, to) {
  if (!from && !to) return null;
  const f = {};
  if (from) f.$gte = new Date(from);
  if (to) { const d = new Date(to); d.setHours(23,59,59,999); f.$lte = d; }
  return f;
}

// GET /api/reports/summary?from=&to=
// Dashboard summary: today sales, today purchases, total debit/credit
router.get("/summary", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const uid = req.user.id;

    // Today range
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);

    const [todaySales, todayPurchases, allSales, allPurchases, customers, suppliers, lowStock] = await Promise.all([
      Sale.find({ user: uid, createdAt: { $gte: todayStart, $lte: todayEnd } }),
      // createdAt use karte hain (sales ki tarah) — 'date' user-entered hoti hai jo UTC-midnight
      // store hoti hai aur server ke local timezone "today" window se bahar gir jaati thi
      Purchase.find({ user: uid, createdAt: { $gte: todayStart, $lte: todayEnd } }),
      Sale.find({ user: uid }),
      Purchase.find({ user: uid }),
      Customer.find({ user: uid }),
      Supplier.find({ user: uid }),
      Product.find({ user: uid })
    ]);

    res.json({
      today: {
        sales: todaySales.reduce((s, x) => s + (x.grandTotal || 0), 0),
        salesCount: todaySales.length,
        purchases: todayPurchases.reduce((s, x) => s + (x.grandTotal || 0), 0),
        purchasesCount: todayPurchases.length,
      },
      overall: {
        totalSales: allSales.reduce((s, x) => s + (x.grandTotal || 0), 0),
        totalPurchases: allPurchases.reduce((s, x) => s + (x.grandTotal || 0), 0),
        totalReceived: allSales.reduce((s, x) => s + (x.amountReceived || 0), 0),
        totalPaid: allPurchases.reduce((s, x) => s + (x.amountPaid || 0), 0),
        customerDebit: customers.reduce((s, c) => s + (c.balance || 0), 0),
        supplierCredit: suppliers.reduce((s, s2) => s + (s2.balance || 0), 0),
      },
      lowStock: lowStock
        .filter(p => (p.currentStock || 0) <= (p.minStock || 5))
        .map(p => ({ _id: p._id, productName: p.productName, model: p.model, brand: p.brand, currentStock: p.currentStock, minStock: p.minStock || 5 }))
        .sort((a, b) => a.currentStock - b.currentStock)
    });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/sales?from=&to=
router.get("/sales", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id };
    if (df) filter.createdAt = df;

    const sales = await Sale.find(filter)
      .populate("customer", "name phone")
      .sort({ createdAt: -1 });

    const totalSales    = sales.reduce((s, x) => s + (x.grandTotal || 0), 0);
    const totalReceived = sales.reduce((s, x) => s + (x.amountReceived || 0), 0);
    const totalDue      = totalSales - totalReceived;

    res.json({ sales, totalSales, totalReceived, totalDue });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/purchases?from=&to=
router.get("/purchases", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id };
    if (df) filter.date = df;

    const purchases = await Purchase.find(filter)
      .populate("supplier", "name companyName")
      .sort({ date: -1 });

    const totalPurchases = purchases.reduce((s, x) => s + (x.grandTotal || 0), 0);
    const totalPaid      = purchases.reduce((s, x) => s + (x.amountPaid || 0), 0);
    const totalDue       = totalPurchases - totalPaid;

    res.json({ purchases, totalPurchases, totalPaid, totalDue });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/stock-adjustments?from=&to=
// All manual stock / min-stock adjustments across products (audit report)
router.get("/stock-adjustments", auth, async (req, res) => {
  try {
    const StockLog = require("../models/StockLog");
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id };
    if (df) filter.date = df;

    const logs = await StockLog.find(filter)
      .populate("product", "productName model brand barcode")
      .sort({ date: -1 });

    const totalIncrease = logs.reduce((s, l) => s + (l.change > 0 ? l.change : 0), 0);
    const totalDecrease = logs.reduce((s, l) => s + (l.change < 0 ? Math.abs(l.change) : 0), 0);

    res.json({ logs, totalIncrease, totalDecrease, count: logs.length });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/product-sales?from=&to=
// Product-wise sale report: har product kitna bika, revenue, cost, profit/loss.
router.get("/product-sales", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id };
    if (df) filter.createdAt = df;

    const sales = await Sale.find(filter).populate("items.product", "productName model brand type");

    const map = {};
    sales.forEach(sale => {
      (sale.items || []).forEach(item => {
        const pid = item.product?._id?.toString() || "unknown";
        if (!map[pid]) {
          map[pid] = {
            productName: item.product?.productName || "Deleted Product",
            model: item.product?.model || "",
            brand: item.product?.brand || "",
            type: item.product?.type || "",
            qtySold: 0, revenue: 0, cost: 0, profit: 0
          };
        }
        const line = item.lineTotal || 0;
        const cost = (item.purchasePriceAtTime || 0) * (item.quantity || 0);
        map[pid].qtySold += item.quantity || 0;
        map[pid].revenue += line;
        map[pid].cost    += cost;
        map[pid].profit  += (line - cost);
      });
    });

    const products = Object.values(map).map(p => ({
      ...p,
      avgSalePrice: p.qtySold > 0 ? Math.round(p.revenue / p.qtySold) : 0,
      margin: p.revenue > 0 ? Number(((p.profit / p.revenue) * 100).toFixed(1)) : 0
    })).sort((a, b) => b.qtySold - a.qtySold);

    const totalQty     = products.reduce((s, p) => s + p.qtySold, 0);
    const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
    const totalCost    = products.reduce((s, p) => s + p.cost, 0);
    const totalProfit  = products.reduce((s, p) => s + p.profit, 0);

    res.json({ products, totalQty, totalRevenue, totalCost, totalProfit });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/stock-valuation
// Current inventory ki value: cost par, sale par, aur potential profit.
router.get("/stock-valuation", auth, async (req, res) => {
  try {
    const products = await Product.find({ user: req.user.id }).sort({ productName: 1 });

    const rows = products.map(p => {
      const stock = p.currentStock || 0;
      const cost  = p.unitPrice || 0;
      const sale  = p.salePrice || 0;
      const costValue = stock * cost;
      const saleValue = stock * sale;
      return {
        _id: p._id,
        productName: p.productName,
        model: p.model,
        brand: p.brand,
        type: p.type,
        currentStock: stock,
        unitPrice: cost,
        salePrice: sale,
        costValue,
        saleValue,
        potentialProfit: saleValue - costValue
      };
    });

    const totalCostValue = rows.reduce((s, r) => s + r.costValue, 0);
    const totalSaleValue = rows.reduce((s, r) => s + r.saleValue, 0);
    const totalUnits     = rows.reduce((s, r) => s + r.currentStock, 0);

    res.json({
      rows,
      totalCostValue,
      totalSaleValue,
      totalPotentialProfit: totalSaleValue - totalCostValue,
      totalUnits,
      productCount: rows.length
    });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/walking-sales?from=&to=
// Sirf walking / cash customer ki sales (jinme koi registered customer link nahi).
router.get("/walking-sales", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id, customer: null };
    if (df) filter.createdAt = df;

    const sales = await Sale.find(filter).sort({ createdAt: -1 });

    const totalSales    = sales.reduce((s, x) => s + (x.grandTotal || 0), 0);
    const totalReceived = sales.reduce((s, x) => s + (x.amountReceived || 0), 0);
    const totalDue      = totalSales - totalReceived;

    res.json({ sales, totalSales, totalReceived, totalDue, count: sales.length });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/profit-loss?from=&to=
// Asli Profit & Loss: Revenue vs Cost of Goods SOLD (COGS).
// Total purchases nahi, sirf bik-e-hue maal ki cost count hoti hai.
router.get("/profit-loss", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id };
    if (df) filter.createdAt = df;

    const sales = await Sale.find(filter).populate("items.product", "productName model brand");

    let totalSales = 0;      // grandTotal (discount/delivery ke baad)
    let itemsValue = 0;      // items ki sale value (line totals ka sum)
    let totalCOGS = 0;       // bik-e-hue maal ki khareed cost
    let totalDiscount = 0;
    let totalDelivery = 0;
    let itemsSold = 0;

    const productMap = {};   // per-product breakdown

    sales.forEach(sale => {
      totalSales    += sale.grandTotal || 0;
      totalDiscount += sale.discount || 0;
      totalDelivery += sale.deliveryCharges || 0;

      (sale.items || []).forEach(item => {
        const line = item.lineTotal || 0;
        const cost = (item.purchasePriceAtTime || 0) * (item.quantity || 0);
        itemsValue += line;
        totalCOGS  += cost;
        itemsSold  += item.quantity || 0;

        const pid = item.product?._id?.toString() || "unknown";
        if (!productMap[pid]) {
          productMap[pid] = {
            productName: item.product?.productName || "Deleted Product",
            model: item.product?.model || "",
            qtySold: 0, revenue: 0, cost: 0, profit: 0
          };
        }
        productMap[pid].qtySold += item.quantity || 0;
        productMap[pid].revenue += line;
        productMap[pid].cost    += cost;
        productMap[pid].profit  += (line - cost);
      });
    });

    const grossProfit = itemsValue - totalCOGS;              // maal par munafa (discount se pehle)
    const netProfit   = totalSales - totalCOGS;              // discount minus + delivery plus ke baad
    const margin      = totalSales > 0 ? (netProfit / totalSales) * 100 : 0;

    const products = Object.values(productMap).sort((a, b) => b.profit - a.profit);

    res.json({
      totalSales, itemsValue, totalCOGS, totalDiscount, totalDelivery,
      grossProfit, netProfit,
      margin: Number(margin.toFixed(2)),
      invoiceCount: sales.length,
      itemsSold,
      products
    });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/low-stock
router.get("/low-stock", auth, async (req, res) => {
  try {
    const products = await Product.find({ user: req.user.id });
    const low = products.filter(p => (p.currentStock || 0) <= (p.minStock || 5));
    res.json(low.sort((a, b) => (a.currentStock || 0) - (b.currentStock || 0)));
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// EXPIRY REPORT
// The report a medical store lives by: what has already expired, and what
// is close enough to expiry that it should go back to the distributor.
// Query: ?months=6  (how far ahead to look — default 6)
// ==========================================
router.get("/expiry", auth, async (req, res) => {
  try {
    const months = Math.max(1, Number(req.query.months) || 6);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const limit = new Date(today);
    limit.setMonth(limit.getMonth() + months);

    // One row per BATCH, not per medicine — the same medicine can hold two
    // batches expiring months apart, and only the batch quantity is at risk
    const StockBatch = require("../models/StockBatch");
    const liveBatches = await StockBatch.find({
      user: req.user.id,
      quantity: { $gt: 0 },
      expiryDate: { $ne: null, $lte: limit }
    }).populate("product", "productName genericName brand category strength shelfNo type packLabel unitLabel")
      .sort({ expiryDate: 1 });

    const day = 1000 * 60 * 60 * 24;
    const rows = liveBatches
      .filter(b => b.product)
      .map(b => {
        const p = b.product;
        const daysLeft = Math.ceil((new Date(b.expiryDate).getTime() - today.getTime()) / day);
        const unit = p.type === "pack" ? (p.packLabel || "Box") : (p.unitLabel || "Piece");
        return {
          _id: b._id,
          productId: p._id,
          productName: p.productName,
          genericName: p.genericName,
          brand: p.brand,
          category: p.category,
          strength: p.strength,
          batchNo: b.batchNo || "—",
          shelfNo: p.shelfNo,
          expiryDate: b.expiryDate,
          daysLeft,
          status: daysLeft < 0 ? "Expired" : (daysLeft <= 90 ? "Critical" : "Watch"),
          currentStock: b.quantity,
          unit,
          unitPrice: b.purchaseRate || 0,
          // What this batch cost — the money at risk if it is not returned in time
          valueAtRisk: b.quantity * (b.purchaseRate || 0)
        };
      });

    const sum = (list) => list.reduce((s, r) => s + r.valueAtRisk, 0);
    const expired = rows.filter(r => r.status === "Expired");
    const critical = rows.filter(r => r.status === "Critical");
    const watch = rows.filter(r => r.status === "Watch");

    res.json({
      months,
      rows,
      summary: {
        expiredCount: expired.length,
        expiredValue: sum(expired),
        criticalCount: critical.length,   // within 90 days
        criticalValue: sum(critical),
        watchCount: watch.length,
        watchValue: sum(watch),
        totalCount: rows.length,
        totalValue: sum(rows)
      }
    });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

module.exports = router;
