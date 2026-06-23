const { getSession } = require("../services/auth.service");

async function requireAuth(req, res, next) {
  try {
    const session = await getSession(req.headers);
    console.log(session);

    if (!session?.user) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    req.user = session.user;
    console.log("after");
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireAuth;
