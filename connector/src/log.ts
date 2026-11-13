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

export const log = {
  info: (...args: unknown[]) => console.log(`[${stamp()}] ${fmt(args)}`),
  warn: (...args: unknown[]) => console.warn(`[${stamp()}] WARN ${fmt(args)}`),
  error: (...args: unknown[]) => console.error(`[${stamp()}] ERROR ${fmt(args)}`),
  /** Print without timestamp (banners, QR codes). Still redacted unless `raw`. */
  plain: (text: string, raw = false) => console.log(raw ? text : redact(text)),
};
