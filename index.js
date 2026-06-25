require("dotenv").config();

const requireAuth = require("./middleware/requireAuth.js");
const requireRole = require("./middleware/requireRole.js");

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Transaction = require("./models/Transaction");

const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  }),
);

// B. STRIPE WEBHOOK ENDPOINT (Must sit BEFORE express.json())
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error(`Webhook Signature Verification Failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle successful checkouts
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { bookId, userId } = session.metadata;

      try {
        // 1. Log payment into the transactions log
        const newTransaction = await Transaction.create({
          stripeSessionId: session.id,
          bookId,
          userId,
          amountPaid: session.amount_total / 100,
          currency: session.currency,
          status: "completed",
        });

        // Fetch the book title and user details from DB or session context
        const bookDetails = await Book.findById(bookId);

        // 2. Create the Delivery document automatically starting as "pending"
        await Delivery.create({
          transactionId: newTransaction._id,
          stripeSessionId: session.id,
          bookId,
          bookTitle: bookDetails ? bookDetails.title : "Unknown Book",
          userId: userId,
          userName: session.customer_details?.name || "Client", // Extracted from Stripe billing checkout
          deliveryFee: session.amount_total / 100,
          status: "pending",
        });

        // 3. Decrement stock
        await Book.findByIdAndUpdate(bookId, {
          $inc: { availableStock: -1 },
        });

        console.log(
          `Fulfillment and delivery document instantiated for Book: ${bookId}`,
        );
      } catch (dbErr) {
        console.error("Database update error during webhook process:", dbErr);
        return res.status(500).send("Internal Database Update Error");
      }
    }

    res.status(200).json({ received: true });
  },
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const Delivery = require("./models/Delivery");

// A. USER: Get delivery history logs
app.get("/deliveries/history", requireAuth, async (req, res) => {
  try {
    const userDeliveries = await Delivery.find({ userId: req.user.id }).sort({
      createdAt: -1,
    });
    res.json(userDeliveries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B. LIBRARIAN: Fetch ONLY deliveries related to books owned by this librarian
app.get(
  "/deliveries/manage",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const librarianId = req.user.id;

      // 1. Find all books created/owned by this librarian
      const myBooks = await Book.find({ ownerId: librarianId }).select("_id");

      // Extract just the array of IDs: [ObjectId('...'), ObjectId('...')]
      const myBookIds = myBooks.map((book) => book._id);

      // 2. Only find deliveries matching those book IDs
      const queue = await Delivery.find({
        bookId: { $in: myBookIds },
      }).sort({ createdAt: -1 });

      res.json(queue);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// C. LIBRARIAN: Update Fulfillment State Machine (With strict ownership check)
app.patch(
  "/deliveries/:id/status",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const { status } = req.body;
      const librarianId = req.user.id;

      if (!["dispatched", "delivered"].includes(status)) {
        return res
          .status(400)
          .json({ message: "Invalid workflow state sequence." });
      }

      // 1. Find the target delivery first
      const deliveryItem = await Delivery.findById(req.params.id);
      if (!deliveryItem) {
        return res.status(404).json({ message: "Delivery record not found." });
      }

      // 2. Look up the book to check who owns it
      const parentBook = await Book.findById(deliveryItem.bookId);
      if (!parentBook || parentBook.ownerId !== librarianId) {
        return res.status(403).json({
          message:
            "Access Denied: You do not own the book associated with this delivery pipeline.",
        });
      }

      // 3. Proceed with update since authorization passed
      deliveryItem.status = status;
      deliveryItem.updatedAt = new Date();
      const updatedDelivery = await deliveryItem.save();

      res.json(updatedDelivery);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);
// A. USER: Get delivery history logs
app.get("/deliveries/history", requireAuth, async (req, res) => {
  try {
    const userDeliveries = await Delivery.find({ userId: req.user.id }).sort({
      createdAt: -1,
    });
    res.json(userDeliveries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B. LIBRARIAN: Fetch all deliveries across system queue lines
app.get(
  "/deliveries/manage",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const queue = await Delivery.find().sort({ createdAt: -1 });
      res.json(queue);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// C. LIBRARIAN: Update Fulfillment State Machine (Pending -> Dispatched -> Delivered)
app.patch(
  "/deliveries/:id/status",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const { status } = req.body;
      if (!["dispatched", "delivered"].includes(status)) {
        return res
          .status(400)
          .json({ message: "Invalid workflow state sequence." });
      }

      const updatedDelivery = await Delivery.findByIdAndUpdate(
        req.params.id,
        { status, updatedAt: new Date() },
        { new: true },
      );

      res.json(updatedDelivery);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const { bookId, title, deliveryFee, coverImage } = req.body;
    const userId = req.user.id;

    // 1. Force convert string/float inputs into a clean, rounded integer cent value
    const amountInCents = Math.round(parseFloat(deliveryFee) * 100);

    // 2. Safety Check: If it somehow still fails to parse, default to a minimum or throw an error
    if (isNaN(amountInCents) || amountInCents <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid delivery fee amount value." });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Delivery Fee: ${title}`,
              // Ensure we pass an absolute fallback image string if coverImage is null
              images: [
                coverImage ||
                  "https://images.unsplash.com/photo-1543002588-bfa74002ed7e?q=80&w=400",
              ],
            },
            unit_amount: amountInCents, // This MUST be a clean integer
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        bookId,
        userId,
      },
      success_url: `${process.env.FRONTEND_URL}/dashboard/payment/success`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/payment/cancel`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Checkout generation crashed:", err);
    res.status(500).json({ error: err.message });
  }
});
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "biblio_drop/books",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      },
    );

    streamifier.createReadStream(buffer).pipe(stream);
  });
}

const Book = require("./models/book.model");

app.get("/", (req, res) => {
  res.send("BiblioDrop Backend Running");
});

app.get("/books", async (req, res) => {
  try {
    const { search, category, available } = req.query;

    let query = {};

    //  Search by title (case-insensitive)
    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    // Category filter
    if (category) {
      query.category = category;
    }

    // Availability filter (convert string → boolean)
    if (available !== undefined) {
      query.available = available === "true";
    }

    query.publishStatus = "approved";

    const books = await Book.find(query);

    res.json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Fetch Book Details Wrapper Payload
const { getSession } = require("./services/auth.service");

// GET: Fetch Book Details Wrapper Payload
app.get("/books/:id", async (req, res) => {
  try {
    const bookId = req.params.id;

    // Try to get session, but don't block guests
    const session = await getSession(req.headers);

    const user = session?.user || null;
    const userId = user?.id || null;

    // 1. Fetch the book profile document
    const book = await Book.findById(bookId);

    if (!book) {
      return res.status(404).json({
        message: "Catalog item context missing.",
      });
    }

    // Default values for guests
    let transaction = null;
    let deliveryRecord = null;

    // 2. Run user-specific checks only if logged in
    if (userId) {
      transaction = await Transaction.findOne({
        bookId,
        userId,
        status: "completed",
      });

      deliveryRecord = await Delivery.findOne({
        bookId,
        userId,
      });
    }

    // 3. Return wrapper payload
    res.status(200).json({
      book,

      // Frontend uses this
      isAuthenticated: !!userId,

      isLibrarianOwner: !!userId && String(book.ownerId) === String(userId),

      hasRequestedDelivery: !!transaction,

      canReview: !!deliveryRecord && deliveryRecord.status === "delivered",
    });
  } catch (err) {
    console.error("Error evaluating book detail flags:", err);

    res.status(500).json({
      error: err.message,
    });
  }
});

app.post("/books/:id/reviews", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { comment, rating } = req.body;
    const userId = req.user.id;
    const userName = req.user.name || "Anonymous Reader"; // If you track names

    // 1. Guardrail validation check
    const deliveryRecord = await Delivery.findOne({ bookId: id, userId });
    if (!deliveryRecord || deliveryRecord.status !== "delivered") {
      return res.status(403).json({
        message:
          "Action Blocked: Reviews are unlocked only after delivery confirmation.",
      });
    }

    const book = await Book.findById(id);
    if (!book) {
      return res.status(404).json({ message: "Book not found." });
    }

    // 2. Append review payload to arrays
    book.reviews.push({
      userId,
      userName,
      comment,
      rating,
      createdAt: new Date(),
    });

    await book.save();

    // 3. THE FIX: Explicitly send back a successful status and payload
    return res.status(200).json({
      success: true,
      message: "Review logged successfully.",
    });
  } catch (err) {
    console.error("Review saving error:", err);
    // Crucial: Catch blocks must also return a response so they don't hang!
    return res.status(500).json({ message: err.message });
  }
});

// DELETE: REMOVE USER ACCOUNT
app.delete(
  "/admin/users/:id",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const targetUserId = req.params.id;

      if (targetUserId === req.user.id) {
        return res.status(400).json({
          message:
            "Self-destruction blocked. You cannot delete your own admin account.",
        });
      }

      // 1. Find the user first to check their role before deleting them
      const userToDelete = await User.findById(targetUserId);
      if (!userToDelete) {
        return res.status(404).json({ message: "User not found." });
      }

      // 2. If they are a librarian, hide their books from the store instantly
      if (userToDelete.role === "librarian") {
        await Book.updateMany(
          { ownerId: targetUserId },
          { publishStatus: "rejected" }, // Instantly removes them from storefront matching
        );
      }

      // 3. Delete the actual user account
      await User.findByIdAndDelete(targetUserId);

      res.json({
        message:
          "Account deleted and associated store items deactivated successfully.",
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.delete("/books/:id", async (req, res) => {
  try {
    const deleted = await Book.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: "Book not found" });
    }

    res.json({ message: "Book deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(
  "/adminApproval",
  requireAuth,
  requireRole("admin"), // Ensures only admins can see this list
  async (req, res) => {
    try {
      console.log("backend here");
      // Find all books where publishStatus matches "pending"
      const pendingBooks = await Book.find({ publishStatus: "pending" }).sort({
        createdAt: 1,
      }); // Oldest pending items first

      // Return the array of books
      res.status(200).json(pendingBooks);
    } catch (err) {
      console.error("Error fetching approval books:", err);
      res.status(500).json({
        error: "Failed to fetch pending books",
        details: err.message,
      });
    }
  },
);

app.patch(
  "/books/:bookId/status", // Matches your frontend URL parameter exactly
  requireAuth,
  requireRole("admin"), // Protects this route so only admins can execute approvals
  async (req, res) => {
    try {
      const { bookId } = req.params;
      const { publishStatus } = req.body;

      // 1. Validation Check
      if (!["approved", "rejected"].includes(publishStatus)) {
        return res.status(400).json({
          message: "Invalid status value. Must be 'approved' or 'rejected'.",
        });
      }

      // 2. Database Update
      // Swapping findByIdAndUpdate's target property to match 'publishStatus'
      const updatedBook = await Book.findByIdAndUpdate(
        bookId,
        {
          publishStatus: publishStatus,
          updatedAt: new Date(),
        },
        { new: true }, // Returns the newly updated book document
      );

      // 3. Fallback check if ID is invalid or missing
      if (!updatedBook) {
        return res.status(404).json({ message: "Target book not found" });
      }

      // 4. Return the updated document back to your frontend TanStack mutation
      res.status(200).json(updatedBook);
    } catch (err) {
      console.error("Error updating book publication status:", err);
      res.status(500).json({
        error: "Internal server error while updating status",
        details: err.message,
      });
    }
  },
);

app.post(
  "/books",
  requireAuth,
  requireRole("librarian"), // IMPORTANT (must run before route)
  upload.single("coverImage"),
  async (req, res) => {
    try {
      // 1. file check
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          message: "Cover image is required",
        });
      }

      // 2. upload to cloudinary
      const uploadResult = await uploadToCloudinary(file.buffer);

      // 3. get authenticated user (from middleware)
      const user = req.user;

      if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const bookData = {
        title: req.body.title,
        author: req.body.author,
        description: req.body.description,
        category: req.body.category,

        coverImage: uploadResult.secure_url,

        deliveryFee: Number(req.body.deliveryFee),

        totalStock: Number(req.body.stock),
        availableStock: Number(req.body.stock),

        publishStatus: "pending",
        deliveryStatus: "available",

        ownerId: user.id,
        ownerName: user.name,
        ownerEmail: user.email,

        totalReviews: 0,
        averageRating: 0,

        createdAt: new Date(),
        updatedAt: new Date(),
      };

      console.log("okay upto here");

      const savedBook = await Book.create(bookData);

      res.status(201).json(savedBook);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

app.get(
  "/dashboard/inventory",
  requireAuth,
  requireRole("librarian"),
  async (req, res) => {
    try {
      const user = req.user;

      // FIX: Query using ownerId and user.id to match your schema setup
      const books = await Book.find({
        ownerId: user.id,
      }).sort({ createdAt: -1 });

      return res.status(200).json(books);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  },
);

// ADMIN: Fetch all transactions with compiled Book, User, Librarian, and Delivery Status details
// ADMIN: Fetch all transactions
app.get(
  "/admin/transactions",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const transactions = await Transaction.find()
        .populate("bookId")
        .sort({ createdAt: -1 });

      const compiledTransactions = await Promise.all(
        transactions.map(async (tx) => {
          const delivery = await Delivery.findOne({ transactionId: tx._id });

          return {
            _id: tx._id,
            stripeSessionId: tx.stripeSessionId,
            amountPaid: tx.amountPaid,
            createdAt: tx.createdAt,
            userId: tx.userId || "Deleted Account",
            // SAFELY HANDLE NULL CHECKS HERE:
            bookName: tx.bookId ? tx.bookId.title : "Deleted Book",
            librarianName:
              tx.bookId && tx.bookId.ownerName
                ? tx.bookId.ownerName
                : "Staff (Account Deleted)",
            deliveryStatus: delivery ? delivery.status : "pending",
          };
        }),
      );

      res.json(compiledTransactions);
    } catch (err) {
      res
        .status(500)
        .json({ error: "Failed to compile transaction ledger streams." });
    }
  },
);

const User =
  mongoose.models.User ||
  mongoose.model("User", new mongoose.Schema({}, { strict: false }), "user");

// 2. Add the GET users endpoint
app.get("/admin/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    // Fetch all accounts from the collection, newest first
    const users = await User.find().sort({ createdAt: -1 });

    // Send them back to your Next.js client page
    res.status(200).json(users);
  } catch (err) {
    console.error("Failed to retrieve user accounts:", err);
    res
      .status(500)
      .json({ error: "Internal Database Error reading users collection" });
  }
});

// PATCH: UPDATE USER ROLE (Admin Only)
app.patch(
  "/admin/users/:id/role",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { role } = req.body;
      const targetUserId = req.params.id;

      // 1. Validation Guard: Check if the role is allowed
      if (!["user", "librarian", "admin"].includes(role)) {
        return res
          .status(400)
          .json({ message: "Invalid role assignment target." });
      }

      // 2. Prevent an Admin from accidentally demoting themselves
      if (targetUserId === req.user.id) {
        return res.status(400).json({
          message: "Access Denied: You cannot change your own admin role.",
        });
      }

      // 3. Find user and update their role inside the singular "user" collection
      const updatedUser = await User.findByIdAndUpdate(
        targetUserId,
        { role },
        { new: true }, // Returns the newly modified user document
      );

      if (!updatedUser) {
        return res.status(404).json({ message: "User account not found." });
      }

      // Send back the updated user so the frontend toast notification can read it
      res.status(200).json(updatedUser);
    } catch (err) {
      console.error("Failed to alter user role:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

app.get("/debug-db", async (req, res) => {
  try {
    // 1. Get a list of all actual collections in your MongoDB database
    const collections = await mongoose.connection.db
      .listCollections()
      .toArray();
    const names = collections.map((c) => c.name);

    // 2. Try a raw database find bypass
    const rawUsers = await mongoose.connection.db
      .collection("users")
      .find({})
      .toArray()
      .catch(() => []);
    const rawUserSingular = await mongoose.connection.db
      .collection("user")
      .find({})
      .toArray()
      .catch(() => []);

    res.json({
      activeCollectionsInYourDB: names,
      documentsFoundInPluralUsers: rawUsers.length,
      documentsFoundInSingularUser: rawUserSingular.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH: ADMIN TOGGLE BOOK PUBLISH STATUS (Admin Only)
app.patch(
  "/admin/books/:id/status",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { publishStatus } = req.body;
      const { id } = req.params;

      // 1. Validation Check (matching your schema's existing states)
      if (!["approved", "rejected"].includes(publishStatus)) {
        return res.status(400).json({
          message:
            "Invalid status value. Use 'approved' to publish or 'rejected' to unpublish.",
        });
      }

      // 2. Database Update
      const updatedBook = await Book.findByIdAndUpdate(
        id,
        { publishStatus, updatedAt: new Date() },
        { new: true }, // Returns the newly modified book document
      );

      if (!updatedBook) {
        return res
          .status(404)
          .json({ message: "Target book document not found." });
      }

      res.status(200).json(updatedBook);
    } catch (err) {
      console.error("Error toggling book publication state:", err);
      res.status(500).json({
        error: "Internal server error while updating publication settings.",
      });
    }
  },
);

// GET: ALL SYSTEM BOOKS FOR ADMIN
app.get("/admin/books", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const books = await Book.find().sort({ createdAt: -1 });
    res.status(200).json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Fetch user's personal delivered reading list (Client Only)
app.get("/dashboard/reading-list", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Fetch only completed deliveries belonging to this user
    const completedDeliveries = await Delivery.find({
      userId: userId,
      status: "delivered",
    })
      .populate("bookId") // Populates the related Book document
      .sort({ updatedAt: -1 }); // Newest delivered items first

    // 2. Extract and format the book details cleanly
    const readingList = completedDeliveries
      .filter((delivery) => delivery.bookId) // Guard against any deleted books
      .map((delivery) => {
        const book = delivery.bookId;
        return {
          deliveryId: delivery._id,
          deliveredAt: delivery.updatedAt,
          _id: book._id,
          title: book.title,
          author: book.author,
          category: book.category || "General",
          description: book.description || "No description provided.",
          coverImage:
            book.coverImage ||
            "https://images.unsplash.com/photo-1543002588-bfa74002ed7e?q=80&w=400",
        };
      });

    res.status(200).json(readingList);
  } catch (err) {
    console.error("Error generating reading list streams:", err);
    res
      .status(500)
      .json({ error: "Internal server error fetching reading list." });
  }
});

// PATCH: Toggle Publication Visibility (Librarian Owner Domain)
app.patch("/books/:id/toggle-publish", requireAuth, async (req, res) => {
  try {
    const bookId = req.params.id;
    const user = req.user; // Populated by your requireAuth middleware

    // 1. Fetch the book to verify ownership
    const book = await Book.findById(bookId);
    if (!book)
      return res.status(404).json({ message: "Book volume not found." });

    // 2. Authorization Guard: Ensure this librarian actually owns this asset
    if (String(book.ownerId) !== String(user.id)) {
      return res.status(403).json({
        message: "Permission Denied: You do not own this catalog item.",
      });
    }

    // 3. Toggle the status dynamically based on what your schema uses:
    // If using 'publishStatus' string ("approved" vs "rejected")
    book.publishStatus =
      book.publishStatus === "approved" ? "rejected" : "approved";

    // OR if your schema uses a boolean 'isPublished', uncomment this instead:
    // book.isPublished = !book.isPublished;

    await book.save();
    res.status(200).json(book);
  } catch (err) {
    console.error("Librarian Toggle Publish Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT: Update Existing Catalog Item Properties (Strict Librarian Validation Guard)
app.put("/books/:id", requireAuth, async (req, res) => {
  try {
    const bookId = req.params.id;
    const user = req.user; // Extract identity context via token injection check

    const book = await Book.findById(bookId);
    if (!book)
      return res.status(404).json({ message: "Book entity context missing." });

    // Authorization Barrier Check: Verify document execution level authority
    if (String(book.ownerId) !== String(user.id)) {
      return res.status(403).json({
        message: "Forbidden: You are not authorized to edit this book.",
      });
    }

    // Apply the clean payload mappings safely
    const { title, author, description, category, deliveryFee } = req.body;

    book.title = title ?? book.title;
    book.author = author ?? book.author;
    book.description = description ?? book.description;
    book.category = category ?? book.category;
    book.deliveryFee = deliveryFee ?? book.deliveryFee;

    await book.save();
    res.status(200).json(book);
  } catch (err) {
    console.error("Backend PUT Error mapping details compilation:", err);
    res.status(500).json({ error: err.message });
  }
});

// 1. GET ALL REVIEWS COMPRESSED BY THE ACTIVE USER
app.get("/reviews/me", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Search books collection for sub-document nested matches authored by this user
    // We populate the parent book details context to display its title & author info on the dashboard
    const booksWithMyReviews = await Book.find({
      "reviews.userId": userId,
    }).select("title author reviews");

    // Flatten and transform the nested sub-documents out for easy frontend looping
    let myReviews = [];
    booksWithMyReviews.forEach((book) => {
      book.reviews.forEach((rev) => {
        if (String(rev.userId) === String(userId)) {
          myReviews.push({
            _id: rev._id,
            comment: rev.comment,
            rating: rev.rating,
            bookId: { _id: book._id, title: book.title, author: book.author },
          });
        }
      });
    });

    return res.status(200).json(myReviews);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// 2. PUT: EDIT/UPDATE TARGET REVIEW SPECIFICS
app.put("/reviews/:id", requireAuth, async (req, res) => {
  try {
    const reviewId = req.params.id;
    const { comment, rating } = req.body;
    const userId = req.user.id;

    // Find the master book entry containing the targeted sub-document review identifier
    const book = await Book.findOne({ "reviews._id": reviewId });
    if (!book)
      return res
        .status(404)
        .json({ message: "Review matching index missing." });

    // Locate the explicit sub-document reference in the Mongoose array
    const review = book.reviews.id(reviewId);

    // Authorization security guardrail check
    if (String(review.userId) !== String(userId)) {
      return res
        .status(403)
        .json({ message: "Unauthorized operation constraint." });
    }

    // Apply the fresh updates
    review.comment = comment;
    review.rating = rating;
    await book.save();

    return res
      .status(200)
      .json({ success: true, message: "Review updated successfully." });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// 3. DELETE: ERASE REVIEW SUB-DOCUMENT ENTRIES
app.delete("/reviews/:id", requireAuth, async (req, res) => {
  try {
    const reviewId = req.params.id;
    const userId = req.user.id;

    const book = await Book.findOne({ "reviews._id": reviewId });
    if (!book)
      return res.status(404).json({ message: "Review index not found." });

    const review = book.reviews.id(reviewId);
    if (String(review.userId) !== String(userId)) {
      return res.status(403).json({ message: "Access tracking violation." });
    }

    // Pull/remove sub-document cleanly using Mongoose's built-in subdoc remover helper
    review.deleteOne();
    await book.save();

    return res
      .status(200)
      .json({ success: true, message: "Review wiped cleanly." });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ────────────────────────────────────────────────────────
// USER OVERVIEW METRICS ENDPOINT
// ────────────────────────────────────────────────────────

app.get("/dashboard/user", requireAuth, async (req, res) => {
  try {
    const rawUserId = req.user.id;

    // 1. Calculate Real Total Spent (Handles String/Number and ObjectId/String mismatches)
    const totalSpentData = await Transaction.aggregate([
      {
        $match: {
          $and: [
            { status: { $regex: /^completed$/i } },
            {
              $or: [
                { userId: rawUserId }, // Matches if stored as a raw String
                { userId: new mongoose.Types.ObjectId(rawUserId) }, // Matches if stored as an ObjectId
              ],
            },
          ],
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              // Enforces conversion to double/number if it was stored as a string "20"
              $toDouble: { $ifNull: ["$amountPaid", 0] },
            },
          },
        },
      },
    ]);
    const totalSpent = totalSpentData.length > 0 ? totalSpentData[0].total : 0;

    // 2. Count Real Books and Live Deliveries
    const totalBooksRead = await Transaction.countDocuments({
      userId: rawUserId,
      status: { $regex: /^completed$/i },
    });

    const pendingDeliveries = await Delivery.countDocuments({
      userId: rawUserId,
      status: { $regex: /^(?!delivered$).*$/i },
    });

    const activeBorrowing = await Delivery.countDocuments({
      userId: rawUserId,
      status: { $regex: /^delivered$/i },
    });

    // 3. Robust Monthly Spending Chart Aggregator
    const monthlySpending = await Transaction.aggregate([
      {
        $match: {
          $and: [
            { status: { $regex: /^completed$/i } },
            {
              $or: [
                { userId: rawUserId },
                { userId: new mongoose.Types.ObjectId(rawUserId) },
              ],
            },
          ],
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%b", date: "$createdAt" } },
          amount: { $sum: { $toDouble: "$amountPaid" } },
        },
      },
      {
        $project: {
          month: { $ifNull: ["$_id", "Unknown"] },
          amount: 1,
          _id: 0,
        },
      },
      { $sort: { month: 1 } },
    ]);

    // 4. Robust Category Distribution Pie Chart Aggregator
    const categoryDistribution = await Transaction.aggregate([
      {
        $match: {
          $and: [
            { status: { $regex: /^completed$/i } },
            {
              $or: [
                { userId: rawUserId },
                { userId: new mongoose.Types.ObjectId(rawUserId) },
              ],
            },
          ],
        },
      },
      {
        $lookup: {
          from: "books",
          localField: "bookId",
          foreignField: "_id",
          as: "bookDetails",
        },
      },
      { $unwind: { path: "$bookDetails", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ["$bookDetails.category", "Uncategorized"] },
          count: { $sum: 1 },
        },
      },
      { $project: { name: "$_id", count: 1, _id: 0 } },
    ]);

    return res.status(200).json({
      stats: {
        totalSpent,
        totalBooksRead,
        pendingDeliveries,
        activeBorrowing,
      },
      charts: {
        monthlySpending,
        categoryDistribution,
      },
    });
  } catch (err) {
    console.error("User Dashboard Crash Recovery:", err);
    return res.status(500).json({ error: err.message });
  }
});
// ────────────────────────────────────────────────────────
// LIBRARIAN OVERVIEW METRICS ENDPOINT
// ────────────────────────────────────────────────────────
app.get("/dashboard/librarian", requireAuth, async (req, res) => {
  try {
    const rawLibrarianId = req.user.id;

    // 1. Calculate Total Sales Revenue safely
    const revenueData = await Transaction.aggregate([
      {
        $match: {
          status: { $regex: /^completed$/i },
        },
      },
      {
        $lookup: {
          from: "books",
          localField: "bookId",
          foreignField: "_id",
          as: "bookDetails",
        },
      },
      { $unwind: "$bookDetails" },
      {
        // Filter transactions for books that belong to this librarian owner
        $match: {
          $or: [
            { "bookDetails.ownerId": rawLibrarianId },
            {
              "bookDetails.ownerId": new mongoose.Types.ObjectId(
                rawLibrarianId,
              ),
            },
          ],
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } },
        },
      },
    ]);
    const totalSales = revenueData.length > 0 ? revenueData[0].total : 0;

    // 2. Counts for Inventory & States
    const totalBooks = await Book.countDocuments({
      $or: [
        { ownerId: rawLibrarianId },
        { ownerId: new mongoose.Types.ObjectId(rawLibrarianId) },
      ],
    });

    const pendingRequests = await Delivery.countDocuments({
      status: { $regex: /^pending$/i },
    });
    const activeDeliveries = await Delivery.countDocuments({
      status: { $regex: /^shipped$/i },
    });

    // 3. Circulation History (Bar Chart Feed)
    const circulationData = await Delivery.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: "%b", date: "$createdAt" } },
          requests: { $sum: 1 },
        },
      },
      {
        $project: {
          day: { $ifNull: ["$_id", "Unknown"] },
          requests: 1,
          _id: 0,
        },
      },
      { $sort: { day: 1 } },
    ]);

    // 4. Stock Growth Analysis (Area Chart Feed)
    const stockGrowth = await Book.aggregate([
      {
        $match: {
          $or: [
            { ownerId: rawLibrarianId },
            { ownerId: new mongoose.Types.ObjectId(rawLibrarianId) },
          ],
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%b", date: "$createdAt" } },
          added: { $sum: 1 },
        },
      },
      {
        $project: { week: { $ifNull: ["$_id", "Unknown"] }, added: 1, _id: 0 },
      },
      { $sort: { week: 1 } },
    ]);

    return res.status(200).json({
      stats: { totalSales, totalBooks, pendingRequests, activeDeliveries },
      charts: { circulationData, stockGrowth },
    });
  } catch (err) {
    console.error("Librarian Dashboard Aggregation Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────
// GLOBAL SYSTEM ADMIN METRICS ENDPOINT
// ────────────────────────────────────────────────────────
app.get("/dashboard/admin", requireAuth, async (req, res) => {
  try {
    // 1. Calculate Gross Platform GMV (All processed transaction payments)
    const gmvData = await Transaction.aggregate([
      { $match: { status: { $regex: /^completed$/i } } },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } },
        },
      },
    ]);
    const platformGmv = gmvData.length > 0 ? gmvData[0].total : 0;

    // 2. Global Core Counts
    const totalUsers = await User.countDocuments();
    const totalBooks = await Book.countDocuments();
    // Assuming you flag unapproved books or listings with an approval Status:
    const pendingApprovals = await Book.countDocuments({ isApproved: false });

    // 3. User Registration Volume Shifts (Line Chart Feed)
    const userTrends = await User.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: "%b", date: "$createdAt" } },
          newUsers: { $sum: 1 },
        },
      },
      {
        $project: {
          month: { $ifNull: ["$_id", "Unknown"] },
          newUsers: 1,
          _id: 0,
        },
      },
      { $sort: { month: 1 } },
    ]);

    // 4. Site-wide Financial Velocity Flow (Bar Chart Feed)
    const revenueVelocity = await Transaction.aggregate([
      { $match: { status: { $regex: /^completed$/i } } },
      {
        $group: {
          _id: { $dateToString: { format: "%b", date: "$createdAt" } },
          grossAmount: { $sum: { $toDouble: "$amountPaid" } },
        },
      },
      {
        $project: {
          month: { $ifNull: ["$_id", "Unknown"] },
          grossAmount: 1,
          _id: 0,
        },
      },
      { $sort: { month: 1 } },
    ]);

    return res.status(200).json({
      stats: { totalUsers, totalBooks, pendingApprovals, platformGmv },
      charts: { userRegistrationTrends: userTrends, revenueVelocity },
    });
  } catch (err) {
    console.error("Admin Dashboard Global Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/books", async (req, res) => {
  try {
    const { search, category, available } = req.query;

    // 1. DYNAMIC SEARCH & FILTER MONGOOSE QUERY OBJECT
    let query = {};

    if (search) {
      query.title = { $regex: search, $options: "i" }; // Case-insensitive title lookup
    }

    if (category) {
      query.category = category;
    }

    if (available !== undefined) {
      query.available = available === "true";
    }

    // 2. PARSE CONFIGURABLE PAGINATION LIMIT VARIABLES FROM REQUEST
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 9; // Configurable items-per-page constant
    const skip = (page - 1) * limit;

    // 3. EXECUTE PARALLEL DATABASE CONTEXT STREAMS (Performance Optimized)
    const [books, totalCount, allCategories] = await Promise.all([
      // Stream A: Fetch current slice page of items matching filters
      Book.find(query).skip(skip).limit(limit).sort({ createdAt: -1 }),

      // Stream B: Fetch global document count matching the selected filters
      Book.countDocuments(query),

      // Stream C: GLOBAL SOLUTION — Aggregate all categories in the database unaffected by limits
      Book.distinct("category"),
    ]);

    // 4. RESPOND WITH COMPREHENSIVE CONTROL PAYLOAD OVER THE WIRE
    res.status(200).json({
      books,
      totalCount,
      allCategories: allCategories.filter(Boolean), // Wipe out null/empty strings
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Ecosystem failed to process book query payload." });
  }
});
async function main() {
  try {
    await mongoose.connect(process.env.DB_URL);

    console.log("MongoDB Connected");

    app.listen(process.env.PORT, () => {
      console.log(`Server running on port ${process.env.PORT}`);
    });
  } catch (err) {
    console.log(err);
  }
}

main();
