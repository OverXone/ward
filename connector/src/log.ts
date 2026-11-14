/**
 * Console logger that scrubs secrets.
 *
 * Every secret (phone keys, QR tickets, LCU password) is registered with `addSecret`
 * and replaced by "<redacted>" in anything we print. Link parts of the form
 * `?t=...` and `#p=...` are scrubbed as a second line of defence.
 */

const secrets = new Set<string>();

export function addSecret(value: string): void {
  if (value.length >= 6) secrets.add(value);
}

export function removeSecret(value: string): void {
  secrets.delete(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("<redacted>");
  return out.replace(/([?&]t=|[#&]p=)[^&\s"']+/g, "$1<redacted>");
}

function stamp(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function fmt(args: unknown[]): string {
  return redact(
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" "),
  );
}

export type LogKind = "info" | "warn" | "error" | "plain";

/**
 * Where output goes instead of the console. Ward in the background (tray) has no console:
 * it sends every line to the open Ward windows.
 */
let sink: ((text: string, kind: LogKind) => void) | null = null;

export function setLogSink(fn: ((text: string, kind: LogKind) => void) | null): void {
  sink = fn;
}

function emit(text: string, kind: LogKind): void {
  if (sink) sink(text, kind);
  else if (kind === "warn") console.warn(text);
  else if (kind === "error") console.error(text);
  else console.log(text);
}

export const log = {
  info: (...args: unknown[]) => emit(`[${stamp()}] ${fmt(args)}`, "info"),
  warn: (...args: unknown[]) => emit(`[${stamp()}] WARN ${fmt(args)}`, "warn"),
  error: (...args: unknown[]) => emit(`[${stamp()}] ERROR ${fmt(args)}`, "error"),
  /** Print without timestamp (banners, QR codes). Still redacted unless `raw`. */
  plain: (text: string, raw = false) => emit(raw ? text : redact(text), "plain"),
};
