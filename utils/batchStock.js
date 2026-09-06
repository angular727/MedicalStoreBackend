const StockBatch = require("../models/StockBatch");
const Product = require("../models/Product");

// ============================================================================
// Batch-wise stock
//
// Every movement of stock goes through this file, so the batch rows and
// Product.currentStock can never drift apart. Quantities are always in the
// product's own sale unit (Box for a pack medicine, Piece for a single one).
//
// Stock leaves on the FEFO rule — First Expiry, First Out — which is what a
// medical store actually does: sell the batch that dies first.
// ============================================================================

// Rounding guard. Loose selling produces fractions (7 of 14 = 0.5 Box) and
// repeated adds/subtracts drift, so every stored quantity is rounded here.
const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * Recomputes the product's total from its batches, and points the product's
 * batch/expiry at whichever live batch expires first — that is the one the
 * counter will hand over next, so it is what the medicine card should show.
 */
async function syncProduct(productId, userId, session) {
  const batches = await StockBatch.find({ product: productId, user: userId })
    .sort({ expiryDate: 1 })
    .session(session);

  const live = batches.filter(b => b.quantity > 0);
  const total = round(live.reduce((s, b) => s + b.quantity, 0));

  // Expired batches still sit on the shelf but can never be sold, so the
  // sellable figure is what the counter should be shown
  const cutoff = new Date(new Date().setHours(0, 0, 0, 0));
  const sellable = live.filter(b => !(b.expiryDate && new Date(b.expiryDate) < cutoff));
  const sellableTotal = round(sellable.reduce((s, b) => s + b.quantity, 0));

  const product = await Product.findOne({ _id: productId, user: userId }).session(session);
  if (!product) return null;

  product.currentStock = total;
  product.sellableStock = sellableTotal;

  // Nearest expiry among the stock that can still be sold; if everything is
  // expired, fall back to what is there so the card still says something
  const pool = sellable.length ? sellable : live;
  const next = pool.find(b => b.expiryDate) || pool[0];
  if (next) {
    product.batchNo = next.batchNo || "";
    product.expiryDate = next.expiryDate || null;
    if (next.purchaseRate) product.unitPrice = next.purchaseRate;
  }

  await product.save({ session });
  return product;
}

/**
 * Stock coming in from a purchase. The same batch number arriving twice tops
 * up the existing row rather than creating a duplicate.
 */
async function addStock({ productId, userId, batchNo, expiryDate, quantity, purchaseRate, salePrice, purchaseId }, session) {
  const qty = round(quantity);
  if (qty <= 0) return null;

  const key = {
    product: productId,
    user: userId,
    batchNo: batchNo || "",
    expiryDate: expiryDate || null
  };

  let batch = await StockBatch.findOne(key).session(session);
  if (batch) {
    batch.quantity = round(batch.quantity + qty);
    if (purchaseRate) batch.purchaseRate = purchaseRate;
    if (salePrice) batch.salePrice = salePrice;
    if (purchaseId) batch.purchase = purchaseId;
    await batch.save({ session });
  } else {
    batch = new StockBatch({
      ...key,
      quantity: qty,
      purchaseRate: purchaseRate || 0,
      salePrice: salePrice || 0,
      purchase: purchaseId || null
    });
    await batch.save({ session });
  }

  await syncProduct(productId, userId, session);
  return batch;
}

/**
 * Stock going out on a sale, nearest expiry first.
 *
 * Returns the allocation — which batch gave how much — so the sale can store
 * it and later put the exact same quantities back on an edit, return or void.
 * Throws if there is not enough, naming the medicine.
 */
