import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { reportNetworkFailure, reportServerAnswered } from "./connectivity.ts";

// The engine's own line to the server: no offline answers, no login
// redirects, just the request. Everything else in the app goes through
// api-client, which the engine sits behind.
const raw = axios.create({ baseURL: "/api", withCredentials: true });

export class ServerError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.data = data;
  }
}

export function isNoAnswer(error: unknown): boolean {
  return !(error instanceof ServerError);
}

// POSTs and returns the inner `data` of the server envelope. Throws
// ServerError when the server answered with an error, anything else when it
// did not answer at all.
export async function rawPost<T = unknown>(
  path: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  try {
    const response = await raw.post(path, body ?? {}, config);
    reportServerAnswered();
    const envelope = response.data;
    return (envelope && typeof envelope === "object" && "data" in envelope
      ? envelope.data
      : envelope) as T;
  } catch (error) {
    const axiosError = error as AxiosError<any>;
    if (axiosError?.response) {
      const status = axiosError.response.status;
      if ([502, 503, 504].includes(status)) {
        reportNetworkFailure();
        throw error;
      }
      reportServerAnswered();
      const message =
        axiosError.response.data?.message ?? axiosError.message ?? "Request failed";
      throw new ServerError(status, String(message), axiosError.response.data);
    }
    reportNetworkFailure();
    throw error;
  }
}

export async function rawGet<T = unknown>(path: string): Promise<T> {
  try {
    const response = await raw.get(path);
    reportServerAnswered();
    const envelope = response.data;
    return (envelope && typeof envelope === "object" && "data" in envelope
      ? envelope.data
      : envelope) as T;
  } catch (error) {
    const axiosError = error as AxiosError<any>;
    if (axiosError?.response) {
      reportServerAnswered();
      throw new ServerError(
        axiosError.response.status,
        String(axiosError.response.data?.message ?? axiosError.message),
        axiosError.response.data,
      );
    }
    reportNetworkFailure();
    throw error;
  }
}
