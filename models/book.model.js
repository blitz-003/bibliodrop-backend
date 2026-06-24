const mongoose = require("mongoose");

const { Schema, model } = mongoose;

const bookSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    author: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    category: {
      type: String,
      required: true,
      trim: true,
    },

    coverImage: {
      type: String,
      default: "",
    },

    deliveryFee: {
      type: Number,
      required: true,
      min: 0,
    },

    // Inventory
    totalStock: {
      type: Number,
      required: true,
      min: 1,
    },

    availableStock: {
      type: Number,
      required: true,
      min: 0,
    },

    // Moderation status
    publishStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    // Delivery Status (Changed from availabilityStatus to match your post data)
    deliveryStatus: {
      type: String,
      enum: ["available", "in_stock"],
      default: "available",
    },

    // Owner (librarian who added the book)
    ownerId: {
      type: String,
      required: true,
    },

    ownerName: {
      type: String,
      required: true,
    },

    ownerEmail: {
      type: String,
      required: true,
      lowercase: true,
    },

    // Ratings
    totalReviews: {
      type: Number,
      default: 0,
      min: 0,
    },

    averageRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },

    // Statistics
    borrowCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    // This automatically creates and updates 'createdAt' and 'updatedAt' fields
    timestamps: true,
  },
);

const Book = model("Book", bookSchema);

module.exports = Book;
