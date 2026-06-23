const AUTH_BASE_URL = process.env.AUTH_SERVER_URL;

async function getSession(headers) {
  const response = await fetch(`${AUTH_BASE_URL}/get-session`, {
    headers: {
      cookie: headers.cookie || "",
    },
  });

  if (!response.ok) return null;

  return response.json();
}

module.exports = { getSession };
