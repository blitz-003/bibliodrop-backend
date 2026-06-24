// models/Delivery.js
const mongoose = require("mongoose");

const DeliverySchema = new mongoose.Schema({
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    required: true,
  },
  stripeSessionId: { type: String, required: true },
  bookId: { type: mongoose.Schema.Types.ObjectId, ref: "Book", required: true },
  bookTitle: { type: String, required: true },
  userId: { type: String, required: true }, // Client ID
  userName: { type: String, required: true }, // For Librarian view convenience
  deliveryFee: { type: Number, required: true },
  status: {
    type: String,
    enum: ["pending", "dispatched", "delivered"],
    default: "pending",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Delivery", DeliverySchema);
