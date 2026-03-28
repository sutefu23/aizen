import { next } from "@vercel/edge";

export default function middleware(request: Request) {
  const authHeader = request.headers.get("authorization");

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = atob(encoded);
      const [user, pass] = decoded.split(":");

      const validUser = process.env.BASIC_AUTH_USER || "admin";
      const validPass = process.env.BASIC_AUTH_PASSWORD || "password";

      if (user === validUser && pass === validPass) {
        return next();
      }
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Secure Area"',
    },
  });
}
