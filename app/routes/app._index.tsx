import { type LoaderFunctionArgs, json, redirect } from "@remix-run/cloudflare";

// The base /app route redirects to the subscriptions index — that's
// the dashboard surface mandated by the brief.
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const passthroughs = new URLSearchParams();
  for (const k of ["shop", "host"]) {
    const v = url.searchParams.get(k);
    if (v) passthroughs.set(k, v);
  }
  const qs = passthroughs.toString();
  return redirect(`/app/subscriptions${qs ? "?" + qs : ""}`);
}

// Loader-only route — never renders. Default export satisfies Remix.
export default function AppIndex() {
  return null;
}

export { json };
