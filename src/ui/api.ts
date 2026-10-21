export const API = '/knowledge-library/api';
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Knowledge-Library': '1', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || `请求失败：${response.status}`, response.status);
  return data as T;
}
export const post = <T,>(path: string, value: unknown, method = 'POST', signal?: AbortSignal) => api<T>(path, { method, body: JSON.stringify(value), signal });