async function consumeFEFO({ productId, userId, quantity, productName, today }, session) {
  const need = round(quantity);
  if (need <= 0) return [];

  const all = await StockBatch.find({ product: productId, user: userId, quantity: { $gt: 0 } })
    .sort({ expiryDate: 1, createdAt: 1 })
    .session(session);

  // Expired batches are not sellable — they still sit in stock until they are
  // returned to the distributor, but they can never go over the counter.
  const cutoff = today || new Date(new Date().setHours(0, 0, 0, 0));
  const expired = all.filter(b => b.expiryDate && new Date(b.expiryDate) < cutoff);
  const batches = all.filter(b => !(b.expiryDate && new Date(b.expiryDate) < cutoff));

  const available = round(batches.reduce((s, b) => s + b.quantity, 0));
  if (available < need) {
    const expiredQty = round(expired.reduce((s, b) => s + b.quantity, 0));
    const extra = expiredQty > 0
      ? ` (${expiredQty} more is expired and cannot be sold)`
      : "";
    throw new Error(`Not enough stock of "${productName || "this medicine"}". Sellable: ${available}${extra}.`);
  }

  const allocations = [];
  let left = need;

  for (const batch of batches) {
    if (left <= 0) break;
    const take = round(Math.min(batch.quantity, left));
    if (take <= 0) continue;

    batch.quantity = round(batch.quantity - take);
    await batch.save({ session });

    allocations.push({
      batch: batch._id,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
      quantity: take
    });
    left = round(left - take);
  }

  await syncProduct(productId, userId, session);
  return allocations;
}

/**
 * Puts an allocation back exactly where it came from — used when a sale is
 * edited, returned or voided. If the batch row has since been deleted the
 * quantity is re-created so stock is never silently lost.
 */
async function restoreAllocations({ productId, userId, allocations }, session) {
  for (const a of allocations || []) {
    const qty = round(a.quantity);
    if (qty <= 0) continue;

    let batch = a.batch
      ? await StockBatch.findOne({ _id: a.batch, user: userId }).session(session)
      : null;

    if (batch) {
      batch.quantity = round(batch.quantity + qty);
      await batch.save({ session });
    } else {
      await new StockBatch({
        product: productId,
        user: userId,
        batchNo: a.batchNo || "",
        expiryDate: a.expiryDate || null,
        quantity: qty
      }).save({ session });
    }
  }
  await syncProduct(productId, userId, session);
}

/**
 * Stock leaving without a sale — goods going back to the distributor, or a
 * purchase being edited/voided. Takes from the named batch first, then from
 * whatever else is on hand.
 */
async function removeStock({ productId, userId, quantity, batchNo, expiryDate, productName }, session) {
  const need = round(quantity);
  if (need <= 0) return;

  const all = await StockBatch.find({ product: productId, user: userId, quantity: { $gt: 0 } })
    .sort({ expiryDate: 1, createdAt: 1 })
    .session(session);

  const available = round(all.reduce((s, b) => s + b.quantity, 0));
  if (available < need) {
    throw new Error(`Not enough stock of "${productName || "this medicine"}" to take out. In stock: ${available}, needed: ${need}.`);
  }

  // The batch this movement names goes first
  const matches = (b) =>
    b.batchNo === (batchNo || "") &&
    String(b.expiryDate || "") === String(expiryDate || "");
  const ordered = [...all.filter(matches), ...all.filter(b => !matches(b))];

  let left = need;
  for (const batch of ordered) {
    if (left <= 0) break;
    const take = round(Math.min(batch.quantity, left));
    if (take <= 0) continue;
    batch.quantity = round(batch.quantity - take);
    await batch.save({ session });
    left = round(left - take);
  }

  await syncProduct(productId, userId, session);
}

/** Live batches of one medicine, the one expiring first at the top. */
async function listBatches(productId, userId, session) {
  return StockBatch.find({ product: productId, user: userId, quantity: { $gt: 0 } })
    .sort({ expiryDate: 1, createdAt: 1 })
    .session(session || null);
}

/**
 * Builds batch rows for a medicine that has stock but no batch history — the
 * opening stock entered when the medicine was first created. Without this its
 * quantity would be invisible to every batch-aware screen.
 */
async function ensureOpeningBatch(product, session) {
  const count = await StockBatch.countDocuments({ product: product._id, user: product.user }).session(session);
  if (count > 0) return;
  if (!(product.currentStock > 0)) return;

  await new StockBatch({
    product: product._id,
    user: product.user,
    batchNo: product.batchNo || "OPENING",
    expiryDate: product.expiryDate || null,
    quantity: round(product.currentStock),
    purchaseRate: product.unitPrice || 0,
    salePrice: product.salePrice || 0
  }).save({ session });
}

module.exports = {
  round,
  syncProduct,
  addStock,
  consumeFEFO,
  restoreAllocations,
  removeStock,
  listBatches,
  ensureOpeningBatch
};
