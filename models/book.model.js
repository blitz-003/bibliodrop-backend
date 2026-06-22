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
    },

    description: {
      type: String,
      default: "",
    },

    category: {
      type: String,
      required: true,
    },

    coverImage: {
      type: String,
      default: "",
    },

    deliveryFee: {
      type: Number,
      required: true,
    },

    availabilityStatus: {
      type: String,
      enum: ["available", "checked_out"],
      default: "available",
    },

    publishStatus: {
      type: String,
      enum: ["pending_approval", "published", "unpublished"],
      default: "pending_approval",
    },
  },
  {
    timestamps: true,
  },
);

const Book = model("Book", bookSchema);

module.exports = Book;
