import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Use relative URLs (empty string) in production, local dev server in development
// This works because on Vercel both frontend and API are served from the same origin
const API_BASE = "";

async function throwIfResNotOk(res: Response) {
  // 304 Not Modified has no body, handle gracefully
  if (res.status === 304) {
    return;
  }
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const options: RequestInit = {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
  };

  if (data && method !== "GET") {
    options.body = JSON.stringify(data);
  }

  // Add cache-busting for GET requests to prevent 304
  if (method === "GET" && url.includes("?")) {
    url += `&_t=${Date.now()}`;
  } else if (method === "GET") {
    url += `?_t=${Date.now()}`;
  }

  const res = await fetch(`${API_BASE}${url}`, options);

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
